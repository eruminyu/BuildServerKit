const fs = require('fs');
const path = require('path');
const { execCapture, execWithStdin, spawnStreamed } = require('./processRunner');

class P4Service {
  constructor(configStore, stateHub, p4LogService = null) {
    this.configStore = configStore;
    this.stateHub = stateHub;
    this.p4LogService = p4LogService;
    this.mirrorTimer = null;
    this.isMirrorRunning = false;
    this.isBackupRunning = false;
    this.schedulerRegistered = false;
  }

  _audit(category, level, message, meta = null) {
    if (this.p4LogService && typeof this.p4LogService.appendAuditLog === 'function') {
      this.p4LogService.appendAuditLog(category, level, message, meta);
    }
  }

  async refreshSchedulerStatus() {
    const res = await execCapture('schtasks', ['/Query', '/TN', 'BuildServerKit_P4Mirror'], { timeoutMs: 4000 });
    this.schedulerRegistered = res.code === 0;
    this.stateHub.updateSection('mirror', {
      schedulerRegistered: this.schedulerRegistered,
    });
    return this.schedulerRegistered;
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
    let serverRoot = '';
    let serverUptime = '';
    let unicodeMode = false;
    let securityEnabled = false;
    for (const line of (info.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^\.\.\.\s+([A-Za-z0-9_]+)\s+(.*)$/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === 'serverVersion') serverVersion = val.trim();
      else if (key === 'serverAddress') serverAddress = val.trim();
      else if (key === 'serverRoot') serverRoot = val.trim();
      else if (key === 'serverUptime') serverUptime = val.trim();
      else if (key === 'unicode' && val.trim().toLowerCase() === 'enabled') unicodeMode = true;
      else if (key === 'security' && val.trim().toLowerCase() === 'enabled') securityEnabled = true;
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

    const result = {
      ok: info.code === 0,
      ticketOk: login.code === 0,
      ticketMessage: (login.stdout || login.stderr || '').trim(),
      serverAddress,
      serverVersion,
      serverRoot,
      serverUptime,
      unicodeMode,
      securityEnabled,
      buildRoot,
      mirrorRoot,
      rawError: info.code !== 0 ? (info.stderr || info.stdout || 'p4 실행 실패').trim() : '',
    };
    this._audit(
      'CONNECT_TEST',
      result.ok ? (result.ticketOk ? 'info' : 'warn') : 'error',
      result.ok
        ? `연결 성공 (${result.serverAddress || cfg.P4Port}, user=${cfg.P4User}, ticket=${result.ticketOk ? 'OK' : result.ticketMessage})`
        : `연결 실패 (${cfg.P4Port}): ${result.rawError}`
    );
    return result;
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
      schedulerRegistered: Boolean(this.schedulerRegistered),
      running: this.isMirrorRunning,
    });

    return {
      ...this.stateHub.state.mirror,
      lastCL,
      schedulerRegistered: Boolean(this.schedulerRegistered),
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
    this._audit('MIRROR', code === 0 ? 'info' : 'error', `미러링 종료 (ExitCode=${code}, CL=#${status.lastCL}): ${lastLine}`);

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
    if (res.code === 0) {
      this.schedulerRegistered = true;
      this.stateHub.updateSection('mirror', {
        schedulerRegistered: true,
        lastMessage: `Windows 작업 스케줄러 등록됨 (${mins}분 주기)`,
      });
      this.stateHub.appendLog(`✔ [P4 미러링 스케줄러] Windows 작업 스케줄러 등록 완료 (${mins}분 주기)`, 'success');
    }
    return { ok: res.code === 0, message: (res.stdout || res.stderr).trim() };
  }

