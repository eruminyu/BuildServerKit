const fs = require('fs');
const path = require('path');
const { execCapture, spawnStreamed } = require('./processRunner');

class P4Service {
  constructor(configStore, stateHub) {
    this.configStore = configStore;
    this.stateHub = stateHub;
    this.mirrorTimer = null;
    this.isMirrorRunning = false;
    this.isBackupRunning = false;
  }

  _p4BaseArgs(cfg) {
    return ['-p', cfg.P4Port || 'localhost:1666', '-u', cfg.P4User || 'p4bot'];
  }

  async testConnection() {
    const cfg = this.configStore.get();
    const base = this._p4BaseArgs(cfg);

    const info = await execCapture('p4', [...base, '-ztag', 'info'], { timeoutMs: 8000 });
    const login = await execCapture('p4', [...base, 'login', '-s'], { timeoutMs: 8000 });

    let serverVersion = '';
    let serverAddress = '';
    let unicodeMode = false;
    for (const line of (info.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^\.\.\.\s+([A-Za-z0-9_]+)\s+(.*)$/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === 'serverVersion') serverVersion = val.trim();
      else if (key === 'serverAddress') serverAddress = val.trim();
      else if (key === 'unicode' && val.trim().toLowerCase() === 'enabled') unicodeMode = true;
    }

    let buildRoot = '';
    let mirrorRoot = '';
    if (info.code === 0) {
      if (cfg.P4BuildClient) {
        const bc = await execCapture('p4', [...base, '-ztag', 'client', '-o', cfg.P4BuildClient], { timeoutMs: 6000 });
        const m = bc.stdout.match(/^\.\.\.\s+Root\s+(.+)$/m);
        if (m) buildRoot = m[1].trim();
      }
      if (cfg.P4MirrorClient) {
        const mc = await execCapture('p4', [...base, '-ztag', 'client', '-o', cfg.P4MirrorClient], { timeoutMs: 6000 });
        const m = mc.stdout.match(/^\.\.\.\s+Root\s+(.+)$/m);
        if (m) mirrorRoot = m[1].trim();
      }
    }

    return {
      ok: info.code === 0,
      ticketOk: login.code === 0,
      ticketMessage: (login.stdout || login.stderr || '').trim(),
      serverAddress,
      serverVersion,
      unicodeMode,
      buildRoot,
      mirrorRoot,
      rawError: info.code !== 0 ? (info.stderr || info.stdout || 'p4 실행 실패').trim() : '',
    };
  }

  async getRecentCLs(limit = 12) {
    const cfg = this.configStore.get();
    const stream = (cfg.P4Stream || '//MyProject/main').replace(/\/+$/, '');
    const res = await execCapture(
      'p4',
      [...this._p4BaseArgs(cfg), '-ztag', 'changes', '-l', '-s', 'submitted', '-m', String(limit), `${stream}/...`],
      { timeoutMs: 10000 }
    );
    if (res.code !== 0) {
      return { ok: false, items: [], error: (res.stderr || res.stdout).trim() };
    }

    const items = [];
    let current = null;
    let inDesc = false;

    for (const line of res.stdout.split(/\r?\n/)) {
      const m = line.match(/^\.\.\.\s+([A-Za-z0-9_]+)\s*(.*)$/);
      if (m) {
        inDesc = false;
        const [, key, val] = m;
        if (key === 'change') {
          if (current) items.push(current);
          current = { cl: Number(val.trim()), user: '', epoch: 0, desc: '' };
        } else if (current) {
          if (key === 'user') current.user = val.trim();
          else if (key === 'time') current.epoch = Number(val.trim()) || 0;
          else if (key === 'desc') {
            inDesc = true;
            current.desc = val;
          }
        }
      } else if (inDesc && current) {
        current.desc += (current.desc ? '\n' : '') + line;
      }
    }
    if (current) items.push(current);

    for (const item of items) {
      item.desc = (item.desc || '').trim();
      item.summary = (item.desc.split(/\r?\n/)[0] || '').trim();
      item.time = item.epoch ? new Date(item.epoch * 1000).toISOString() : '';
    }
    return { ok: true, items };
  }

