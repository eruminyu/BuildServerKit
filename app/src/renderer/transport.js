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

  async function remoteFetch(url, options = {}) {
    const resp = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const data = await resp.json().catch(() => ({}));
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
      case 'p4:mirrorRun':
        return await remoteFetch('/api/p4/mirror-now', { method: 'POST', body: '{}' });
      case 'system:network':
        return await remoteFetch('/api/network');
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
