/**
 * Dual-mode transport adapter:
 * - Inside Electron: uses window.bsk (preload IPC bridge)
 * - In Remote Browser (Tailscale Web Dashboard): uses HTTP REST + Server-Sent Events (SSE)
 */
(function () {
  const isElectron = Boolean(window.bsk && window.bsk.isElectron);
  const listeners = new Map();

  function emitLocal(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch {}
    }
  }

  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event).delete(cb);
  }

  if (isElectron) {
    window.bsk.events.onStateUpdate((p) => emitLocal('state:update', p));
    window.bsk.events.onConsoleLine((p) => emitLocal('console:line', p));
    window.bsk.events.onConsoleError((p) => emitLocal('console:error', p));
    window.bsk.events.onConsoleClear((p) => emitLocal('console:clear', p));
    window.bsk.events.onPackagesUpdated((p) => emitLocal('packages:updated', p));
  } else {
    // Connect SSE stream in browser mode
    const connectSse = () => {
      const es = new EventSource('/api/events');
      es.addEventListener('snapshot', (e) => emitLocal('snapshot', JSON.parse(e.data)));
      es.addEventListener('state:update', (e) => emitLocal('state:update', JSON.parse(e.data)));
      es.addEventListener('console:line', (e) => emitLocal('console:line', JSON.parse(e.data)));
      es.addEventListener('console:error', (e) => emitLocal('console:error', JSON.parse(e.data)));
      es.addEventListener('console:clear', (e) => emitLocal('console:clear', JSON.parse(e.data)));
      es.addEventListener('packages:updated', (e) => emitLocal('packages:updated', JSON.parse(e.data)));
      es.onerror = () => {
        es.close();
        setTimeout(connectSse, 3000);
      };
    };
    connectSse();
  }

  const REMOTE_PIN_KEY = 'bsk_remote_pin';

  async function remoteFetch(url, options = {}, retriedPin = false) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (method === 'POST') {
      const savedPin = sessionStorage.getItem(REMOTE_PIN_KEY) || '';
      if (savedPin) headers['X-BSK-Pin'] = savedPin;
    }

    const resp = await fetch(url, { ...options, headers });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 401 && data.pinRequired && method === 'POST' && !retriedPin) {
      const promptMsg = sessionStorage.getItem(REMOTE_PIN_KEY)
        ? '원격 빌드 실행 PIN이 일치하지 않습니다. PIN을 다시 입력하세요:'
        : '원격 빌드 실행 PIN을 입력하세요:';
      const entered = window.prompt(promptMsg);
      if (entered === null || !entered.trim()) {
        throw new Error('원격 실행 PIN 입력이 취소되었습니다.');
      }
      sessionStorage.setItem(REMOTE_PIN_KEY, entered.trim());
      return await remoteFetch(url, options, true);
    }
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  async function invoke(channel, payload) {
    if (isElectron) {
      return await window.bsk.invoke(channel, payload);
    }

    // Remote browser REST mapping
    switch (channel) {
      case 'state:snapshot':
        return await remoteFetch('/api/snapshot');
      case 'config:get':
        return await remoteFetch('/api/config');
      case 'packages:list':
        return await remoteFetch('/api/packages');
      case 'packages:pruneNow':
        return await remoteFetch('/api/packages/prune', { method: 'POST', body: '{}' });
      case 'history:list':
        return await remoteFetch('/api/history');
      case 'history:readLog':
        return await remoteFetch(`/api/log?file=${encodeURIComponent(payload || '')}`);
      case 'p4:mirrorStatus':
        return await remoteFetch('/api/p4/status');
      case 'p4:recentCLs':
        return await remoteFetch('/api/p4/recent-cls');
      case 'p4:logs:read': {
        const p = payload || {};
        const qs = new URLSearchParams({
          source: p.source || 'p4log',
          filter: p.filter || 'all',
          query: p.query || '',
          tailLines: String(p.tailLines || 300),
        });
        return await remoteFetch(`/api/p4/server-log?${qs.toString()}`);
      }
      case 'p4:mirrorRun':
        return await remoteFetch('/api/p4/mirror-now', { method: 'POST', body: '{}' });
      case 'system:network':
        return await remoteFetch('/api/network');
      case 'build:sync':
        return await remoteFetch('/api/build/sync', { method: 'POST', body: JSON.stringify(payload || {}) });
      case 'build:start':
        return await remoteFetch('/api/build/start', { method: 'POST', body: JSON.stringify(payload || {}) });
      case 'build:stop':
        return await remoteFetch('/api/build/stop', { method: 'POST', body: '{}' });
      default:
        throw new Error('이 기능은 전용 빌드 PC의 데스크톱 앱에서만 사용할 수 있습니다.');
    }
  }

  window.transport = {
    isElectron,
    invoke,
    on,
    window: isElectron ? window.bsk.window : null,
  };
})();
