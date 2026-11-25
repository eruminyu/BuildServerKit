const fs = require('fs');
const path = require('path');
const { execCapture } = require('./processRunner');

const MAX_TAIL_BYTES = 2 * 1024 * 1024; // 2 MB tail read cap for instant UI rendering

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDateFile(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function readTailText(filePath, maxBytes = MAX_TAIL_BYTES) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, text: '', truncated: false, totalBytes: 0, mtime: '' };
  }
  const stat = fs.statSync(filePath);
  const mtime = stat.mtime ? stat.mtime.toISOString() : '';
  if (stat.size <= maxBytes) {
    return {
      exists: true,
      text: fs.readFileSync(filePath, 'utf8'),
      truncated: false,
      totalBytes: stat.size,
      mtime,
    };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    let text = buf.toString('utf8');
    // Drop partial first line when sliced mid-file
    const nlIdx = text.indexOf('\n');
    if (nlIdx >= 0 && nlIdx < 500) {
      text = text.slice(nlIdx + 1);
    }
    return {
      exists: true,
      text,
      truncated: true,
      totalBytes: stat.size,
      mtime,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function classifyP4Entry(blockLines) {
  const raw = blockLines.join('\n').trim();
  const first = (blockLines[0] || '').trim();
  const body = blockLines.slice(1).join('\n').trim();
  const combined = `${first}\n${body}`.trim();

  let timestamp = '';
  let user = '';
  let client = '';
  let ip = '';
  let app = '';
  let command = '';
  let level = 'info';
  let category = 'command';
  let summary = '';

  // Match standard P4D info line:
  //   2026/11/25 10:08:30 pid 19152 500pebbles@Project_MurMur1 100.126.175.11 [P4V/...] 'user-...'
  const infoLine = blockLines.find((l) => /^\s*\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+pid\s+\d+/i.test(l));
  if (infoLine) {
    const m = infoLine.match(
      /^\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+pid\s+\d+\s+([^\s@]+)@(\S+)\s+(\S+)\s+\[([^\]]*)\]\s*'([^']*)'/
    );
    if (m) {
      timestamp = m[1];
      user = m[2];
      client = m[3];
      ip = m[4];
      app = m[5];
      command = m[6];
    } else {
      const m2 = infoLine.match(/^\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.*)$/);
      if (m2) {
        timestamp = m2[1];
        summary = m2[2].trim();
      }
    }
  }

  // Match P4D error block:
  // Perforce server error:
  //   Date 2026/11/24 18:03:43:
  //   Pid 21676
  //   Connection from 100.126.175.11:6139 broken.
  //   TCP receive failed.
  if (/^Perforce server error:/i.test(first)) {
    level = 'error';
    category = 'error';
    const dm = combined.match(/Date\s+(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})/);
    if (dm) timestamp = dm[1];
    const ipm = combined.match(/Connection from\s+([0-9a-fA-F.:]+?)(?::\d+)?\s/i);
    if (ipm) ip = ipm[1];
    const um = combined.match(/Operation:\s+([^\r\n]+)/i);
    if (um) command = um[1].trim();
    const detailLines = blockLines
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !/^Date\s+\d{4}\//i.test(l) && !/^Pid\s+\d+/i.test(l) && !/^Ident:/i.test(l));
    summary = detailLines.join(' | ') || 'Perforce server error';
    if (/Connection from .* broken|TCP receive|TCP send|Partner exited|connect/i.test(combined)) {
      category = 'connect';
    }
  } else {
    // Check auth failure / session / permission markers in trailing lines
    const hasAuthFail =
      /failed authentication check|Password invalid|invalid or unset|session has expired|User .* doesn't exist|Access for user .* has not been enabled|must create a password|security level/i.test(
        combined
      );
    const hasServerError = /Perforce server error|error:|failed|denied|refused|license|exceeded/i.test(body);

    if (hasAuthFail) {
      level = 'auth_fail';
      category = 'auth';
    } else if (/^user-(login|logout|passwd|tickets)/i.test(command)) {
      category = 'auth';
      if (hasServerError) level = 'warn';
    } else if (/^user-(user|group|protect|configure|depot|stream|typemap|triggers|admin)/i.test(command)) {
      category = 'admin';
    } else if (/^user-(info|trust)/i.test(command)) {
      category = 'connect';
    } else if (hasServerError) {
      level = 'warn';
      category = 'error';
    }

    if (!summary) {
      const extraLines = blockLines
        .filter((l) => l !== first && l !== infoLine && l.trim())
        .map((l) => l.trim());
      const baseSummary = command ? `${user}@${ip} — ${command}` : raw.split('\n')[0];
      summary = extraLines.length > 0 ? `${baseSummary}  [${extraLines.join(' | ')}]` : baseSummary;
    }
  }

  return {
    timestamp,
    level, // info | warn | error | auth_fail
    category, // command | auth | admin | connect | error
    user,
    client,
    ip,
    app: app ? app.split('/')[0] : '',
    command,
    summary,
    raw,
  };
}

