const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  detectNetworkIPs,
  getPackageArchiveSummary,
  getBuildHistory,
  readBuildLogFile,
} = require('./systemService');

function extractClientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  return raw.replace(/^::ffff:/, '') || 'unknown';
}

function timingSafePinEquals(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function readBodyJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

class RemoteWebServer {
  constructor({ rendererDir, configStore, stateHub, buildService, p4Service, p4LogService = null }) {
    this.rendererDir = rendererDir;
    this.configStore = configStore;
    this.stateHub = stateHub;
    this.buildService = buildService;
    this.p4Service = p4Service;
    this.p4LogService = p4LogService;
    this.server = null;
    this.port = 3780;
  }

  start() {
    return new Promise((resolve) => {
      const cfg = this.configStore.get();
      if (!cfg.RemoteWebDashboardEnabled) {
        this.stop().then(() => resolve({ running: false, url: '' }));
        return;
      }
      if (this.server && this.port === cfg.RemoteWebDashboardPort) {
        const net = detectNetworkIPs();
        const hostIp = cfg.TailscaleIP || net.recommended;
        const url = `http://${hostIp}:${this.port}`;
        this.stateHub.updateSection('webServer', {
          running: true,
          port: this.port,
          url,
          readOnly: Boolean(cfg.RemoteWebDashboardReadOnly),
          pinRequired: Boolean(cfg.RemoteWebDashboardPin),
        });
        resolve({ running: true, url, port: this.port });
        return;
      }

      this.stop().then(() => {
        this.port = Number(cfg.RemoteWebDashboardPort) || 3780;
        const server = http.createServer((req, res) => this._handle(req, res));
        server.on('error', (err) => {
          this.stateHub.appendLog(`[원격 웹 대시보드 오류] 포트 ${this.port} 시작 실패: ${err.message}`, 'error');
          this.stateHub.updateSection('webServer', { running: false, port: this.port, url: '' });
          resolve({ running: false, error: err.message });
        });
        server.listen(this.port, '0.0.0.0', () => {
          this.server = server;
          const net = detectNetworkIPs();
          const hostIp = cfg.TailscaleIP || net.recommended;
          const url = `http://${hostIp}:${this.port}`;
          this.stateHub.updateSection('webServer', {
            running: true,
            port: this.port,
            url,
            readOnly: Boolean(cfg.RemoteWebDashboardReadOnly),
            pinRequired: Boolean(cfg.RemoteWebDashboardPin),
          });
          this.stateHub.appendLog(
            `🌐 [Tailscale 원격 웹 대시보드 가동] ${url} (${cfg.RemoteWebDashboardReadOnly ? '읽기 전용' : cfg.RemoteWebDashboardPin ? '원격 빌드 허용 · PIN 보호' : '원격 빌드 허용'})`,
            'cyan'
          );
          resolve({ running: true, url, port: this.port });
        });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) {
        this.stateHub.updateSection('webServer', { running: false, url: '' });
        resolve();
        return;
      }
      const s = this.server;
      this.server = null;
      s.close(() => {
        this.stateHub.updateSection('webServer', { running: false, url: '' });
        resolve();
      });
    });
  }

  async _handle(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;
    const cfg = this.configStore.get();

    // SSE live event stream
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(this.stateHub.getSnapshot())}\n\n`);
      this.stateHub.attachSseClient(res);
      return;
    }

    // Read-only API endpoints
    if (pathname === '/api/snapshot' && req.method === 'GET') {
      return sendJson(res, 200, {
        ...this.stateHub.getSnapshot(),
        remoteMode: true,
        readOnly: Boolean(cfg.RemoteWebDashboardReadOnly),
        pinRequired: Boolean(cfg.RemoteWebDashboardPin),
      });
    }
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, this.configStore.getSanitizedForRemote());
    }
    if (pathname === '/api/packages' && req.method === 'GET') {
      return sendJson(res, 200, getPackageArchiveSummary(cfg));
    }
    if (pathname === '/api/history' && req.method === 'GET') {
      return sendJson(res, 200, getBuildHistory(cfg));
    }
    if (pathname === '/api/log' && req.method === 'GET') {
      try {
        const file = parsed.searchParams.get('file') || '';
        return sendJson(res, 200, readBuildLogFile(cfg, file));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (pathname === '/api/p4/status' && req.method === 'GET') {
      return sendJson(res, 200, this.p4Service.getMirrorStatus());
    }
    if (pathname === '/api/p4/recent-cls' && req.method === 'GET') {
      return sendJson(res, 200, await this.p4Service.getRecentCLs(10));
    }
    if (pathname === '/api/p4/server-log' && req.method === 'GET') {
      if (!this.p4LogService) {
        return sendJson(res, 404, { error: 'P4 서버 로그 서비스가 비활성화되어 있습니다.' });
      }
      try {
        const source = parsed.searchParams.get('source') || 'p4log';
        const filter = parsed.searchParams.get('filter') || 'all';
        const query = parsed.searchParams.get('query') || '';
        const tailLines = Number(parsed.searchParams.get('tailLines')) || 300;
        const data = await this.p4LogService.readServerLog({ source, filter, query, tailLines });
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (pathname === '/api/network' && req.method === 'GET') {
      return sendJson(res, 200, detectNetworkIPs());
    }

    // Remote trigger endpoints (blocked in Read-Only mode, optional PIN verified!)
    if (pathname.startsWith('/api/') && req.method === 'POST') {
      if (cfg.RemoteWebDashboardReadOnly) {
        return sendJson(res, 403, { error: '원격 웹 대시보드가 읽기 전용 모드입니다. 전용 PC 앱에서 [읽기 전용 모드]를 끄면 원격 빌드를 실행할 수 있습니다.' });
      }
      const expectedPin = String(cfg.RemoteWebDashboardPin || '').trim();
      if (expectedPin) {
        const providedPin = String(req.headers['x-bsk-pin'] || '').trim();
        if (!providedPin || !timingSafePinEquals(providedPin, expectedPin)) {
          return sendJson(res, 401, {
            error: providedPin ? '원격 실행 PIN이 일치하지 않습니다.' : '원격 실행 PIN 입력이 필요합니다.',
            pinRequired: true,
          });
        }
      }

      const clientIp = extractClientIp(req);
      const body = await readBodyJson(req);
      try {
        if (pathname === '/api/build/sync') {
          this.stateHub.appendLog(`🌐 [원격 요청 ${clientIp}] 소스 최신 동기화 시작`, 'cyan');
          const r = await this.buildService.syncSource(body.branch || '', body.targetCL || '');
          return sendJson(res, 200, r);
        }
        if (pathname === '/api/build/start') {
          const mode = body.mode === 'FullPackage' ? 'FullPackage' : 'QuickVerify';
          this.stateHub.appendLog(`🌐 [원격 요청 ${clientIp}] ${mode} 빌드 실행 요청`, 'cyan');
          this.buildService.startBuild(mode, body).catch((e) => {
            this.stateHub.appendLog(`[원격 빌드 오류] ${e.message}`, 'error');
          });
          return sendJson(res, 200, { ok: true, started: true, mode });
        }
        if (pathname === '/api/build/stop') {
          this.stateHub.appendLog(`🌐 [원격 요청 ${clientIp}] 빌드 중단 요청`, 'warn');
          return sendJson(res, 200, this.buildService.stopBuild());
        }
        if (pathname === '/api/p4/mirror-now') {
          this.stateHub.appendLog(`🌐 [원격 요청 ${clientIp}] P4 → GitHub 미러링 실행 요청`, 'cyan');
          const r = await this.p4Service.runMirrorOnce();
          return sendJson(res, 200, r);
        }
        if (pathname === '/api/packages/prune') {
          return sendJson(res, 403, { error: '오래된 패키지 삭제는 안전을 위해 전용 빌드 PC 데스크톱 앱에서만 실행할 수 있습니다.' });
        }
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      return sendJson(res, 404, { error: '지원하지 않는 원격 API입니다.' });
    }

    // Serve static renderer UI files
    let rel = pathname === '/' ? '/index.html' : pathname;
    const safeRel = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.resolve(path.join(this.rendererDir, safeRel));
    if (!fullPath.startsWith(path.resolve(this.rendererDir)) || !fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
  }
}

module.exports = { RemoteWebServer };