  async unregisterMirrorTaskScheduler() {
    const res = await execCapture('schtasks', ['/Delete', '/TN', 'BuildServerKit_P4Mirror', '/F']);
    await this.refreshSchedulerStatus();
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
  async _checkTicket(port, user) {
    const u = String(user || '').trim();
    if (!u) return { valid: false, message: '' };
    const r = await execCapture('p4', ['-p', port, '-u', u, 'login', '-s'], { timeoutMs: 4000 });
    return {
      valid: r.code === 0,
      message: (r.stdout || r.stderr || '').trim(),
    };
  }

  async _ensureAdminTicket(port, adminUser) {
    const admin = String(adminUser || '').trim();
    if (!admin) return;
    const chk = await this._checkTicket(port, admin);
    if (!chk.valid) {
      this._audit('AUTH', 'auth_fail', `관리자(${admin}) 세션 만료 또는 미로그인: ${chk.message}`);
      throw new Error(
        `관리자 계정('${admin}')의 Perforce 로그인 세션이 만료되었거나 로그인되어 있지 않습니다. ` +
          `상단 [관리자 빠른 재로그인]에서 비밀번호로 다시 로그인한 뒤 시도해 주세요. (상세: ${chk.message || '세션 만료'})`
      );
    }
  }

  _parseZtagUsers(stdout) {
    const users = [];
    const blocks = (stdout || '').split(/\r?\n\s*\r?\n/);
    for (const block of blocks) {
      const fields = {};
      for (const line of block.split(/\r?\n/)) {
        const m = line.match(/^\.\.\.\s+([A-Za-z0-9_]+)\s*(.*)$/);
        if (m) fields[m[1]] = m[2].trim();
      }
      if (!fields.User) continue;
      const accessEp = Number(fields.Access) || 0;
      const updateEp = Number(fields.Update) || 0;
      users.push({
        p4User: fields.User,
        email: fields.Email || '',
        fullName: fields.FullName || '',
        type: fields.Type || 'standard',
        hasPassword: Boolean(fields.Password && (fields.Password.toLowerCase() === 'enabled' || fields.Password.length > 0)),
        lastAccessEpoch: accessEp,
        lastAccess: accessEp > 0 ? new Date(accessEp * 1000).toISOString() : '',
        lastUpdateEpoch: updateEp,
      });
    }
    return users;
  }

  async listUsersAndQuotas(adminUserOverride = '') {
    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';

    // 1. Check server reachability & OS default P4USER from -ztag info
    let activeSystemUser = '';
    const infoRes = await execCapture('p4', ['-p', port, '-ztag', 'info'], { timeoutMs: 5000 });
    const connected = infoRes.code === 0;
    if (connected) {
      const m = (infoRes.stdout || '').match(/^\.\.\.\s+userName\s+(.+)$/m);
      if (m) activeSystemUser = m[1].trim();
    }

    const botUser = (cfg.P4User || 'p4bot').trim();
    const adminUser = (
      adminUserOverride ||
      activeSystemUser ||
      (botUser && botUser.toLowerCase() !== 'p4bot' ? botUser : '') ||
      ''
    ).trim();

    const users = [];
    let workspaceCount = 0;
    let noAutoCreate = '';
    let noAutoCreateStatus = connected ? 'unknown_need_admin' : 'offline';
    let error = '';
    let authWarning = '';
    let queriedAs = '';
    let adminTicketValid = false;
    let adminTicketMessage = '';
    let botTicketValid = false;
    let botTicketMessage = '';

    if (connected) {
      // 2. Check both admin ticket and automation bot ticket independently
      if (adminUser) {
        const at = await this._checkTicket(port, adminUser);
        adminTicketValid = at.valid;
        adminTicketMessage = at.message;
      }
      if (botUser) {
        if (botUser.toLowerCase() === adminUser.toLowerCase()) {
          botTicketValid = adminTicketValid;
          botTicketMessage = adminTicketMessage;
        } else {
          const bt = await this._checkTicket(port, botUser);
          botTicketValid = bt.valid;
          botTicketMessage = bt.message;
        }
      }

      // 3. Build read candidate order: valid admin -> valid bot (p4bot unlimited ticket!) -> fallbacks
      const candidates = [];
      const addCand = (u) => {
        const v = String(u || '').trim();
        if (v && !candidates.some((c) => c.toLowerCase() === v.toLowerCase())) candidates.push(v);
      };
      if (adminTicketValid) addCand(adminUser);
      if (botTicketValid) addCand(botUser);
      addCand(botUser);
      addCand(adminUser);
      addCand(activeSystemUser);

      let uRes = null;
      let effectiveBase = ['-p', port];
      let lastErr = '';
      for (const cand of candidates) {
        const baseCand = ['-p', port, '-u', cand];
        const tryRes = await execCapture('p4', [...baseCand, '-ztag', 'users'], { timeoutMs: 6000 });
        if (tryRes.code === 0) {
          uRes = tryRes;
          effectiveBase = baseCand;
          queriedAs = cand;
          break;
        }
        lastErr = (tryRes.stderr || tryRes.stdout || '').trim();
      }

      if (uRes && uRes.code === 0) {
        users.push(...this._parseZtagUsers(uRes.stdout));
      } else {
        error = lastErr || 'Perforce 유저 목록을 조회할 수 없습니다 (로그인 티켓 만료 또는 권한 부족).';
        this._audit('USERS_LIST', 'auth_fail', `유저 목록 조회 실패: ${error}`);
      }

      const cRes = await execCapture('p4', [...effectiveBase, '-ztag', 'clients'], { timeoutMs: 6000 });
      if (cRes.code === 0) {
        workspaceCount = (cRes.stdout.match(/^\.\.\.\s+client\s+/gm) || []).length;
      }

      // `configure show` requires admin/super — try admin if valid, else effectiveBase
      const cfgBase = adminTicketValid && adminUser ? ['-p', port, '-u', adminUser] : effectiveBase;
      const cfgRes = await execCapture('p4', [...cfgBase, 'configure', 'show', 'dm.user.noautocreate'], { timeoutMs: 5000 });
      if (cfgRes.code === 0) {
        const cm = (cfgRes.stdout || '').match(/dm\.user\.noautocreate\s*=\s*(\d+)/);
        if (cm) noAutoCreate = cm[1];
        noAutoCreateStatus = noAutoCreate === '2' || noAutoCreate === '1' ? 'locked' : 'open';
      } else if (/don't have permission|session has expired|password/i.test(cfgRes.stderr || cfgRes.stdout || '')) {
        noAutoCreateStatus = 'unknown_need_admin';
      }

      if (users.length > 0 && adminUser && !adminTicketValid) {
        authWarning = `관리자 계정('${adminUser}')의 로그인 세션이 만료되었습니다 (기본 12시간). 현재 목록은 '${queriedAs}' 티켓으로 정상 표시 중이며, 팀원 추가·수정·비밀번호 변경을 하려면 관리자 재로그인이 필요합니다.`;
      }
    } else {
      error = (infoRes.stderr || infoRes.stdout || 'Perforce 서버에 연결할 수 없습니다.').trim();
      this._audit('USERS_LIST', 'error', `서버 미연결 (${port}): ${error}`);
    }

    return {
      connected,
      activeSystemUser,
      adminUser,
      adminTicketValid,
      adminTicketMessage,
      botUser,
      botTicketValid,
      botTicketMessage,
      queriedAs,
      users,
      userCount: users.length,
      workspaceCount,
      noAutoCreateLocked: noAutoCreate === '2' || noAutoCreate === '1',
      noAutoCreateStatus, // locked | open | unknown_need_admin | offline
      error,
      authWarning,
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

    // 0. Ensure admin session is valid before mutating server state
    if (admin) {
      await this._ensureAdminTicket(port, admin);
    }

    // Check if user already exists & whether a password is already configured
    let existingUser = null;
    const existRes = await execCapture('p4', [...base, '-ztag', 'users', targetId], { timeoutMs: 5000 });
    if (existRes.code === 0) {
      const parsed = this._parseZtagUsers(existRes.stdout);
      existingUser = parsed.find((u) => u.p4User.toLowerCase() === targetId.toLowerCase()) || null;
    }

    if ((!password || password.length === 0) && (!existingUser || !existingUser.hasPassword)) {
      throw new Error(
        `신규 계정 또는 비밀번호가 미설정된 계정('${targetId}')은 비밀번호(영문+숫자 등 2종 이상 조합 8자 이상)를 반드시 입력해야 P4V 첫 로그인이 성공합니다!`
      );
    }

    // 1. Fetch current spec (or default template for new user)
    const outRes = await execCapture('p4', [...base, 'user', '-o', targetId], { timeoutMs: 6000 });
    if (outRes.code !== 0) {
      const errMsg = (outRes.stderr || outRes.stdout).trim();
      this._audit('USER_UPSERT', 'error', `p4 user -o ${targetId} 실패 (admin=${admin}): ${errMsg}`);
      throw new Error(`p4 user -o 실패: ${errMsg}`);
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
      const errMsg = (saveRes.stderr || saveRes.stdout).trim();
      this._audit('USER_UPSERT', 'error', `p4 user -f -i ${targetId} 실패: ${errMsg}`);
      throw new Error(`p4 user -f -i 실패: ${errMsg}`);
    }

    // 3. Optionally set password (if 8+ chars provided)
    let passwordMsg = '';
    if (password && password.length > 0) {
      if (password.length < 8) {
        throw new Error('Perforce 비밀번호는 최소 8자 이상이어야 합니다. (영문 대/소문자 + 숫자·특수문자 중 2종 이상 조합 권장)');
      }
      const pwRes = await execWithStdin('p4', [...base, 'passwd', targetId], `${password}\n${password}\n`, { timeoutMs: 8000 });
      if (pwRes.code !== 0) {
        const rawErr = (pwRes.stderr || pwRes.stdout || '').trim();
        this._audit('USER_PASSWD', 'error', `p4 passwd ${targetId} 거부: ${rawErr}`);
        throw new Error(
          `계정은 저장되었으나 비밀번호 설정이 거부되었습니다 (P4D 보안 정책: 영문 대/소문자 + 숫자·특수문자 중 2종 이상 조합 8자 이상 필요). 상세: ${rawErr}`
        );
      }
      passwordMsg = ' · 비밀번호 설정 완료';
    }

    this._audit('USER_UPSERT', 'info', `P4 계정 저장 완료: ${targetId} (${targetName} <${targetEmail}>)${passwordMsg}`);
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

    if (admin) {
      await this._ensureAdminTicket(port, admin);
    }

    const res = await execCapture('p4', [...base, 'user', '-f', '-d', targetId], { timeoutMs: 8000 });
    if (res.code !== 0) {
      const errMsg = (res.stderr || res.stdout).trim();
      this._audit('USER_DELETE', 'error', `p4 user -d ${targetId} 실패: ${errMsg}`);
      throw new Error(`p4 user -d 실패: ${errMsg}`);
    }
    this._audit('USER_DELETE', 'warn', `P4 계정 삭제됨: ${targetId} (by ${admin || 'default'})`);
    this.stateHub.appendLog(`✔ [P4 계정 삭제] ${targetId}`, 'warn');
    return { ok: true, message: `Perforce 계정 '${targetId}'이(가) 삭제되었습니다.` };
  }

  async lockAutoUserCreate(adminUser = '') {
    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';
    const admin = (adminUser || '').trim();
    const base = admin ? ['-p', port, '-u', admin] : ['-p', port];

    if (admin) {
      await this._ensureAdminTicket(port, admin);
    }

    const res = await execCapture('p4', [...base, 'configure', 'set', 'dm.user.noautocreate=2'], { timeoutMs: 6000 });
    if (res.code !== 0) {
      const errMsg = (res.stderr || res.stdout).trim();
      this._audit('CONFIG', 'error', `dm.user.noautocreate=2 설정 실패: ${errMsg}`);
      throw new Error(`설정 실패: ${errMsg}`);
    }
    this._audit('CONFIG', 'info', 'dm.user.noautocreate=2 적용 완료');
    return { ok: true, message: '임의 유저 자동 생성이 차단되었습니다 (dm.user.noautocreate=2).' };
  }

  /**
   * Creates/updates a timeout-only group (NOT referenced in `p4 protect`, so permissions are untouched)
   * to prevent 12-hour default ticket expiration for the admin and team members.
   */
  async extendSessionTimeout({ adminUser = '', groupName = 'team_long_session', timeout = 'unlimited', includeAllUsers = true } = {}) {
    const cfg = this.configStore.get();
    const port = cfg.P4Port || 'localhost:1666';
    const admin = String(adminUser || '').trim();
    if (!admin) throw new Error('관리자(super) Perforce 아이디를 먼저 입력해 주세요.');

    await this._ensureAdminTicket(port, admin);
    const base = ['-p', port, '-u', admin];

    const targetUsers = new Set([admin]);
    if (includeAllUsers) {
      const uRes = await execCapture('p4', [...base, '-ztag', 'users'], { timeoutMs: 6000 });
      if (uRes.code === 0) {
        for (const u of this._parseZtagUsers(uRes.stdout)) {
          if (u.p4User && u.p4User.toLowerCase() !== 'p4bot') {
            targetUsers.add(u.p4User);
          }
        }
      }
    }

    const gOut = await execCapture('p4', [...base, 'group', '-o', groupName], { timeoutMs: 6000 });
    if (gOut.code !== 0) {
      throw new Error(`p4 group -o ${groupName} 실패: ${(gOut.stderr || gOut.stdout).trim()}`);
    }

    // Parse existing users in the group so we never remove anyone
    const lines = (gOut.stdout || '').split(/\r?\n/);
    const outLines = [];
    let inUsers = false;
    let sawTimeout = false;
    let sawPwTimeout = false;
    let sawUsers = false;
    for (const line of lines) {
      if (/^Timeout:/i.test(line)) {
        sawTimeout = true;
        outLines.push(`Timeout:\t${timeout}`);
        continue;
      }
      if (/^PasswordTimeout:/i.test(line)) {
        sawPwTimeout = true;
        outLines.push('PasswordTimeout:\tunlimited');
        continue;
      }
      if (/^Users:/i.test(line)) {
        inUsers = true;
        sawUsers = true;
        outLines.push('Users:');
        continue;
      }
      if (inUsers) {
        if (/^\s+\S+/.test(line)) {
          targetUsers.add(line.trim());
          continue;
        }
        // Flush collected users before leaving Users section
        for (const u of targetUsers) outLines.push(`\t${u}`);
        inUsers = false;
      }
      outLines.push(line);
    }
    if (inUsers) {
      for (const u of targetUsers) outLines.push(`\t${u}`);
    } else if (!sawUsers) {
      outLines.push('Users:');
      for (const u of targetUsers) outLines.push(`\t${u}`);
    }
    if (!sawTimeout) outLines.push(`Timeout:\t${timeout}`);
    if (!sawPwTimeout) outLines.push('PasswordTimeout:\tunlimited');

    const gIn = await execWithStdin('p4', [...base, 'group', '-i'], outLines.join('\n') + '\n', { timeoutMs: 8000 });
    if (gIn.code !== 0) {
      const errMsg = (gIn.stderr || gIn.stdout).trim();
      this._audit('SESSION_TIMEOUT', 'error', `그룹 ${groupName} 저장 실패: ${errMsg}`);
      throw new Error(`p4 group -i 실패: ${errMsg}`);
    }

    const userList = Array.from(targetUsers);
    this._audit('SESSION_TIMEOUT', 'info', `세션 만료 연장 그룹(${groupName}, Timeout=${timeout}) 적용: ${userList.join(', ')}`);
    this.stateHub.appendLog(
      `✔ [P4 세션 만료 연장] 그룹 '${groupName}' (Timeout: ${timeout})에 ${userList.join(', ')} 등록 완료! (다음 로그인부터 무기한 티켓 적용)`,
      'success'
    );
    return {
      ok: true,
      groupName,
      users: userList,
      message: `세션 만료 무기한 연장 완료! (${userList.join(', ')}) — 한 번 다시 로그인하면 이후 12시간 만료가 발생하지 않습니다.`,
    };
  }
}

module.exports = { P4Service };