function parseP4LogBlocks(text) {
  const lines = (text || '').split(/\r?\n/);
  const blocks = [];
  let cur = [];

  const isBlockStart = (line) =>
    /^Perforce server (info|error|warning):/i.test(line) ||
    /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/.test(line);

  for (const line of lines) {
    if (isBlockStart(line)) {
      if (cur.length > 0) blocks.push(cur);
      cur = [line];
    } else if (cur.length > 0) {
      if (line.trim() === '' && cur.length > 1) {
        blocks.push(cur);
        cur = [];
      } else if (line.trim() !== '') {
        cur.push(line);
      }
    }
  }
  if (cur.length > 0) blocks.push(cur);

  return blocks.map(classifyP4Entry);
}

function parseAuditOrGenericLines(text, source) {
  const lines = (text || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.map((line) => {
    let timestamp = '';
    let level = 'info';
    let category = source === 'auth' ? 'auth' : source === 'errors' ? 'error' : 'command';
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]\s*\[([A-Z_]+)\]\s*\[([^\]]+)\]\s*(.*)$/);
    if (m) {
      timestamp = m[1];
      const lv = m[2].toLowerCase();
      level = lv === 'error' ? 'error' : lv === 'warn' ? 'warn' : lv === 'auth_fail' ? 'auth_fail' : 'info';
      category = m[3].toLowerCase();
      return { timestamp, level, category, user: '', client: '', ip: '', app: 'Studio', command: m[3], summary: m[4], raw: line };
    }
    if (/failed|error|expired|invalid|denied|broken/i.test(line)) {
      level = /auth|login|password|expired|ticket/i.test(line) ? 'auth_fail' : 'error';
    } else if (/warn/i.test(line)) {
      level = 'warn';
    }
    const tsMatch = line.match(/(\d{4}[\/-]\d{2}[\/-]\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
    if (tsMatch) timestamp = tsMatch[1];
    return {
      timestamp,
      level,
      category,
      user: '',
      client: '',
      ip: '',
      app: source,
      command: '',
      summary: line,
      raw: line,
    };
  });
}

class P4LogService {
  constructor(configStore, stateHub) {
    this.configStore = configStore;
    this.stateHub = stateHub;
  }

  getAuditDir() {
    const cfg = this.configStore.get();
    return path.join(cfg.ArchiveRoot || 'C:\\BuildArchive', 'P4ServerLogs');
  }

  getTodayAuditFile() {
    return path.join(this.getAuditDir(), `p4_studio_audit_${formatDateFile()}.log`);
  }

