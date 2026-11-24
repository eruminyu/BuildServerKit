const fs = require('fs');
const path = require('path');
const { execCapture, spawnStreamed, killProcessTree } = require('./processRunner');
const { applyPackageRetention, ensureAssetJunctions, getPackageArchiveSummary } = require('./systemService');

const ERROR_REGEX =
  /(error C\d+:|\bfatal error\b|\bError:|Ensure condition failed|Unable to find plugin|Result: Failed|UnrealBuildTool failed|AutomationTool exiting with ExitCode)/i;

function formatDuration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}분 ${String(s).padStart(2, '0')}초`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx >= 2 ? 2 : 0)} ${units[idx]}`;
}

class BuildService {
  constructor(configStore, stateHub, p4Service) {
    this.configStore = configStore;
    this.stateHub = stateHub;
    this.p4Service = p4Service;
    this.activeProc = null;
    this.building = false;
    this.durationTimer = null;
  }

  isBuilding() {
    return this.building;
  }

  findUProject(projectDir) {
    if (!projectDir || !fs.existsSync(projectDir)) return null;
    const files = fs.readdirSync(projectDir).filter((f) => f.toLowerCase().endsWith('.uproject'));
    return files.length > 0 ? path.join(projectDir, files[0]) : null;
  }

  async syncSource(branch = '', targetCL = '') {
    const cfg = this.configStore.get();
    if (cfg.VcsMode === 'PerforceHybrid') {
      return await this.p4Service.syncBuildWorkspace(targetCL);
    }

    if (!cfg.ProjectDir || !fs.existsSync(path.join(cfg.ProjectDir, '.git'))) {
      throw new Error('Git 워크스페이스가 존재하지 않습니다. 먼저 최초 Clone을 실행하세요.');
    }
    const targetBranch = (branch || cfg.LastBranch || 'main').trim();
    this.stateHub.appendLog(`=== [Git Sync] 브랜치 '${targetBranch}' 최신 커밋 동기화 ===`, 'cyan');

    if (cfg.GitHubAccessToken && cfg.GitRemoteUrl && cfg.GitRemoteUrl.startsWith('https://github.com/')) {
      const authUrl = cfg.GitRemoteUrl.replace('https://github.com/', `https://x-access-token:${cfg.GitHubAccessToken}@github.com/`);
      await execCapture('git', ['-c', 'safe.directory=*', 'remote', 'set-url', 'origin', authUrl], { cwd: cfg.ProjectDir });
    }

    const r1 = spawnStreamed('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=false', 'fetch', '--all', '--prune'], { cwd: cfg.ProjectDir }, (l) => {
      if (l.trim()) this.stateHub.appendLog(`[Git] ${l}`, 'info');
    });
    await r1.promise;