  async getCLMetadata(cl) {
    const cfg = this.configStore.get();
    let targetCL = String(cl || '').trim();
    if (!targetCL) {
      const recent = await this.getRecentCLs(1);
      if (recent.ok && recent.items.length > 0) {
        const latest = recent.items[0];
        return { cl: String(latest.cl), author: latest.user, message: latest.summary || latest.desc };
      }
      return { cl: '', author: cfg.P4User || 'p4bot', message: '(CL 조회 불가)' };
    }

    const res = await execCapture('p4', [...this._p4BaseArgs(cfg), '-ztag', 'describe', '-s', targetCL], { timeoutMs: 8000 });
    if (res.code !== 0) {
      return { cl: targetCL, author: cfg.P4User || 'p4bot', message: `CL #${targetCL}` };
    }
    let author = '';
    let desc = '';
    for (const line of res.stdout.split(/\r?\n/)) {
      const um = line.match(/^\.\.\.\s+user\s+(.+)$/);
      if (um && !author) author = um[1].trim();
      const dm = line.match(/^\.\.\.\s+desc\s+(.+)$/);
      if (dm && !desc) desc = dm[1].trim();
    }
    return {
      cl: targetCL,
      author: author || cfg.P4User || 'p4bot',
      message: desc || `CL #${targetCL}`,
    };
  }

  async syncBuildWorkspace(targetCL = '') {
    const cfg = this.configStore.get();
    const spec = targetCL ? `//...@${targetCL}` : '//...#head';
    this.stateHub.appendLog(`=== [Perforce Sync] ${cfg.P4Port} / Client=${cfg.P4BuildClient} (${spec}) ===`, 'cyan');

    const { promise } = spawnStreamed(
      'p4',
      [...this._p4BaseArgs(cfg), '-c', cfg.P4BuildClient || 'ws-build-full', 'sync', spec],
      {},
      (line, stream) => {
        if (!line.trim()) return;
        this.stateHub.appendLog(`[P4] ${line}`, stream === 'stderr' ? 'warn' : 'info');
      }
    );
    const code = await promise;
    if (code === 0) {
      this.stateHub.appendLog(`✔ [Perforce Sync 완료] ${spec}`, 'success');
    } else {
      this.stateHub.appendLog(`✖ [Perforce Sync 실패] ExitCode=${code}`, 'error');
    }
    return { ok: code === 0, code };
  }