  appendAuditLog(category, level, message, meta = null) {
    try {
      const dir = this.getAuditDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = this.getTodayAuditFile();
      const lv = String(level || 'info').toUpperCase();
      const cat = String(category || 'P4').toUpperCase();
      const suffix = meta ? ` | ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : '';
      const line = `[${formatStamp()}] [${lv}] [${cat}] ${String(message || '').replace(/\r?\n/g, ' ')}${suffix}\r\n`;
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      // Never throw from audit logging
    }
  }

  async _readServiceRegistryParams() {
    for (const svc of ['Perforce', 'HelixCore', 'p4d']) {
      const q = await execCapture('reg', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${svc}\\Parameters`], {
        timeoutMs: 4000,
      });
      if (q.code === 0 && q.stdout) {
        const params = { serviceName: svc, P4ROOT: '', P4LOG: '', P4DIAGLOG: '', P4JOURNAL: '', P4PORT: '', P4AUDIT: '' };
        for (const line of q.stdout.split(/\r?\n/)) {
          const m = line.match(/^\s*([A-Za-z0-9_]+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i);
          if (!m) continue;
          const key = m[1].trim().toUpperCase();
          const val = m[2].trim();
          if (key in params) params[key] = val;
        }
        return params;
      }
    }
    return { serviceName: '', P4ROOT: '', P4LOG: '', P4DIAGLOG: '', P4JOURNAL: '', P4PORT: '', P4AUDIT: '' };
  }

  async _resolveBestReadUser(adminUserOverride = '') {
    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';
    const candidates = [];
    const addCand = (u) => {
      const v = String(u || '').trim();
      if (v && !candidates.some((c) => c.toLowerCase() === v.toLowerCase())) candidates.push(v);
    };
    addCand(adminUserOverride);
    addCand(cfg.P4User || 'p4bot');

    for (const u of candidates) {
      const chk = await execCapture('p4', ['-p', port, '-u', u, 'login', '-s'], { timeoutMs: 3500 });
      if (chk.code === 0) {
        return { user: u, valid: true };
      }
    }
    return { user: candidates[0] || '', valid: false };
  }

  async inspectLogConfig(adminUserOverride = '') {
    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';
    const reg = await this._readServiceRegistryParams();

    let infoRoot = '';
    let serverAddress = '';
    let serverVersion = '';
    let serverUptime = '';
    const best = await this._resolveBestReadUser(adminUserOverride);
    const infoArgs = best.user ? ['-p', port, '-u', best.user, '-ztag', 'info'] : ['-p', port, '-ztag', 'info'];
    const infoRes = await execCapture('p4', infoArgs, { timeoutMs: 4500 });
    const serverReachable = infoRes.code === 0;
    if (serverReachable) {
      for (const line of (infoRes.stdout || '').split(/\r?\n/)) {
        const m = line.match(/^\.\.\.\s+([A-Za-z0-9_]+)\s+(.*)$/);
        if (!m) continue;
        const [, k, v] = m;
        if (k === 'serverRoot' && v.trim()) infoRoot = v.trim();
        else if (k === 'serverAddress' && v.trim()) serverAddress = v.trim();
        else if (k === 'serverVersion' && v.trim()) serverVersion = v.trim();
        else if (k === 'serverUptime' && v.trim()) serverUptime = v.trim();
      }
    }

    const serverRoot = (reg.P4ROOT || infoRoot || cfg.P4DepotRoot || 'C:\\Perforce\\Server').replace(/[\\/]+$/, '');
    const resolveUnderRoot = (val, defaultName) => {
      const v = String(val || '').trim();
      if (!v) return defaultName ? path.join(serverRoot, defaultName) : '';
      return path.isAbsolute(v) ? v : path.join(serverRoot, v);
    };

    const p4LogPath = resolveUnderRoot(reg.P4LOG, 'log');
    const p4DiagPath = resolveUnderRoot(reg.P4DIAGLOG, 'p4diag_log.txt');
    const authCsvPath = path.join(serverRoot, 'auth.csv');
    const errorsCsvPath = path.join(serverRoot, 'errors.csv');
    const auditFilePath = this.getTodayAuditFile();

    // Check P4D configurables (requires super admin login)
    let serverLogLevel = '';
    let structuredLogs = [];
    let adminConfigReadable = false;
    const adminCandidate = String(adminUserOverride || '').trim();
    const cfgUsers = [];
    if (adminCandidate) cfgUsers.push(adminCandidate);
    if (best.valid && best.user && best.user !== adminCandidate) cfgUsers.push(best.user);

    for (const u of cfgUsers) {
      const cRes = await execCapture('p4', ['-p', port, '-u', u, 'configure', 'show'], { timeoutMs: 4500 });
      if (cRes.code === 0 && cRes.stdout) {
        adminConfigReadable = true;
        for (const line of cRes.stdout.split(/\r?\n/)) {
          const sm = line.match(/(?:^|\s)server\s*=\s*(\d+)/);
          if (sm) serverLogLevel = sm[1];
          const slm = line.match(/(serverlog\.[A-Za-z0-9_.]+)\s*=\s*([^\s(]+)/);
          if (slm) structuredLogs.push(`${slm[1]}=${slm[2]}`);
        }
        break;
      }
    }

    const statOf = (p) => {
      try {
        if (!p || !fs.existsSync(p)) return { path: p, exists: false, sizeBytes: 0, mtime: '' };
        const st = fs.statSync(p);
        return { path: p, exists: true, sizeBytes: st.size, mtime: st.mtime ? st.mtime.toISOString() : '' };
      } catch {
        return { path: p, exists: false, sizeBytes: 0, mtime: '' };
      }
    };

    const configuredDepotNorm = (cfg.P4DepotRoot || '').replace(/[\\/]+$/, '').toLowerCase();
    const detectedRootNorm = serverRoot.toLowerCase();
    const depotRootMismatch = Boolean(detectedRootNorm && configuredDepotNorm && configuredDepotNorm !== detectedRootNorm);

    return {
      serviceName: reg.serviceName || 'Perforce',
      serverReachable,
      serverAddress: serverAddress || port,
      serverVersion,
      serverUptime,
      serverRoot,
      configuredDepotRoot: cfg.P4DepotRoot || '',
      depotRootMismatch,
      p4LogConfigured: Boolean(reg.P4LOG),
      p4LogSetting: reg.P4LOG || '',
      serverLogLevel: serverLogLevel || '3 (기본)',
      structuredLogs,
      adminConfigReadable,
      auditDir: this.getAuditDir(),
      files: {
        p4log: statOf(p4LogPath),
        auth: statOf(authCsvPath),
        errors: statOf(errorsCsvPath),
        p4diag: statOf(p4DiagPath),
        audit: statOf(auditFilePath),
      },
    };
  }

  async configureServerLogging({ adminUser = '', logLevel = 3, enableStructuredLogs = true, maxMb = 20, retainCount = 5 } = {}) {
    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';
    const admin = String(adminUser || '').trim();
    if (!admin) {
      throw new Error('P4D 로그 설정을 변경하려면 관리자(super) P4 아이디를 입력해 주세요.');
    }

    const loginChk = await execCapture('p4', ['-p', port, '-u', admin, 'login', '-s'], { timeoutMs: 4000 });
    if (loginChk.code !== 0) {
      throw new Error(`관리자 계정('${admin}')의 로그인 세션이 만료되었거나 로그인되어 있지 않습니다. 먼저 관리자로 로그인해 주세요.`);
    }

    const lv = Math.max(0, Math.min(5, Number(logLevel) || 3));
    const maxSize = Math.max(5, Math.min(500, Number(maxMb) || 20));
    const retain = Math.max(1, Math.min(30, Number(retainCount) || 5));
    const base = ['-p', port, '-u', admin];

    const settings = [`server=${lv}`];
    if (enableStructuredLogs) {
      settings.push(
        'serverlog.file.1=errors.csv',
        `serverlog.maxmb.1=${maxSize}`,
        `serverlog.retain.1=${retain}`,
        'serverlog.file.2=auth.csv',
        `serverlog.maxmb.2=${maxSize}`,
        `serverlog.retain.2=${retain}`
      );
    }

    const applied = [];
    for (const kv of settings) {
      const res = await execCapture('p4', [...base, 'configure', 'set', kv], { timeoutMs: 5000 });
      if (res.code !== 0) {
        const msg = (res.stderr || res.stdout || '').trim();
        this.appendAuditLog('LOG_CONFIG', 'error', `configure set ${kv} 실패: ${msg}`);
        throw new Error(`p4 configure set ${kv} 실패: ${msg}`);
      }
      applied.push(kv);
    }

    this.appendAuditLog('LOG_CONFIG', 'info', `P4D 서버 로깅 설정 적용 완료 (${applied.join(', ')})`);
    this.stateHub.appendLog(`✔ [P4D 서버 로그 설정] 적용 완료: ${applied.join(', ')}`, 'success');
    return {
      ok: true,
      applied,
      message: `P4D 서버 로깅 설정 적용 완료! (server=${lv}${enableStructuredLogs ? ` · auth.csv/errors.csv 자동 로테이션 ${maxSize}MB×${retain}` : ''})`,
    };
  }

  async readServerLog({ source = 'p4log', tailLines = 300, filter = 'all', query = '', adminUser = '' } = {}) {
    const config = await this.inspectLogConfig(adminUser);
    const key = ['p4log', 'auth', 'errors', 'p4diag', 'audit'].includes(source) ? source : 'p4log';
    const fileInfo = config.files[key] || { path: '', exists: false, sizeBytes: 0, mtime: '' };

    // Always analyze p4log for live client IP connectivity diagnostics
    const mainTail = readTailText(config.files.p4log.path, MAX_TAIL_BYTES);
    const mainEntries = mainTail.exists ? parseP4LogBlocks(mainTail.text) : [];

    // Aggregate connected IPs & auth/error counts from recent P4D log
    const clientMap = new Map();
    let totalErrors = 0;
    let totalAuthFails = 0;
    for (const e of mainEntries) {
      if (e.level === 'error') totalErrors += 1;
      if (e.level === 'auth_fail') totalAuthFails += 1;
      if (e.ip && e.ip !== 'background') {
        const cur = clientMap.get(e.ip) || {
          ip: e.ip,
          users: new Set(),
          clients: new Set(),
          apps: new Set(),
          lastSeen: '',
          lastCommand: '',
          requestCount: 0,
          authFailCount: 0,
          errorCount: 0,
        };
        if (e.user && e.user !== 'unknown') cur.users.add(e.user);
        if (e.client && e.client !== 'unknown' && !e.client.includes('CLIENT_UNSET')) cur.clients.add(e.client);
        if (e.app) cur.apps.add(e.app);
        if (e.timestamp) cur.lastSeen = e.timestamp;
        if (e.command) cur.lastCommand = e.command;
        cur.requestCount += 1;
        if (e.level === 'auth_fail') cur.authFailCount += 1;
        if (e.level === 'error') cur.errorCount += 1;
        clientMap.set(e.ip, cur);
      }
    }

    const recentClients = Array.from(clientMap.values())
      .map((c) => ({
        ip: c.ip,
        users: Array.from(c.users),
        clients: Array.from(c.clients),
        apps: Array.from(c.apps),
        lastSeen: c.lastSeen,
        lastCommand: c.lastCommand,
        requestCount: c.requestCount,
        authFailCount: c.authFailCount,
        errorCount: c.errorCount,
      }))
      .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));

    // Active monitor snapshot (read-only via valid user)
    let activeConnections = [];
    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';
    const best = await this._resolveBestReadUser(adminUser);
    if (best.valid && best.user) {
      const mon = await execCapture('p4', ['-p', port, '-u', best.user, 'monitor', 'show'], { timeoutMs: 3500 });
      if (mon.code === 0 && mon.stdout) {
        activeConnections = mon.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
      }
    }

    // Parse entries for the requested source
    let entries = [];
    let truncated = false;
    if (key === 'p4log') {
      entries = mainEntries;
      truncated = mainTail.truncated;
    } else if (key === 'audit') {
      // Combine recent audit log files (today + yesterday if needed)
      const dir = this.getAuditDir();
      let combinedText = '';
      if (fs.existsSync(dir)) {
        const auditFiles = fs
          .readdirSync(dir)
          .filter((f) => /^p4_studio_audit_\d{4}-\d{2}-\d{2}\.log$/i.test(f))
          .sort()
          .slice(-3);
        for (const f of auditFiles) {
          const t = readTailText(path.join(dir, f), 512 * 1024);
          if (t.exists) combinedText += t.text + '\n';
        }
      }
      entries = parseAuditOrGenericLines(combinedText, 'audit');
    } else {
      const t = readTailText(fileInfo.path, MAX_TAIL_BYTES);
      truncated = t.truncated;
      entries = t.exists ? parseAuditOrGenericLines(t.text, key) : [];
    }

    // Apply category/level filter
    const f = String(filter || 'all').toLowerCase();
    let filtered = entries;
    if (f === 'error') {
      filtered = entries.filter((e) => e.level === 'error' || e.level === 'auth_fail' || e.level === 'warn');
    } else if (f === 'auth') {
      filtered = entries.filter((e) => e.category === 'auth' || e.level === 'auth_fail');
    } else if (f === 'admin') {
      filtered = entries.filter((e) => e.category === 'admin');
    } else if (f === 'connect') {
      filtered = entries.filter((e) => e.category === 'connect' || e.level === 'error' || /Connection from/i.test(e.raw));
    }

    // Apply search query
    const q = String(query || '').trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((e) => `${e.timestamp} ${e.user} ${e.client} ${e.ip} ${e.command} ${e.summary} ${e.raw}`.toLowerCase().includes(q));
    }

    const limit = Math.max(50, Math.min(2000, Number(tailLines) || 300));
    const sliced = filtered.slice(-limit);

    return {
      ok: true,
      source: key,
      filePath: fileInfo.path,
      exists: fileInfo.exists,
      fileSizeBytes: fileInfo.sizeBytes,
      lastModified: fileInfo.mtime,
      truncated,
      config,
      stats: {
        parsedEntries: mainEntries.length,
        filteredCount: filtered.length,
        shownCount: sliced.length,
        errorCount: totalErrors,
        authFailCount: totalAuthFails,
        uniqueIps: recentClients.length,
      },
      recentClients,
      activeConnections,
      entries: sliced,
    };
  }

  async exportLogSnapshot({ adminUser = '' } = {}) {
    const dir = this.getAuditDir();
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    const snapPath = path.join(dir, `p4_server_snapshot_${stamp}.log`);

    const data = await this.readServerLog({ source: 'p4log', tailLines: 1000, filter: 'all', adminUser });
    const auditData = await this.readServerLog({ source: 'audit', tailLines: 300, filter: 'all', adminUser });

    const lines = [
      '====================================================================',
      `BuildServerKit Studio — Perforce Server Diagnostic Snapshot`,
      `Generated At : ${formatStamp(now)}`,
      `Server Addr  : ${data.config.serverAddress}`,
      `Server Ver   : ${data.config.serverVersion || 'N/A'}`,
      `Uptime       : ${data.config.serverUptime || 'N/A'}`,
      `P4ROOT       : ${data.config.serverRoot}`,
      `P4LOG File   : ${data.config.files.p4log.path} (${data.config.files.p4log.sizeBytes} bytes)`,
      `Summary      : Entries=${data.stats.parsedEntries}, AuthFails=${data.stats.authFailCount}, Errors=${data.stats.errorCount}, UniqueIPs=${data.stats.uniqueIps}`,
      '====================================================================',
      '',
      '[1] Recent Client IPs Reaching P4D Port:',
      ...(data.recentClients.length > 0
        ? data.recentClients.map(
            (c) =>
              `  - ${c.ip} | Users: ${c.users.join(', ') || '(unknown)'} | Apps: ${c.apps.join(', ') || '-'} | LastSeen: ${c.lastSeen} | Reqs: ${c.requestCount} | AuthFails: ${c.authFailCount} | Errors: ${c.errorCount}`
          )
        : ['  (No client IPs found in recent log window)']),
      '',
      '[2] Recent Auth Failures & Server Errors:',
      ...data.entries
        .filter((e) => e.level === 'error' || e.level === 'auth_fail')
        .slice(-100)
        .map((e) => `  [${e.timestamp}] [${e.level.toUpperCase()}] ${e.summary}`),
      '',
      '[3] Studio P4 Audit Log (Recent):',
      ...auditData.entries.slice(-150).map((e) => `  ${e.raw}`),
      '',
      '[4] Raw P4D Server Log Tail (Last 500 Entries):',
      ...data.entries.slice(-500).map((e) => e.raw),
      '',
    ];

    fs.writeFileSync(snapPath, lines.join('\r\n'), 'utf8');
    this.appendAuditLog('SNAPSHOT', 'info', `Perforce 서버 진단 로그 스냅샷 저장: ${snapPath}`);
    this.stateHub.appendLog(`✔ [P4 서버 로그 스냅샷 저장] ${snapPath}`, 'success');
    return { ok: true, filePath: snapPath, dir };
  }
}

module.exports = { P4LogService, parseP4LogBlocks, classifyP4Entry };