    const r2 = spawnStreamed(
      'git',
      ['-c', 'safe.directory=*', '-c', 'core.quotepath=false', 'checkout', '-f', '-B', targetBranch, `origin/${targetBranch}`],
      { cwd: cfg.ProjectDir },
      (l) => {
        if (l.trim()) this.stateHub.appendLog(`[Git] ${l}`, 'info');
      }
    );
    const code = await r2.promise;
    if (code === 0) {
      await ensureAssetJunctions(cfg);
      this.stateHub.appendLog(`✔ [Git Sync 완료] ${targetBranch}`, 'success');
    }
    return { ok: code === 0, code };
  }

  async resolveMetadata(branch, changelist) {
    const cfg = this.configStore.get();
    if (cfg.VcsMode === 'PerforceHybrid') {
      const meta = await this.p4Service.getCLMetadata(changelist);
      return {
        branch: branch || cfg.LastBranch || 'main',
        ref: meta.cl ? `CL${meta.cl}` : 'latest',
        author: meta.author || cfg.P4User || 'p4bot',
        message: meta.message || '(커밋 메시지 없음)',
      };
    }

    let hash = '';
    let author = '';
    let message = '';
    if (cfg.ProjectDir && fs.existsSync(path.join(cfg.ProjectDir, '.git'))) {
      const h = await execCapture('git', ['-c', 'safe.directory=*', 'rev-parse', '--short', 'HEAD'], { cwd: cfg.ProjectDir });
      hash = h.stdout.trim();
      const a = await execCapture('git', ['-c', 'safe.directory=*', '-c', 'i18n.logOutputEncoding=utf-8', 'log', '-1', '--pretty=format:%an'], {
        cwd: cfg.ProjectDir,
      });
      author = a.stdout.trim();
      const m = await execCapture('git', ['-c', 'safe.directory=*', '-c', 'i18n.logOutputEncoding=utf-8', 'log', '-1', '--pretty=format:%s'], {
        cwd: cfg.ProjectDir,
      });
      message = m.stdout.trim();
    }
    return {
      branch: branch || cfg.LastBranch || 'main',
      ref: hash || 'latest',
      author: author || cfg.GitHubUser || process.env.USERNAME || 'builder',
      message: message || '(커밋 메시지 없음)',
    };
  }

  async startBuild(mode = 'QuickVerify', options = {}) {
    if (this.building) {
      throw new Error('이미 다른 빌드가 진행 중입니다.');
    }
    const cfg = this.configStore.get();
    const runUat = path.join(cfg.UE5Root || '', 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat');
    if (!fs.existsSync(runUat)) {
      throw new Error(`RunUAT.bat를 찾을 수 없습니다: ${runUat}`);
    }

    const uproject = this.findUProject(cfg.ProjectDir);
    if (!uproject) {
      throw new Error(`프로젝트 폴더(${cfg.ProjectDir || '미설정'})에서 *.uproject 파일을 찾을 수 없습니다.`);
    }

    const projectName = path.basename(uproject, '.uproject');
    const clientCfg = options.clientConfig || cfg.ClientConfig || 'Development';

    this.building = true;
    this.stateHub.clearConsole();

    if (cfg.VcsMode !== 'PerforceHybrid') {
      await ensureAssetJunctions(cfg);
    }

    const meta = await this.resolveMetadata(options.branch, options.changelist);
    const safeBranch = meta.branch.replace(/^origin\//, '').replace(/[\\/:*?"<>|]/g, '_');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const buildId = `${ts}_${mode}_${safeBranch}_${meta.ref}`;

    const archiveRoot = cfg.ArchiveRoot || 'C:\\BuildArchive';
    const logArchiveDir = path.join(archiveRoot, 'Logs', buildId);
    fs.mkdirSync(logArchiveDir, { recursive: true });
    const uatLogFile = path.join(logArchiveDir, 'Full_UAT_Console.log');

    fs.writeFileSync(
      path.join(logArchiveDir, 'Build_Info.txt'),
      [
        `Project Name  : ${projectName}`,
        `VCS Mode      : ${cfg.VcsMode}`,
        `Build ID      : ${buildId}`,
        `Build Mode    : ${mode}`,
        `Client Config : ${clientCfg}`,
        `Branch        : ${meta.branch}`,
        `Version Ref   : ${meta.ref}`,
        `Commit Author : ${meta.author}`,
        `Commit Message: ${meta.message}`,
        `Start Time    : ${now.toLocaleString('ko-KR')}`,
      ].join('\r\n') + '\r\n',
      'utf8'
    );

    let pkgOutDir = '';
    const uatArgs = [
      'BuildCookRun',
      `-project=${uproject}`,
      '-noP4',
      '-platform=Win64',
      `-clientconfig=${clientCfg}`,
      '-build',
      '-cook',
    ];
    if (mode === 'QuickVerify') {
      uatArgs.push('-iterate', '-skipstage', '-utf8output');
    } else {
      pkgOutDir = path.join(archiveRoot, 'Packages', buildId);
      fs.mkdirSync(pkgOutDir, { recursive: true });
      uatArgs.push('-allmaps', '-stage', '-pak', '-archive', `-archivedirectory=${pkgOutDir}`, '-utf8output');
    }

    const startMs = Date.now();
    this.stateHub.updateSection('build', {
      status: 'running',
      mode,
      branch: safeBranch,
      ref: meta.ref,
      author: meta.author,
      message: meta.message,
      projectName,
      startedAt: new Date(startMs).toISOString(),
      duration: '00분 00초',
      lastExitCode: null,
      currentLogPath: uatLogFile,
      currentArchiveDir: logArchiveDir,
    });

    this.durationTimer = setInterval(() => {
      this.stateHub.updateSection('build', { duration: formatDuration(Date.now() - startMs) });
    }, 1000);

    this.stateHub.appendLog(
      `=== [${projectName} · ${mode} (${clientCfg})] 빌드 시작 (${cfg.VcsMode} / ${safeBranch} / ${meta.ref} by ${meta.author}) ===`,
      'cyan'
    );
    this.stateHub.appendLog(`프로젝트: ${uproject}`, 'muted');
    this.stateHub.appendLog(`로그 저장 경로: ${uatLogFile}`, 'muted');

    // Saved/Logs 정리
    const savedLogsDir = path.join(cfg.ProjectDir, 'Saved', 'Logs');
    if (fs.existsSync(savedLogsDir)) {
      try {
        for (const f of fs.readdirSync(savedLogsDir)) {
          fs.rmSync(path.join(savedLogsDir, f), { recursive: true, force: true });
        }
      } catch {}
    }

    const logStream = fs.createWriteStream(uatLogFile, { flags: 'w', encoding: 'utf8' });
    const extractedErrors = [];

    let exitCode = -1;
    try {
      const { proc, promise } = spawnStreamed('cmd.exe', ['/c', runUat, ...uatArgs], { cwd: cfg.ProjectDir }, (line, stream) => {
        logStream.write(line + '\r\n');
        let level = stream === 'stderr' ? 'warn' : 'info';
        if (ERROR_REGEX.test(line)) {
          level = 'error';
          extractedErrors.push(line.trim());
        } else if (/\bWarning:/i.test(line)) {
          level = 'warn';
        } else if (/BUILD SUCCESSFUL|AutomationTool exiting with ExitCode=0/i.test(line)) {
          level = 'success';
        }
        this.stateHub.appendLog(line, level);
      });
      this.activeProc = proc;
      exitCode = await promise;
    } finally {
      this.activeProc = null;
      logStream.end();
      if (this.durationTimer) {
        clearInterval(this.durationTimer);
        this.durationTimer = null;
      }
      this.building = false;
    }

    const durationStr = formatDuration(Date.now() - startMs);

    // 에러 요약 저장
    if (extractedErrors.length > 0) {
      fs.writeFileSync(path.join(logArchiveDir, 'Error_Summary.log'), extractedErrors.slice(-60).join('\r\n') + '\r\n', 'utf8');
    }

    // 언리얼 내부 로그 보관
    try {
      if (fs.existsSync(savedLogsDir)) {
        fs.cpSync(savedLogsDir, path.join(logArchiveDir, 'Saved_Logs'), { recursive: true, force: true });
      }
    } catch {}
    try {
      const uatInternal = path.join(process.env.APPDATA || '', 'Unreal Engine', 'AutomationTool', 'Logs');
      if (fs.existsSync(uatInternal)) {
        fs.cpSync(uatInternal, path.join(logArchiveDir, 'Engine_UAT_Logs'), { recursive: true, force: true });
      }
    } catch {}

    if (exitCode === 0) {
      this.stateHub.appendLog(`✔ === 빌드/패키징 성공! (소요 시간: ${durationStr}) ===`, 'success');

      if (mode === 'FullPackage' && pkgOutDir && fs.existsSync(pkgOutDir)) {
        if (cfg.GenerateLauncherOnPackage) {
          const lnchRes = await this.generateLauncher(pkgOutDir, projectName);
          if (lnchRes.ok) {
            this.stateHub.appendLog('✔ [게임 옵션 런처 동봉 완료] 패키징 폴더에 _Launcher.exe 생성됨', 'success');
          } else {
            this.stateHub.appendLog(`[런처 생성 경고] ${lnchRes.message}`, 'warn');
          }
        }

        // ★ 패키징 보관 개수 제한 적용 (오래된 순 자동 정리)
        if (cfg.EnablePackageRetention) {
          const retention = applyPackageRetention(cfg, pkgOutDir);
          if (retention.pruned.length > 0) {
            this.stateHub.appendLog(
              `[보관 정책] 최신 ${cfg.MaxRetainedPackages}개 유지 — 오래된 패키지 ${retention.pruned.length}개 자동 삭제 (${formatBytes(retention.freedBytes)} 확보)`,
              'warn'
            );
            for (const p of retention.pruned) {
              this.stateHub.appendLog(`  - 삭제됨: ${p.name} (${formatBytes(p.sizeBytes)})`, 'muted');
            }
          }
        }
        this.stateHub.broadcast('packages:updated', getPackageArchiveSummary(cfg));
      }
    } else {
      this.stateHub.appendLog(`✖ === 빌드 실패 (ExitCode: ${exitCode}, 소요 시간: ${durationStr}) ===`, 'error');
    }

    this.stateHub.updateSection('build', {
      status: exitCode === 0 ? 'success' : 'failed',
      duration: durationStr,
      lastExitCode: exitCode,
    });

    // Slack + Discord 자동 알림 발송
    await this.sendReports({
      projectName,
      exitCode,
      mode,
      branch: safeBranch,
      ref: meta.ref,
      author: meta.author,
      message: meta.message,
      duration: durationStr,
      logArchiveDir,
      uatLogFile,
    });

    return { ok: exitCode === 0, exitCode, duration: durationStr, buildId, logArchiveDir, pkgOutDir };
  }

  stopBuild() {
    if (this.activeProc && this.activeProc.pid) {
      killProcessTree(this.activeProc.pid);
      this.stateHub.appendLog('■ 사용자가 진행 중인 빌드를 강제 중단했습니다.', 'warn');
      return { ok: true };
    }
    return { ok: false, message: '현재 실행 중인 빌드가 없습니다.' };
  }

  async generateLauncher(packageDir, projectName = '') {
    const cfg = this.configStore.get();
    const mgrExe = this.configStore.resolveScriptPath('UE_BuildManager.exe');
    if (!fs.existsSync(mgrExe)) {
      return { ok: false, message: 'UE_BuildManager.exe(런처 빌더)를 찾을 수 없습니다.' };
    }

    // Read-Only 해제 방어 (P4 워크스페이스 복사본 등)
    const args = [
      '--make-launcher',
      packageDir,
      projectName || '',
      cfg.DefaultQualityPreset || 'Epic',
      cfg.DefaultResolution || '1920x1080',
      cfg.DefaultWindowMode || 'WindowedFullscreen',
      String(cfg.DefaultFrameRateLimit || 0),
      cfg.DefaultVSync ? 'true' : 'false',
    ];
    const res = await execCapture(mgrExe, args, { timeoutMs: 30000 });
    return { ok: res.code === 0, message: (res.stdout || res.stderr).trim() };
  }

  async sendReports(info) {
    const cfg = this.configStore.get();
    const results = { slack: null, discord: null };

    if (cfg.AutoSendSlack && cfg.SlackBotToken && cfg.SlackChannelId) {
      const slackScript = this.configStore.resolveScriptPath('Send-SlackReport.ps1');
      if (fs.existsSync(slackScript)) {
        this.stateHub.appendLog('[Slack] 빌드 결과 리포트 전송 중...', 'cyan');
        const r = await execCapture(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            slackScript,
            '-ProjectName',
            info.projectName,
            '-ExitCode',
            String(info.exitCode),
            '-BuildMode',
            info.mode,
            '-BranchName',
            info.branch,
            '-CommitHash',
            info.ref,
            '-CommitAuthor',
            info.author,
            '-CommitMsg',
            info.message,
            '-Duration',
            info.duration,
            '-LogArchiveDir',
            info.logArchiveDir,
            '-UATLogFile',
            info.uatLogFile,
          ],
          { timeoutMs: 30000 }
        );
        results.slack = r.code === 0;
        this.stateHub.appendLog(r.code === 0 ? '✔ [Slack] 리포트 전송 완료' : `[Slack 오류] ${r.stderr}`, r.code === 0 ? 'success' : 'error');
      }
    }

    if (cfg.AutoSendDiscord && cfg.DiscordWebhookUrl) {
      const discordScript = this.configStore.resolveScriptPath('Send-DiscordReport.ps1');
      if (fs.existsSync(discordScript)) {
        this.stateHub.appendLog('[Discord] Webhook 빌드 리포트 전송 중...', 'cyan');
        const r = await execCapture(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            discordScript,
            '-ProjectName',
            info.projectName,
            '-ExitCode',
            String(info.exitCode),
            '-BuildMode',
            info.mode,
            '-BranchName',
            info.branch,
            '-CommitHash',
            info.ref,
            '-CommitAuthor',
            info.author,
            '-CommitMsg',
            info.message,
            '-Duration',
            info.duration,
            '-LogArchiveDir',
            info.logArchiveDir,
            '-UATLogFile',
            info.uatLogFile,
          ],
          { timeoutMs: 30000 }
        );
        results.discord = r.code === 0;
        this.stateHub.appendLog(
          r.code === 0 ? '✔ [Discord] Webhook 리포트 전송 완료' : `[Discord 오류] ${r.stderr}`,
          r.code === 0 ? 'success' : 'error'
        );
      }
    }
    return results;
  }

  async testDiscordWebhook() {
    const cfg = this.configStore.get();
    if (!cfg.DiscordWebhookUrl) throw new Error('Discord Webhook URL을 먼저 입력하고 저장해 주세요.');
    const discordScript = this.configStore.resolveScriptPath('Send-DiscordReport.ps1');
    const r = await execCapture(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', discordScript, '-WebhookUrl', cfg.DiscordWebhookUrl, '-TestMode'],
      { timeoutMs: 15000 }
    );
    return { ok: r.code === 0, message: r.code === 0 ? 'Discord 테스트 메시지가 성공적으로 전송되었습니다!' : (r.stderr || r.stdout).trim() };
  }

  async testSlackConnection() {
    const cfg = this.configStore.get();
    if (!cfg.SlackBotToken || !cfg.SlackChannelId) throw new Error('Slack Bot Token과 채널 ID를 먼저 입력해 주세요.');
    const https = require('https');
    const payload = Buffer.from(
      JSON.stringify({
        channel: cfg.SlackChannelId,
        text: `✅ *BuildServerKit Studio* Slack 연동 테스트 성공! (PC: \`${process.env.COMPUTERNAME}\`)`,
      }),
      'utf8'
    );
    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'slack.com',
          path: '/api/chat.postMessage',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.SlackBotToken}`,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': payload.length,
          },
          timeout: 12000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve({ ok: Boolean(json.ok), message: json.ok ? 'Slack 테스트 메시지가 전송되었습니다!' : `Slack 오류: ${json.error}` });
            } catch {
              resolve({ ok: false, message: 'Slack 응답 파싱 실패' });
            }
          });
        }
      );
      req.on('error', (err) => resolve({ ok: false, message: err.message }));
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { BuildService };
