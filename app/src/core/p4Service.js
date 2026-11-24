const fs = require('fs');
const path = require('path');
const { execCapture, execWithStdin, spawnStreamed } = require('./processRunner');

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

  // ---------------------------------------------------------------------------
  // Team & Account Management (Free-tier 5-user / 20-workspace safe helpers)
  // ---------------------------------------------------------------------------
  async listUsersAndQuotas(adminUserOverride = '') {
    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';
    const userArg = (adminUserOverride || cfg.P4User || '').trim();
    const base = userArg ? ['-p', port, '-u', userArg] : ['-p', port];

    // Also inspect current default OS user from -ztag info
    let activeSystemUser = '';
    const infoRes = await execCapture('p4', ['-p', port, '-ztag', 'info'], { timeoutMs: 5000 });
    const connected = infoRes.code === 0;
    if (connected) {
      const m = (infoRes.stdout || '').match(/^\.\.\.\s+userName\s+(.+)$/m);
      if (m) activeSystemUser = m[1].trim();
    }

    const users = [];
    let workspaceCount = 0;
    let noAutoCreate = '';
    let error = '';

    if (connected) {
      // Try with configured user, fallback to activeSystemUser if ticket missing
      let uRes = await execCapture('p4', [...base, '-ztag', 'users'], { timeoutMs: 6000 });
      let effectiveBase = base;
      if (uRes.code !== 0 && activeSystemUser && activeSystemUser !== userArg) {
        effectiveBase = ['-p', port, '-u', activeSystemUser];
        uRes = await execCapture('p4', [...effectiveBase, '-ztag', 'users'], { timeoutMs: 6000 });
      }

      if (uRes.code === 0) {
        let cur = null;
        for (const line of (uRes.stdout || '').split(/\r?\n/)) {
          const m = line.match(/^\.\.\.\s+([A-Za-z0-9_]+)\s*(.*)$/);
          if (!m) continue;
          const [, k, v] = m;
          if (k === 'User') {
            if (cur) users.push(cur);
            cur = { p4User: v.trim(), email: '', fullName: '', type: 'standard' };
          } else if (cur) {
            if (k === 'Email') cur.email = v.trim();
            else if (k === 'FullName') cur.fullName = v.trim();
            else if (k === 'Type') cur.type = v.trim();
          }
        }
        if (cur) users.push(cur);
      } else {
        error = (uRes.stderr || uRes.stdout || '').trim();
      }

      const cRes = await execCapture('p4', [...effectiveBase, '-ztag', 'clients'], { timeoutMs: 6000 });
      if (cRes.code === 0) {
        workspaceCount = (cRes.stdout.match(/^\.\.\.\s+client\s+/gm) || []).length;
      }

      const cfgRes = await execCapture('p4', [...effectiveBase, 'configure', 'show', 'dm.user.noautocreate'], { timeoutMs: 5000 });
      if (cfgRes.code === 0) {
        const cm = (cfgRes.stdout || '').match(/dm\.user\.noautocreate\s*=\s*(\d+)/);
        if (cm) noAutoCreate = cm[1];
      }
    } else {
      error = (infoRes.stderr || infoRes.stdout || 'Perforce 서버에 연결할 수 없습니다.').trim();
    }

    return {
      connected,
      activeSystemUser,
      users,
      userCount: users.length,
      workspaceCount,
      noAutoCreateLocked: noAutoCreate === '2' || noAutoCreate === '1',
      error,
    };
  }

  async upsertP4User({ adminUser, p4User, fullName, email, password = '' }) {
    const targetId = String(p4User || '').trim();
    if (!targetId || /[\s@#*%"'\\/]/.test(targetId)) {
      throw new Error('Perforce 아이디에는 공백이나 특수문자(@, #, *, % 등)를 사용할 수 없습니다.');
    }
    const targetEmail = String(email || '').trim();
    if (!targetEmail || !targetEmail.includes('@')) {
      throw new Error('올바른 이메일 주소를 입력해 주세요.');
    }
    const targetName = String(fullName || targetId).trim();

    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';
    const admin = (adminUser || '').trim();
    const base = admin ? ['-p', port, '-u', admin] : ['-p', port];

    // 1. Fetch current spec (or default template for new user)
    const outRes = await execCapture('p4', [...base, 'user', '-o', targetId], { timeoutMs: 6000 });
    if (outRes.code !== 0) {
      throw new Error(`p4 user -o 실패: ${(outRes.stderr || outRes.stdout).trim()}`);
    }

    const lines = (outRes.stdout || '').split(/\r?\n/);
    let emailSet = false;
    let nameSet = false;
    const updatedLines = lines.map((line) => {
      if (/^Email:/i.test(line)) {
        emailSet = true;
        return `Email:\t${targetEmail}`;
      }
      if (/^FullName:/i.test(line)) {
        nameSet = true;
        return `FullName:\t${targetName}`;
      }
      return line;
    });
    if (!emailSet) updatedLines.push(`Email:\t${targetEmail}`);
    if (!nameSet) updatedLines.push(`FullName:\t${targetName}`);

    // 2. Apply updated user spec with -f (admin force)
    const saveRes = await execWithStdin('p4', [...base, 'user', '-f', '-i'], updatedLines.join('\n') + '\n', { timeoutMs: 8000 });
    if (saveRes.code !== 0) {
      throw new Error(`p4 user -f -i 실패: ${(saveRes.stderr || saveRes.stdout).trim()}`);
    }

    // 3. Optionally set password (if 8+ chars provided)
    let passwordMsg = '';
    if (password && password.length > 0) {
      if (password.length < 8) {
        throw new Error('Perforce 비밀번호는 최소 8자 이상이어야 합니다.');
      }
      const pwRes = await execWithStdin('p4', [...base, 'passwd', targetId], `${password}\n${password}\n`, { timeoutMs: 8000 });
      if (pwRes.code !== 0) {
        passwordMsg = ` (비밀번호 설정 경고: ${(pwRes.stderr || pwRes.stdout).trim()})`;
      } else {
        passwordMsg = ' · 비밀번호 설정 완료';
      }
    }

    this.stateHub.appendLog(`✔ [P4 계정 저장] ${targetId} (${targetName} <${targetEmail}>)${passwordMsg}`, 'success');
    return { ok: true, message: `Perforce 계정 '${targetId}' 저장 완료!${passwordMsg}` };
  }

  async deleteP4User({ adminUser, p4User }) {
    const targetId = String(p4User || '').trim();
    if (!targetId) throw new Error('삭제할 Perforce 아이디가 없습니다.');
    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';
    const admin = (adminUser || '').trim();
    const base = admin ? ['-p', port, '-u', admin] : ['-p', port];

    const res = await execCapture('p4', [...base, 'user', '-f', '-d', targetId], { timeoutMs: 8000 });
    if (res.code !== 0) {
      throw new Error(`p4 user -d 실패: ${(res.stderr || res.stdout).trim()}`);
    }
    this.stateHub.appendLog(`✔ [P4 계정 삭제] ${targetId}`, 'warn');
    return { ok: true, message: `Perforce 계정 '${targetId}'이(가) 삭제되었습니다.` };
  }

  async lockAutoUserCreate(adminUser = '') {
    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';
    const admin = (adminUser || '').trim();
    const base = admin ? ['-p', port, '-u', admin] : ['-p', port];

    const res = await execCapture('p4', [...base, 'configure', 'set', 'dm.user.noautocreate=2'], { timeoutMs: 6000 });
    if (res.code !== 0) {
      throw new Error(`설정 실패: ${(res.stderr || res.stdout).trim()}`);
    }
    return { ok: true, message: '임의 유저 자동 생성이 차단되었습니다 (dm.user.noautocreate=2).' };
  }
}

module.exports = { P4Service };
