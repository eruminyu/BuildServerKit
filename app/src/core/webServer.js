const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  detectNetworkIPs,
  getPackageArchiveSummary,
  applyPackageRetention,
  getBuildHistory,
  readBuildLogFile,
} = require('./systemService');

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
          });
          this.stateHub.appendLog(
            `🌐 [Tailscale 원격 웹 대시보드 가동] ${url} (${cfg.RemoteWebDashboardReadOnly ? '읽기 전용' : '원격 빌드 허용'})`,
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

    // Remote trigger endpoints (blocked in Read-Only mode!)
    if (pathname.startsWith('/api/') && req.method === 'POST') {
      if (cfg.RemoteWebDashboardReadOnly) {
        return sendJson(res, 403, { error: '원격 웹 대시보드가 읽기 전용 모드입니다. 전용 PC 앱에서 제어하세요.' });
      }
      const body = await readBodyJson(req);
      try {
        if (pathname === '/api/build/start') {
          this.buildService.startBuild(body.mode || 'QuickVerify', body).catch((e) => {
            this.stateHub.appendLog(`[원격 빌드 오류] ${e.message}`, 'error');
          });
          return sendJson(res, 200, { ok: true, started: true });
        }
        if (pathname === '/api/build/stop') {
          return sendJson(res, 200, this.buildService.stopBuild());
        }
        if (pathname === '/api/p4/mirror-now') {
          const r = await this.p4Service.runMirrorOnce();
          return sendJson(res, 200, r);
        }
        if (pathname === '/api/packages/prune') {
          const r = applyPackageRetention(cfg);
          this.stateHub.broadcast('packages:updated', getPackageArchiveSummary(cfg));
          return sendJson(res, 200, r);
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
