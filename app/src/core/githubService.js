const fs = require('fs');
const path = require('path');
const https = require('https');
const { execCapture, spawnStreamed, killProcessTree } = require('./processRunner');

function githubRequest(method, apiPath, token, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const headers = {
      'User-Agent': 'BuildServerKit-Studio/2.0',
      Accept: 'application/vnd.github+json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = payload.length;
    }

    const req = https.request(
      {
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers,
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, data: json, raw: text });
          } else {
            const msg = (json && json.message) || text || `HTTP ${res.statusCode}`;
            reject(new Error(`GitHub API ${res.statusCode}: ${msg}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('GitHub API 요청 시간 초과'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

class GitHubService {
  constructor(configStore, stateHub, buildService) {
    this.configStore = configStore;
    this.stateHub = stateHub;
    this.buildService = buildService;
    this.runnerProc = null;
    this.apiPollTimer = null;
    this.processedRunIds = new Set();
    this.isPollChecking = false;
  }

  async getGhCliToken() {
    const res = await execCapture('gh', ['auth', 'token'], { timeoutMs: 5000 });
    if (res.code === 0 && res.stdout.trim()) {
      return { ok: true, token: res.stdout.trim() };
    }
    return { ok: false, error: (res.stderr || 'GitHub CLI(gh) 로그인이 되어 있지 않거나 설치되지 않았습니다.').trim() };
  }

  async fetchUserAndRepos(token) {
    const t = (token || this.configStore.get().GitHubAccessToken || '').trim();
    if (!t) throw new Error('GitHub 토큰이 필요합니다.');

    const userResp = await githubRequest('GET', '/user', t);
    const repos = [];
    for (let page = 1; page <= 3; page++) {
      const r = await githubRequest('GET', `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`, t);
      if (!Array.isArray(r.data) || r.data.length === 0) break;
      for (const item of r.data) {
        repos.push({
          fullName: item.full_name,
          name: item.name,
          htmlUrl: item.html_url,
          cloneUrl: item.clone_url,
          defaultBranch: item.default_branch || 'main',
          isPrivate: Boolean(item.private),
          description: item.description || '',
          canAdmin: Boolean(item.permissions && item.permissions.admin),
        });
      }
      if (r.data.length < 100) break;
    }

    return {
      user: {
        login: userResp.data.login,
        name: userResp.data.name || userResp.data.login,
        avatarUrl: userResp.data.avatar_url || '',
      },
      repos,
    };
  }

  async lookupGitHubProfile(profileInput) {
    const raw = String(profileInput || '').trim();
    if (!raw) throw new Error('GitHub 프로필 링크 또는 사용자 아이디를 입력해 주세요.');

    let username = raw;
    const urlMatch = raw.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?:[\/?#].*)?$/i);
    if (urlMatch) {
      username = urlMatch[1];
    } else {
      username = raw.replace(/^@+/, '').trim();
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
      throw new Error(`유효한 GitHub 프로필 URL 또는 아이디가 아닙니다: ${raw}`);
    }

    const token = (this.configStore.get().GitHubAccessToken || '').trim();
    const userResp = await githubRequest('GET', `/users/${encodeURIComponent(username)}`, token);
    const u = userResp.data || {};
    const login = u.login || username;
    const displayName = (u.name || login).trim();
    const numericId = u.id || '';
    const noreplyEmail = numericId ? `${numericId}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;

    let email = (u.email || '').trim();
    let emailSource = email ? 'public_profile' : 'noreply';

    // If profile email is hidden, inspect recent public push events for a real commit email
    if (!email) {
      try {
        const evResp = await githubRequest('GET', `/users/${encodeURIComponent(login)}/events/public?per_page=15`, token);
        const events = Array.isArray(evResp.data) ? evResp.data : [];
        for (const ev of events) {
          if (ev.type !== 'PushEvent' || !ev.payload || !Array.isArray(ev.payload.commits)) continue;
          for (const c of ev.payload.commits) {
            const cEmail = c && c.author && c.author.email ? String(c.author.email).trim() : '';
            const cName = c && c.author && c.author.name ? String(c.author.name).trim() : '';
            if (
              cEmail &&
              !cEmail.includes('bot') &&
              (cName.toLowerCase() === login.toLowerCase() || cName.toLowerCase() === displayName.toLowerCase() || cEmail.toLowerCase().includes(login.toLowerCase()))
            ) {
              email = cEmail;
              emailSource = 'public_commit';
              break;
            }
          }
          if (email) break;
        }
      } catch {}
    }

    if (!email) {
      email = noreplyEmail;
      emailSource = 'noreply';
    }

    return {
      login,
      name: displayName,
      email,
      noreplyEmail,
      emailSource, // public_profile | public_commit | noreply
      githubUrl: u.html_url || `https://github.com/${login}`,
      avatarUrl: u.avatar_url || '',
      bio: u.bio || '',
    };
  }

  async fetchBranches() {
    const cfg = this.configStore.get();
    if (!cfg.ConnectedRepoFullName || !cfg.GitHubAccessToken) return [];
    try {
      const resp = await githubRequest('GET', `/repos/${cfg.ConnectedRepoFullName}/branches?per_page=100`, cfg.GitHubAccessToken);
      return Array.isArray(resp.data) ? resp.data.map((b) => b.name) : [];
    } catch {
      return [];
    }
  }

  getWorkflowTemplate(templateType = 'perforce') {
    const fileName = templateType === 'git' ? 'github_workflow_build.yml' : 'github_workflow_p4_build.yml';
    const filePath = this.configStore.resolveScriptPath(fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`워크플로우 템플릿을 찾을 수 없습니다: ${fileName}`);
    }
    return {
      fileName,
      content: fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''),
    };
  }

  async scanWorkflow(branch) {
    const cfg = this.configStore.get();
    const targetBranch = branch || cfg.LastBranch || 'main';
    if (!cfg.ConnectedRepoFullName || !cfg.GitHubAccessToken) {
      const out = { hasWorkflow: false, workflowType: 'none', summary: '저장소 연결 필요', recentRuns: [] };
      this.stateHub.updateSection('workflow', out);
      return out;
    }

    let hasWorkflow = false;
    let workflowType = 'none';
    try {
      const resp = await githubRequest(
        'GET',
        `/repos/${cfg.ConnectedRepoFullName}/contents/.github/workflows/build.yml?ref=${encodeURIComponent(targetBranch)}`,
        cfg.GitHubAccessToken
      );
      if (resp.data && resp.data.content) {
        hasWorkflow = true;
        const decoded = Buffer.from(resp.data.content, 'base64').toString('utf8');
        workflowType = decoded.includes('PerforceHybrid') || decoded.includes('p4sync') ? 'perforce' : 'git';
      }
    } catch {}

    let recentRuns = [];
    try {
      const runsResp = await githubRequest('GET', `/repos/${cfg.ConnectedRepoFullName}/actions/runs?per_page=8`, cfg.GitHubAccessToken);
      if (runsResp.data && Array.isArray(runsResp.data.workflow_runs)) {
        recentRuns = runsResp.data.workflow_runs.map((r) => ({
          id: r.id,
          name: r.name,
          title: r.display_title,
          branch: r.head_branch,
          status: r.status,
          conclusion: r.conclusion,
          createdAt: r.created_at,
          htmlUrl: r.html_url,
        }));
      }
    } catch {}

    const summary = hasWorkflow
      ? `${targetBranch} 브랜치에 ${workflowType === 'perforce' ? 'Perforce 하이브리드' : 'Git 전용'} build.yml 등록됨`
      : `${targetBranch} 브랜치에 build.yml 미등록`;

    const result = { hasWorkflow, workflowType, summary, branch: targetBranch, recentRuns };
    this.stateHub.updateSection('workflow', { hasWorkflow, workflowType, summary });
    return result;
  }

  async pushWorkflow(branch, templateType = 'perforce') {
    const cfg = this.configStore.get();
    if (!cfg.ConnectedRepoFullName || !cfg.GitHubAccessToken) {
      throw new Error('먼저 GitHub 저장소를 연결해 주세요.');
    }
    const targetBranch = (branch || cfg.LastBranch || 'main').trim();
    const tpl = this.getWorkflowTemplate(templateType);
    const apiPath = `/repos/${cfg.ConnectedRepoFullName}/contents/.github/workflows/build.yml`;

    let existingSha = null;
    try {
      const existing = await githubRequest('GET', `${apiPath}?ref=${encodeURIComponent(targetBranch)}`, cfg.GitHubAccessToken);
      if (existing.data && existing.data.sha) existingSha = existing.data.sha;
    } catch {}

    const body = {
      message: `ci: configure Unreal Engine ${templateType === 'perforce' ? 'Perforce Hybrid' : 'Git'} build workflow (build.yml) [skip ci]`,
      content: Buffer.from(tpl.content, 'utf8').toString('base64'),
      branch: targetBranch,
    };
    if (existingSha) body.sha = existingSha;

    await githubRequest('PUT', apiPath, cfg.GitHubAccessToken, body);
    this.stateHub.appendLog(`✔ [GitHub API] '${targetBranch}' 브랜치에 ${tpl.fileName} 등록 완료!`, 'success');
    return await this.scanWorkflow(targetBranch);
  }

  async cloneGitWorkspace() {
    const cfg = this.configStore.get();
    if (!cfg.GitRemoteUrl) throw new Error('연결된 GitHub 저장소가 없습니다.');
    const repoName = path.basename(cfg.GitRemoteUrl, '.git');
    const targetDir = cfg.VcsMode === 'PerforceHybrid'
      ? (cfg.P4MirrorDir || 'C:\\BuildSystem\\P4MirrorRepo')
      : (cfg.ProjectDir || path.join(cfg.WorkspaceRoot || 'C:\\BuildSystem\\Workspace', repoName));

    if (fs.existsSync(path.join(targetDir, '.git'))) {
      return { ok: true, alreadyExists: true, targetDir };
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    let cloneUrl = cfg.GitRemoteUrl;
    if (cfg.GitHubAccessToken && cloneUrl.startsWith('https://github.com/')) {
      cloneUrl = cloneUrl.replace('https://github.com/', `https://x-access-token:${cfg.GitHubAccessToken}@github.com/`);
    }

    this.stateHub.appendLog(`=== [Git Clone] ${cfg.GitRemoteUrl} -> ${targetDir} ===`, 'cyan');
    const { promise } = spawnStreamed('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=false', 'clone', cloneUrl, targetDir], {}, (line) => {
      if (line.trim()) this.stateHub.appendLog(`[Git] ${line}`, 'info');
    });
    const code = await promise;
    if (code === 0 && cfg.VcsMode === 'Git' && !cfg.ProjectDir) {
      this.configStore.save({ ProjectDir: targetDir });
    }
    return { ok: code === 0, targetDir };
  }

  async getRunnerStatus() {
    const cfg = this.configStore.get();
    const runnerDir = cfg.RunnerDir || 'C:\\actions-runner';
    const installed = fs.existsSync(path.join(runnerDir, 'config.cmd'));
    const configured = fs.existsSync(path.join(runnerDir, '.runner'));

    let running = Boolean(this.runnerProc && this.runnerProc.exitCode === null);
    if (!running) {
      const check = await execCapture('tasklist', ['/FI', 'IMAGENAME eq Runner.Listener.exe', '/NH'], { timeoutMs: 4000 });
      if (check.stdout && check.stdout.toLowerCase().includes('runner.listener.exe')) {
        running = true;
      }
    }

    const status = {
      installed,
      configured,
      running,
      apiPolling: Boolean(this.apiPollTimer),
    };
    this.stateHub.updateSection('runner', status);
    return status;
  }

  async downloadRunner() {
    const cfg = this.configStore.get();
    const runnerDir = cfg.RunnerDir || 'C:\\actions-runner';
    fs.mkdirSync(runnerDir, { recursive: true });
    if (fs.existsSync(path.join(runnerDir, 'config.cmd'))) {
      return { ok: true, alreadyInstalled: true, status: await this.getRunnerStatus() };
    }

    this.stateHub.appendLog('=== GitHub Actions Runner (Windows x64) 최신 릴리즈 다운로드 중 ===', 'cyan');
    const psCmd = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$ProgressPreference = 'SilentlyContinue'",
      "$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{ 'User-Agent'='BuildServerKit' }",
      "$asset = $rel.assets | Where-Object { $_.name -like 'actions-runner-win-x64-*.zip' } | Select-Object -First 1",
      `$zipPath = Join-Path '${runnerDir.replace(/'/g, "''")}' $asset.name`,
      "Write-Output ('다운로드: ' + $asset.browser_download_url)",
      "Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath",
      "Write-Output '압축 해제 중...'",
      `Expand-Archive -Path $zipPath -DestinationPath '${runnerDir.replace(/'/g, "''")}' -Force`,
      "Remove-Item $zipPath -Force",
      "Write-Output 'Runner 설치 완료!'",
    ].join('; ');

    const { promise } = spawnStreamed('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { cwd: runnerDir }, (line) => {
      if (line.trim()) this.stateHub.appendLog(`[Runner Setup] ${line}`, 'info');
    });
    const code = await promise;
    return { ok: code === 0, status: await this.getRunnerStatus() };
  }

  async registerRunner() {
    const cfg = this.configStore.get();
    const runnerDir = cfg.RunnerDir || 'C:\\actions-runner';
    const configCmd = path.join(runnerDir, 'config.cmd');
    if (!fs.existsSync(configCmd)) throw new Error('먼저 Runner를 다운로드·설치해 주세요.');
    if (!cfg.GitHubRepoUrl) throw new Error('먼저 GitHub 저장소를 연결해 주세요.');

    let regToken = (cfg.RunnerToken || '').trim();
    if (!regToken && cfg.GitHubAccessToken && cfg.ConnectedRepoFullName) {
      this.stateHub.appendLog('[GitHub API] Runner 등록 토큰 자동 발급 중...', 'cyan');
      const resp = await githubRequest('POST', `/repos/${cfg.ConnectedRepoFullName}/actions/runners/registration-token`, cfg.GitHubAccessToken);
      regToken = resp.data && resp.data.token ? resp.data.token : '';
    }
    if (!regToken) {
      throw new Error('Runner 등록 토큰을 발급할 수 없습니다. 저장소 Admin 권한 토큰 또는 수동 등록 토큰이 필요합니다.');
    }

    await this.stopRunner();
    for (const oldFile of ['.runner', '.credentials', '.credentials_rsaparams', '.service']) {
      const p = path.join(runnerDir, oldFile);
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    }

    const runnerName = `${process.env.COMPUTERNAME || 'BuildPC'}-UE-Builder`;
    this.stateHub.appendLog(`=== Self-Hosted Runner 등록 시작 (${runnerName}) ===`, 'cyan');
    const { promise } = spawnStreamed(
      'cmd.exe',
      ['/c', configCmd, '--url', cfg.GitHubRepoUrl, '--token', regToken, '--name', runnerName, '--work', '_work', '--unattended', '--replace'],
      { cwd: runnerDir },
      (line) => {
        if (line.trim()) this.stateHub.appendLog(`[Runner Config] ${line}`, 'info');
      }
    );
    const code = await promise;
    return { ok: code === 0, status: await this.getRunnerStatus() };
  }

  async startRunner() {
    const cfg = this.configStore.get();
    const runnerDir = cfg.RunnerDir || 'C:\\actions-runner';
    const runCmd = path.join(runnerDir, 'run.cmd');
    if (!fs.existsSync(runCmd)) throw new Error('run.cmd를 찾을 수 없습니다. Runner 설치 및 등록을 먼저 진행해 주세요.');

    if (this.apiPollTimer) {
      this.stopApiPoller();
      this.stateHub.appendLog('[안내] 공식 Self-Hosted Runner 가동 시 중복 빌드를 막기 위해 API 자동 폴러를 자동으로 중지했습니다.', 'warn');
    }

    const { proc } = spawnStreamed('cmd.exe', ['/c', runCmd], { cwd: runnerDir }, (line, stream) => {
      if (line.trim()) this.stateHub.appendLog(`[Runner] ${line}`, stream === 'stderr' ? 'warn' : 'cyan');
    });
    this.runnerProc = proc;
    proc.on('close', () => {
      this.runnerProc = null;
      this.getRunnerStatus().catch(() => {});
    });

    this.stateHub.appendLog('▶ GitHub Actions Self-Hosted Runner가 백그라운드에서 가동을 시작했습니다!', 'success');
    return await this.getRunnerStatus();
  }

  async stopRunner() {
    if (this.runnerProc && this.runnerProc.pid) {
      killProcessTree(this.runnerProc.pid);
      this.runnerProc = null;
    }
    await execCapture('taskkill', ['/F', '/IM', 'Runner.Listener.exe'], { timeoutMs: 4000 });
    this.stateHub.appendLog('■ GitHub Actions Runner가 중지되었습니다.', 'warn');
    return await this.getRunnerStatus();
  }

  async toggleApiPoller() {
    if (this.apiPollTimer) {
      this.stopApiPoller();
      return await this.getRunnerStatus();
    }
    const status = await this.getRunnerStatus();
    if (status.running) {
      throw new Error('공식 Self-Hosted Runner가 이미 실행 중입니다. 중복 빌드를 방지하려면 Runner를 중지한 뒤 API 폴러를 사용하세요.');
    }
    const cfg = this.configStore.get();
    if (!cfg.ConnectedRepoFullName || !cfg.GitHubAccessToken) {
      throw new Error('GitHub 저장소 및 API 토큰 연결이 필요합니다.');
    }

    this.apiPollTimer = setInterval(() => this._pollOnce().catch(() => {}), 15000);
    this.stateHub.appendLog(`▶ [API 자동 감지 폴러] '${cfg.ConnectedRepoFullName}' 15초 주기 감시 시작`, 'success');
    this._pollOnce().catch(() => {});
    return await this.getRunnerStatus();
  }

  stopApiPoller() {
    if (this.apiPollTimer) {
      clearInterval(this.apiPollTimer);
      this.apiPollTimer = null;
      this.stateHub.appendLog('■ [API 자동 감지 폴러] 중지되었습니다.', 'warn');
    }
  }

  async _pollOnce() {
    if (this.isPollChecking || this.buildService.isBuilding()) return;
    const cfg = this.configStore.get();
    if (!cfg.ConnectedRepoFullName || !cfg.GitHubAccessToken) return;

    this.isPollChecking = true;
    try {
      const resp = await githubRequest('GET', `/repos/${cfg.ConnectedRepoFullName}/actions/runs?per_page=8`, cfg.GitHubAccessToken);
      const runs = (resp.data && resp.data.workflow_runs) || [];
      const queued = runs.find((r) => r.status === 'queued' && !this.processedRunIds.has(String(r.id)));
      if (!queued) return;

      this.processedRunIds.add(String(queued.id));
      this.stateHub.appendLog(`★ [API 자동 감지] 대기 중 워크플로우 감지 (#${queued.id}: ${queued.display_title})`, 'success');
      try {
        await githubRequest('POST', `/repos/${cfg.ConnectedRepoFullName}/actions/runs/${queued.id}/cancel`, cfg.GitHubAccessToken);
      } catch {}

      let targetCL = '';
      const clMatch = (queued.display_title || '').match(/\[CL #(\d+)\]/);
      if (clMatch) targetCL = clMatch[1];

      const isPackageTag = /\[(package|release)\]/i.test(queued.display_title || '');
      const mode =
        cfg.VcsMode === 'PerforceHybrid'
          ? isPackageTag
            ? 'FullPackage'
            : 'QuickVerify'
          : queued.head_branch === 'main' || queued.head_branch === 'master'
            ? 'FullPackage'
            : 'QuickVerify';

      await this.buildService.syncSource(queued.head_branch || 'main', targetCL);
      await this.buildService.startBuild(mode, {
        branch: queued.head_branch || 'main',
        changelist: targetCL,
      });
    } finally {
      this.isPollChecking = false;
    }
  }
}

module.exports = { GitHubService };