  getMirrorStatus() {
    const cfg = this.configStore.get();
    const stateCandidates = [
      path.join(this.configStore.getScriptsDir(), '.p4_state', 'last_mirrored_cl.txt'),
      path.join(this.configStore.getKitDir(), '.p4_state', 'last_mirrored_cl.txt'),
    ];
    let lastCL = 0;
    for (const p of stateCandidates) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (/^\d+$/.test(raw)) {
          lastCL = Number(raw);
          break;
        }
      }
    }

    const assetLogFile = path.join(
      cfg.P4MirrorDir || 'C:\\BuildSystem\\P4MirrorRepo',
      (cfg.P4MirrorAssetLogPath || '.p4-sync/asset_changelog.md').replace(/\//g, path.sep)
    );
    let recentAssetLog = [];
    if (fs.existsSync(assetLogFile)) {
      try {
        const lines = fs
          .readFileSync(assetLogFile, 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.trim().startsWith('- [CL #'));
        recentAssetLog = lines.slice(-25).reverse();
      } catch {}
    }

    this.stateHub.updateSection('mirror', {
      lastCL,
      autoEnabled: Boolean(this.mirrorTimer),
      running: this.isMirrorRunning,
    });

    return {
      ...this.stateHub.state.mirror,
      lastCL,
      assetLogFile,
      recentAssetLog,
    };
  }

  async runMirrorOnce(options = {}) {
    if (this.isMirrorRunning) {
      return { ok: false, message: '이미 P4 미러링이 실행 중입니다.' };
    }
    const cfg = this.configStore.get();
    const scriptPath = this.configStore.resolveScriptPath('Sync-P4ToGitHub.ps1');
    if (!fs.existsSync(scriptPath)) {
      return { ok: false, message: `미러링 스크립트를 찾을 수 없습니다: ${scriptPath}` };
    }

    this.isMirrorRunning = true;
    this.stateHub.updateSection('mirror', { running: true, lastStatus: 'running', lastMessage: '미러링 동기화 중...' });

    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-P4Port',
      cfg.P4Port || 'localhost:1666',
      '-P4User',
      cfg.P4User || 'p4bot',
      '-P4Stream',
      cfg.P4Stream || '//MyProject/main',
      '-P4MirrorClient',
      cfg.P4MirrorClient || 'ws-mirror-code',
      '-P4MirrorDir',
      cfg.P4MirrorDir || 'C:\\BuildSystem\\P4MirrorRepo',
      '-GitBranch',
      cfg.LastBranch || 'main',
    ];
    if (options.initWatermark) psArgs.push('-InitWatermark');
    if (options.dryRun) psArgs.push('-DryRun');

    const logs = [];
    const { promise } = spawnStreamed('powershell.exe', psArgs, {}, (line, stream) => {
      if (!line.trim()) return;
      logs.push(line);
      this.stateHub.appendLog(line, stream === 'stderr' ? 'error' : 'info');
    });

    const code = await promise;
    this.isMirrorRunning = false;

    const status = this.getMirrorStatus();
    const lastLine = logs.filter(Boolean).slice(-1)[0] || (code === 0 ? '미러링 완료' : `오류 (ExitCode=${code})`);
    this.stateHub.updateSection('mirror', {
      running: false,
      lastCL: status.lastCL,
      lastRunAt: new Date().toISOString(),
      lastStatus: code === 0 ? 'ok' : 'error',
      lastMessage: lastLine,
    });

    return { ok: code === 0, code, logs, status: this.getMirrorStatus() };
  }

  syncAutoMirrorTimer() {
    const cfg = this.configStore.get();
    if (this.mirrorTimer) {
      clearInterval(this.mirrorTimer);
      this.mirrorTimer = null;
    }
    if (cfg.VcsMode === 'PerforceHybrid' && cfg.P4AutoMirrorEnabled) {
      const mins = Math.max(1, Number(cfg.P4MirrorIntervalMinutes) || 2);
      this.mirrorTimer = setInterval(() => {
        this.runMirrorOnce().catch(() => {});
      }, mins * 60 * 1000);
      this.stateHub.updateSection('mirror', { autoEnabled: true });
      this.stateHub.appendLog(`▶ [P4 자동 미러링 타이머] ${mins}분 주기로 가동되었습니다.`, 'success');
    } else {
      this.stateHub.updateSection('mirror', { autoEnabled: false });
    }
  }

  stopAutoMirrorTimer() {
    if (this.mirrorTimer) {
      clearInterval(this.mirrorTimer);
      this.mirrorTimer = null;
    }
    this.stateHub.updateSection('mirror', { autoEnabled: false });
  }

  async registerMirrorTaskScheduler() {
    const cfg = this.configStore.get();
    const mins = Math.max(1, Number(cfg.P4MirrorIntervalMinutes) || 2);
    const scriptPath = this.configStore.resolveScriptPath('Sync-P4ToGitHub.ps1');
    const tr = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`;
    const res = await execCapture('schtasks', [
      '/Create',
      '/TN',
      'BuildServerKit_P4Mirror',
      '/TR',
      tr,
      '/SC',
      'MINUTE',
      '/MO',
      String(mins),
      '/F',
    ]);
    return { ok: res.code === 0, message: (res.stdout || res.stderr).trim() };
  }

  async unregisterMirrorTaskScheduler() {
    const res = await execCapture('schtasks', ['/Delete', '/TN', 'BuildServerKit_P4Mirror', '/F']);
    return { ok: res.code === 0, message: (res.stdout || res.stderr).trim() };
  }

  async runBackupOnce(options = {}) {
    if (this.isBackupRunning) {
      return { ok: false, message: '이미 백업이 실행 중입니다.' };
    }
    const cfg = this.configStore.get();
    const scriptPath = this.configStore.resolveScriptPath('Backup-P4Server.ps1');
    if (!fs.existsSync(scriptPath)) {
      return { ok: false, message: `백업 스크립트를 찾을 수 없습니다: ${scriptPath}` };
    }

    this.isBackupRunning = true;
    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-P4Port',
      cfg.P4Port || 'localhost:1666',
      '-AdminUser',
      options.adminUser || 'admin',
      '-P4DepotRoot',
      cfg.P4DepotRoot || 'C:\\Perforce\\Server',
      '-P4BackupRoot',
      cfg.P4BackupRoot || 'D:\\P4Backup',
      '-RetainCheckpoints',
      String(cfg.P4RetainCheckpoints || 7),
    ];
    if (options.skipCheckpoint) psArgs.push('-SkipCheckpoint');

    const { promise } = spawnStreamed('powershell.exe', psArgs, {}, (line, stream) => {
      if (line.trim()) this.stateHub.appendLog(`[P4Backup] ${line}`, stream === 'stderr' ? 'error' : 'info');
    });
    const code = await promise;
    this.isBackupRunning = false;
    return { ok: code === 0, code };
  }

  async registerBackupTaskScheduler(timeHHMM = '04:00', adminUser = 'admin') {
    const scriptPath = this.configStore.resolveScriptPath('Backup-P4Server.ps1');
    const tr = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}" -AdminUser "${adminUser}"`;
    const res = await execCapture('schtasks', [
      '/Create',
      '/TN',
      'BuildServerKit_P4NightlyBackup',
      '/TR',
      tr,
      '/SC',
      'DAILY',
      '/ST',
      timeHHMM,
      '/F',
    ]);
    return { ok: res.code === 0, message: (res.stdout || res.stderr).trim() };
  }
}

module.exports = { P4Service };
