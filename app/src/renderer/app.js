(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.transport;

  let cfg = {};
  let appState = null;
  let remoteMode = !api.isElectron;
  let readOnlyMode = false;

  let consoleLines = [];
  let errorLines = [];
  let activeTermTab = 'all'; // all | error
  let historyItems = [];
  let historyFilter = 'all';
  let loadedRepos = [];
  let selectedRepo = null;
  let authorMapRows = [];

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let idx = 0;
    let v = bytes;
    while (v >= 1024 && idx < units.length - 1) {
      v /= 1024;
      idx++;
    }
    return `${v.toFixed(idx >= 2 ? 2 : 0)} ${units[idx]}`;
  }

  function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function toast(message, type = 'info') {
    const container = $('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(() => el.remove(), 260);
    }, 3400);
  }

  async function safeCall(fn, successMsg = '') {
    try {
      const res = await fn();
      if (successMsg) toast(successMsg, 'success');
      return res;
    } catch (err) {
      toast(err.message || String(err), 'error');
      return null;
    }
  }

  function openModal(id) {
    $(id)?.classList.add('open');
  }
  function closeModal(id) {
    $(id)?.classList.remove('open');
  }

  // ---------------------------------------------------------------------------
  // Navigation & Window Controls
  // ---------------------------------------------------------------------------
  function switchView(viewId) {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewId);
    });
    document.querySelectorAll('.view-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `view-${viewId}`);
    });
    if (viewId === 'packaging') refreshPackages();
    if (viewId === 'history') refreshHistory();
    if (viewId === 'perforce') {
      refreshMirrorStatus();
      refreshProvStatus();
    }
    if (viewId === 'team') refreshTeamTab();
    if (viewId === 'p4logs') {
      refreshP4Logs();
    } else if (typeof stopP4LogLiveTimer === 'function') {
      stopP4LogLiveTimer();
    }
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.querySelectorAll('.close-modal').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
  });

  if (api.window) {
    $('btnWinMin')?.addEventListener('click', () => api.window.minimize());
    $('btnWinMax')?.addEventListener('click', () => api.window.maximize());
    $('btnWinTray')?.addEventListener('click', () => api.window.hideToTray());
    $('btnWinClose')?.addEventListener('click', () => api.window.close());
  }

  // ---------------------------------------------------------------------------
  // Remote Mode & Permissions
  // ---------------------------------------------------------------------------
  function applyRemoteRestrictions() {
    if (!remoteMode) return;
    document.body.classList.add('remote-mode');
    $('remoteModeBadge').textContent = readOnlyMode ? '읽기 전용 모드' : '원격 빌드 허용 모드';
    $('remoteModeBadge').className = readOnlyMode ? 'badge badge-blue' : 'badge badge-amber';

    document.querySelectorAll('.local-only').forEach((el) => {
      el.disabled = true;
      el.title = '전용 빌드 PC 데스크톱 앱에서만 변경할 수 있습니다.';
    });
    if (readOnlyMode) {
      document.querySelectorAll('.trigger-btn').forEach((el) => {
        el.disabled = true;
        el.title = '원격 웹 대시보드가 읽기 전용 모드입니다.';
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Config Hydration & Sync
  // ---------------------------------------------------------------------------
  function hydrateConfigToUI() {
    const isP4 = cfg.VcsMode === 'PerforceHybrid';

    // Topbar & Sidebar badges
    $('topVcsChip').textContent = isP4 ? 'Perforce Hybrid' : 'Git Only';
    $('topVcsChip').className = isP4 ? 'vcs-chip' : 'vcs-chip git';
    $('lblSyncSourceBtn').textContent = isP4 ? 'P4 최신 동기화' : 'Git 브랜치 동기화';
    $('sideRepoName').textContent = cfg.ConnectedRepoFullName || '미연결';
    $('sideStreamName').textContent = isP4 ? (cfg.P4Stream || '//MyProject/main') : (cfg.LastBranch || 'main');

    // Packaging & Retention
    $('chkEnableRetention').checked = Boolean(cfg.EnablePackageRetention);
    $('numMaxPackages').value = cfg.MaxRetainedPackages || 10;
    updateRetentionUIState();

    document.querySelectorAll('#clientConfigCards .option-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.cfg === (cfg.ClientConfig || 'Development'));
    });
    $('selQualityPreset').value = cfg.DefaultQualityPreset || 'Epic';
    $('selResolution').value = cfg.DefaultResolution || '1920x1080';
    $('selWindowMode').value = cfg.DefaultWindowMode || 'WindowedFullscreen';
    $('selFpsLimit').value = String(cfg.DefaultFrameRateLimit || 0);
    $('chkVSync').checked = Boolean(cfg.DefaultVSync);
    $('chkGenLauncher').checked = cfg.GenerateLauncherOnPackage !== false;

    const retainTag = cfg.EnablePackageRetention ? `보관 ${cfg.MaxRetainedPackages}개` : '무제한 보관';
    $('dashProfilePill').textContent = `${cfg.ClientConfig || 'Development'} · ${cfg.DefaultQualityPreset || 'Epic'} · ${cfg.DefaultResolution || '1920x1080'} · ${retainTag}`;

    // Perforce Tab
    document.querySelectorAll('#vcsModeSegmented button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === (cfg.VcsMode || 'PerforceHybrid'));
    });
    $('txtP4Port').value = cfg.P4Port || 'localhost:1666';
    $('txtP4User').value = cfg.P4User || 'p4bot';
    $('txtP4Stream').value = cfg.P4Stream || '//MyProject/main';
    $('txtP4BuildClient').value = cfg.P4BuildClient || 'ws-build-full';
    $('txtP4MirrorClient').value = cfg.P4MirrorClient || 'ws-mirror-code';
    $('txtP4MirrorDir').value = cfg.P4MirrorDir || 'C:\\BuildSystem\\P4MirrorRepo';
    $('chkP4AutoMirror').checked = Boolean(cfg.P4AutoMirrorEnabled);
    $('numP4Interval').value = cfg.P4MirrorIntervalMinutes || 2;
    $('txtAssetLogPath').value = cfg.P4MirrorAssetLogPath || '.p4-sync/asset_changelog.md';
    $('txtP4DepotRoot').value = cfg.P4DepotRoot || 'C:\\Perforce\\Server';
    $('txtP4BackupRoot').value = cfg.P4BackupRoot || 'D:\\P4Backup';
    $('numRetainCheckpoints').value = cfg.P4RetainCheckpoints || 7;

    // GitHub Tab
    $('ghRepoSummary').textContent = cfg.ConnectedRepoFullName
      ? `연결됨: ${cfg.ConnectedRepoFullName} (${cfg.GitHubUser || '인증됨'})`
      : '연결된 저장소가 없습니다. 우측 상단 버튼으로 로그인하세요.';
    $('selWorkflowTemplate').value = isP4 ? 'perforce' : 'git';

    // Settings Tab
    $('chkAutoDiscord').checked = cfg.AutoSendDiscord !== false;
    $('txtDiscordWebhook').value = cfg.DiscordWebhookUrl || '';
    $('chkAutoSlack').checked = cfg.AutoSendSlack !== false;
    $('txtSlackToken').value = cfg.SlackBotToken || '';
    $('txtSlackChannel').value = cfg.SlackChannelId || '';
    $('txtTailscaleIp').value = cfg.TailscaleIP || '';
    $('numWebPort').value = cfg.RemoteWebDashboardPort || 3780;
    $('chkWebEnabled').checked = Boolean(cfg.RemoteWebDashboardEnabled);
    $('chkWebReadOnly').checked = cfg.RemoteWebDashboardReadOnly !== false;
    if ($('chkMinimizeToTray')) $('chkMinimizeToTray').checked = cfg.MinimizeToTrayOnClose !== false;
    $('txtUE5Root').value = cfg.UE5Root || '';
    $('txtProjectDir').value = cfg.ProjectDir || '';
    $('txtArchiveRoot').value = cfg.ArchiveRoot || '';
    $('txtRunnerDir').value = cfg.RunnerDir || '';
    $('txtWorkspaceRoot').value = cfg.WorkspaceRoot || '';
    $('txtSharedAssetsDir').value = cfg.SharedAssetsDir || '';

    const ipHint = cfg.TailscaleIP || '<자동감지 IP>';
    $('smbPreviewHint').textContent = `공유폴더 주소: \\\\${ipHint}\\BuildArchive`;
  }

  function updateRetentionUIState() {
    const enabled = $('chkEnableRetention').checked;
    const count = Math.max(1, Math.min(200, Number($('numMaxPackages').value) || 10));
    $('retentionControlBox').classList.toggle('disabled', !enabled);
    $('retentionStatusBadge').textContent = enabled ? `사용함 · 최신 ${count}개 유지` : '사용안함 · 무제한 보관';
    $('retentionStatusBadge').className = enabled ? 'badge badge-green' : 'badge badge-slate';
    $('kpiRetainBadge').textContent = enabled ? `최대 ${count}개` : '무제한';
    document.querySelectorAll('.retain-preset').forEach((chip) => {
      chip.classList.toggle('active', Number(chip.dataset.val) === count);
    });
  }

  function collectConfigFromUI() {
    const activeCfgCard = document.querySelector('#clientConfigCards .option-card.active');
    const activeVcsBtn = document.querySelector('#vcsModeSegmented button.active');
    return {
      VcsMode: activeVcsBtn ? activeVcsBtn.dataset.mode : cfg.VcsMode,
      EnablePackageRetention: $('chkEnableRetention').checked,
      MaxRetainedPackages: Math.max(1, Math.min(200, Number($('numMaxPackages').value) || 10)),
      ClientConfig: activeCfgCard ? activeCfgCard.dataset.cfg : 'Development',
      DefaultQualityPreset: $('selQualityPreset').value,
      DefaultResolution: $('selResolution').value,
      DefaultWindowMode: $('selWindowMode').value,
      DefaultFrameRateLimit: Number($('selFpsLimit').value) || 0,
      DefaultVSync: $('chkVSync').checked,
      GenerateLauncherOnPackage: $('chkGenLauncher').checked,

      P4Port: $('txtP4Port').value.trim(),
      P4User: $('txtP4User').value.trim(),
      P4Stream: $('txtP4Stream').value.trim(),
      P4BuildClient: $('txtP4BuildClient').value.trim(),
      P4MirrorClient: $('txtP4MirrorClient').value.trim(),
      P4MirrorDir: $('txtP4MirrorDir').value.trim(),
      P4AutoMirrorEnabled: $('chkP4AutoMirror').checked,
      P4MirrorIntervalMinutes: Math.max(1, Number($('numP4Interval').value) || 2),
      P4MirrorAssetLogPath: $('txtAssetLogPath').value.trim(),
      P4DepotRoot: $('txtP4DepotRoot').value.trim(),
      P4BackupRoot: $('txtP4BackupRoot').value.trim(),
      P4RetainCheckpoints: Math.max(1, Number($('numRetainCheckpoints').value) || 7),

      AutoSendDiscord: $('chkAutoDiscord').checked,
      DiscordWebhookUrl: $('txtDiscordWebhook').value.trim(),
      AutoSendSlack: $('chkAutoSlack').checked,
      SlackBotToken: $('txtSlackToken').value.trim(),
      SlackChannelId: $('txtSlackChannel').value.trim(),
      TailscaleIP: $('txtTailscaleIp').value.trim(),
      RemoteWebDashboardPort: Number($('numWebPort').value) || 3780,
      RemoteWebDashboardEnabled: $('chkWebEnabled').checked,
      RemoteWebDashboardReadOnly: $('chkWebReadOnly').checked,
      MinimizeToTrayOnClose: $('chkMinimizeToTray') ? $('chkMinimizeToTray').checked : true,
      UE5Root: $('txtUE5Root').value.trim(),
      ProjectDir: $('txtProjectDir').value.trim(),
      ArchiveRoot: $('txtArchiveRoot').value.trim(),
      RunnerDir: $('txtRunnerDir').value.trim(),
      WorkspaceRoot: $('txtWorkspaceRoot').value.trim(),
      SharedAssetsDir: $('txtSharedAssetsDir').value.trim(),
    };
  }

  async function saveCurrentConfig(showToast = true) {
    if (remoteMode) return;
    const partial = collectConfigFromUI();
    const saved = await safeCall(() => api.invoke('config:save', partial), showToast ? '설정이 저장되었습니다.' : '');
    if (saved) {
      cfg = saved;
      hydrateConfigToUI();
      refreshPackages();
    }
  }

  // ---------------------------------------------------------------------------
  // Live State Rendering
  // ---------------------------------------------------------------------------
  function renderState() {
    if (!appState) return;
    const { build, runner, mirror, webServer, workflow } = appState;

    // Build status
    const pill = $('topStatusPill');
    pill.className = `status-pill ${build.status !== 'idle' ? build.status : ''}`;
    const labelMap = {
      idle: '대기 중 (IDLE)',
      running: `${build.mode || '빌드'} 진행 중...`,
      success: `빌드 성공 (${build.duration})`,
      failed: `빌드 실패 (Exit ${build.lastExitCode})`,
    };
    $('topStatusText').textContent = labelMap[build.status] || '대기 중';
    $('topTimerChip').textContent = build.duration || '00분 00초';

    $('kpiBuildVal').textContent =
      build.status === 'running' ? '빌드 진행 중' : build.status === 'success' ? '성공' : build.status === 'failed' ? '실패' : '대기 중';
    $('kpiBuildModeBadge').textContent = build.mode || 'IDLE';
    $('kpiBuildModeBadge').className =
      build.status === 'running'
        ? 'badge badge-blue'
        : build.status === 'success'
          ? 'badge badge-green'
          : build.status === 'failed'
            ? 'badge badge-rose'
            : 'badge badge-slate';
    $('kpiBuildSub').textContent = build.ref
      ? `${build.ref} · ${build.author} · ${build.duration}`
      : '최근 빌드 기록 없음';

    const isRunning = build.status === 'running';
    if (!remoteMode || !readOnlyMode) {
      $('btnQuickVerify').disabled = isRunning;
      $('btnFullPackage').disabled = isRunning;
      $('btnSyncSource').disabled = isRunning;
      $('btnStopBuild').disabled = !isRunning;
    }

    // Mirror status
    const isAutoMirror = Boolean(mirror.autoEnabled || mirror.schedulerRegistered);
    const mirrorVal = mirror.lastCL ? `CL #${mirror.lastCL}` : 'CL #0';
    $('kpiMirrorVal').textContent = mirrorVal;
    $('mirrorLiveBadge').textContent = mirror.running ? '동기화 중...' : mirrorVal;
    let mirrorBadgeText = '수동';
    if (mirror.running) mirrorBadgeText = '실행 중';
    else if (mirror.autoEnabled && mirror.schedulerRegistered) mirrorBadgeText = '자동 ON (앱+스케줄러)';
    else if (mirror.schedulerRegistered) mirrorBadgeText = '스케줄러 ON';
    else if (mirror.autoEnabled) mirrorBadgeText = '자동 ON';
    $('kpiMirrorBadge').textContent = mirrorBadgeText;
    $('kpiMirrorBadge').className = mirror.running ? 'badge badge-blue' : isAutoMirror ? 'badge badge-green' : 'badge badge-slate';
    $('kpiMirrorSub').textContent = mirror.lastMessage || (mirror.schedulerRegistered ? 'Windows 작업 스케줄러 자동 실행 중' : '대기 중');
    $('navMirrorBadge').textContent = mirror.schedulerRegistered && !mirror.autoEnabled ? 'SCHED' : isAutoMirror ? 'AUTO' : 'OFF';
    $('navMirrorBadge').className = isAutoMirror ? 'nav-badge ok' : 'nav-badge';

    // Runner status
    let runnerLabel = '미설치';
    let runnerBadgeCls = 'badge badge-slate';
    if (runner.running) {
      runnerLabel = '가동 중 (Runner)';
      runnerBadgeCls = 'badge badge-green';
    } else if (runner.apiPolling) {
      runnerLabel = 'API 폴링 중';
      runnerBadgeCls = 'badge badge-blue';
    } else if (runner.configured) {
      runnerLabel = '등록됨 (대기)';
      runnerBadgeCls = 'badge badge-amber';
    } else if (runner.installed) {
      runnerLabel = '설치됨 (미등록)';
    }
    $('kpiRunnerVal').textContent = runnerLabel;
    $('kpiRunnerBadge').textContent = runner.running || runner.apiPolling ? 'ONLINE' : 'OFFLINE';
    $('kpiRunnerBadge').className = runnerBadgeCls;
    $('runnerDetailBadge').textContent = runnerLabel;
    $('runnerDetailBadge').className = runnerBadgeCls;
    if ($('wizRunnerBadge')) {
      $('wizRunnerBadge').textContent = runnerLabel;
      $('wizRunnerBadge').className = runnerBadgeCls;
    }
    $('navRunnerBadge').textContent = runner.running || runner.apiPolling ? 'ON' : 'OFF';
    $('navRunnerBadge').className = runner.running || runner.apiPolling ? 'nav-badge ok' : 'nav-badge';
    if (!remoteMode) {
      $('btnTogglePoller').textContent = runner.apiPolling ? '■ 폴러 중지' : '▶ 폴러 가동';
    }

    // Web Dashboard status
    $('sideWebStatus').textContent = webServer.running ? `ON (:${webServer.port})` : '꺼짐';
    $('lblWebUrl').textContent = webServer.running
      ? `실시간 접속 URL: ${webServer.url} (${webServer.readOnly ? '읽기 전용' : '원격 트리거 허용'})`
      : '원격 웹 대시보드 꺼짐';

    // Workflow summary
    if (workflow && workflow.summary) {
      $('wfStatusLine').textContent = `워크플로우 상태: ${workflow.summary}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal & Error Drawer Rendering
  // ---------------------------------------------------------------------------
  function renderTerminal() {
    const out = $('terminalOutput');
    const keyword = ($('txtLogFilter').value || '').trim().toLowerCase();
    const list = activeTermTab === 'error' ? errorLines : consoleLines;
    const filtered = keyword ? list.filter((l) => l.text.toLowerCase().includes(keyword)) : list;

    const frag = document.createDocumentFragment();
    for (const item of filtered.slice(-800)) {
      const div = document.createElement('div');
      div.className = `log-line ${item.level || 'info'}`;
      div.innerHTML = `<span class="log-ts">${escapeHtml(item.ts)}</span><span class="log-txt">${escapeHtml(item.text)}</span>`;
      frag.appendChild(div);
    }
    out.innerHTML = '';
    out.appendChild(frag);
    out.scrollTop = out.scrollHeight;

    $('termErrCount').textContent = String(errorLines.length);
    const navErr = $('navErrBadge');
    navErr.textContent = String(errorLines.length);
    navErr.style.display = errorLines.length > 0 ? 'inline-flex' : 'none';

    const drawer = $('errorDrawer');
    if (errorLines.length > 0 && activeTermTab === 'all') {
      drawer.style.display = 'block';
      $('errDrawerCount').textContent = `${errorLines.length}건`;
      $('errorDrawerBody').innerHTML = errorLines
        .slice(-20)
        .map((e) => `<div>[${escapeHtml(e.ts)}] ${escapeHtml(e.text)}</div>`)
        .join('');
    } else {
      drawer.style.display = 'none';
    }
  }

  function appendLineToDom(item, isError = false) {
    if (isError) {
      errorLines.push(item);
      if (errorLines.length > 400) errorLines.shift();
    } else {
      consoleLines.push(item);
      if (consoleLines.length > 2500) consoleLines.shift();
    }
    renderTerminal();
  }

  // ---------------------------------------------------------------------------
  // Packages & Retention View
  // ---------------------------------------------------------------------------
  function renderPackagesSummary(summary) {
    if (!summary) return;
    const maxStr = summary.retentionEnabled ? `${summary.maxRetained}개` : '∞';
    $('kpiPkgVal').textContent = `${summary.count} / ${maxStr}`;
    $('navPkgBadge').textContent = summary.retentionEnabled ? `${summary.count}/${summary.maxRetained}` : `${summary.count}`;

    const disk = summary.disk || {};
    const pct = disk.usedPercent || 0;
    const barCls = pct > 88 ? 'progress-fill danger' : pct > 75 ? 'progress-fill warn' : 'progress-fill';
    $('kpiDiskBar').style.width = `${pct}%`;
    $('kpiDiskBar').className = barCls;
    $('pkgDiskBar').style.width = `${pct}%`;
    $('pkgDiskBar').className = barCls;

    $('kpiDiskSub').textContent = `${disk.drive || 'C:'} 여유 ${formatBytes(disk.freeBytes)} / 전체 ${formatBytes(disk.totalBytes)} (패키지 ${formatBytes(summary.totalBytes)})`;
    $('pkgDiskLabel').textContent = `보관 중인 패키지: ${summary.count}개 · 총 ${formatBytes(summary.totalBytes)}`;
    $('pkgDiskFree').textContent = `${disk.drive || 'C:'} 사용률 ${pct}% (여유 ${formatBytes(disk.freeBytes)} / ${formatBytes(disk.totalBytes)})`;

    const tbody = $('pkgArchiveTableBody');
    if (!summary.items || summary.items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">아직 패키징된 빌드 폴더가 없습니다.</td></tr>';
      return;
    }

    tbody.innerHTML = summary.items
      .map(
        (item) => `
      <tr>
        <td><span class="mono-code">#${item.rank}</span></td>
        <td style="font-weight:600;">${escapeHtml(item.name)}</td>
        <td><span class="mono-code">${formatBytes(item.sizeBytes)}</span></td>
        <td style="color:var(--text-secondary);">${formatDateTime(item.createdAt)}</td>
        <td>
          ${
            item.willPruneNext
              ? '<span class="badge badge-amber">정리 대상 (초과)</span>'
              : '<span class="badge badge-green">보관 유지</span>'
          }
        </td>
        <td style="text-align:right; white-space:nowrap;">
          ${
            remoteMode
              ? '<span style="color:var(--text-muted); font-size:11.5px;">공유폴더 이용</span>'
              : `<button class="btn btn-sm pkg-open-btn" data-path="${escapeHtml(item.fullPath)}">열기</button>
                 <button class="btn btn-sm btn-danger pkg-del-btn" data-name="${escapeHtml(item.name)}">삭제</button>`
          }
        </td>
      </tr>`
      )
      .join('');

    tbody.querySelectorAll('.pkg-open-btn').forEach((b) => {
      b.addEventListener('click', () => api.invoke('system:openFolder', b.dataset.path));
    });
    tbody.querySelectorAll('.pkg-del-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm(`패키징 폴더 '${b.dataset.name}'을(를) 삭제하시겠습니까?`)) return;
        const res = await safeCall(() => api.invoke('packages:delete', b.dataset.name), '패키징 폴더를 삭제했습니다.');
        if (res && res.summary) renderPackagesSummary(res.summary);
      });
    });
  }

  async function refreshPackages() {
    const summary = await safeCall(() => api.invoke('packages:list'));
    if (summary) renderPackagesSummary(summary);
  }

  // ---------------------------------------------------------------------------
  // Perforce Mirror Feed & Author Map
  // ---------------------------------------------------------------------------
  async function refreshMirrorStatus() {
    const st = await safeCall(() => api.invoke('p4:mirrorStatus'));
    if (!st) return;
    const feed = $('assetLogFeed');
    if (!st.recentAssetLog || st.recentAssetLog.length === 0) {
      feed.innerHTML = '<div class="empty-state">기록된 에셋 변경 로그(.p4-sync/asset_changelog.md)가 아직 없습니다.</div>';
    } else {
      feed.innerHTML = st.recentAssetLog.map((line) => `<div class="feed-item">${escapeHtml(line)}</div>`).join('');
    }
  }

  async function refreshRecentCLs() {
    const res = await safeCall(() => api.invoke('p4:recentCLs', 12));
    const el = $('recentCLFeed');
    if (!res || !res.ok || !res.items.length) {
      el.innerHTML = `<div class="empty-state">${escapeHtml((res && res.error) || '조회된 CL이 없습니다.')}</div>`;
      return;
    }
    el.innerHTML = res.items
      .map(
        (c) => `
      <div class="feed-item" style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
        <div style="min-width:0;">
          <span class="badge badge-violet">CL #${c.cl}</span>
          <strong style="margin-left:6px;">${escapeHtml(c.user)}</strong>
          <span style="margin-left:6px; color:var(--text-secondary);">${escapeHtml(c.summary)}</span>
        </div>
        <span style="color:var(--text-muted); font-size:11px; flex-shrink:0;">${formatDateTime(c.time)}</span>
      </div>`
      )
      .join('');
  }

  function renderAuthorMap() {
    const tbody = $('authorMapBody');
    if (authorMapRows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">등록된 예외 매핑 없음 (기본적으로 p4 user -o 이메일 사용)</td></tr>';
      return;
    }
    tbody.innerHTML = authorMapRows
      .map(
        (row, i) => `
      <tr>
        <td><input class="input mono am-user" data-i="${i}" value="${escapeHtml(row.p4User)}" placeholder="p4_id" style="height:30px;" /></td>
        <td><input class="input am-name" data-i="${i}" value="${escapeHtml(row.name)}" placeholder="이름" style="height:30px;" /></td>
        <td><input class="input mono am-email" data-i="${i}" value="${escapeHtml(row.email)}" placeholder="user@github.com" style="height:30px;" /></td>
        <td><button class="btn btn-sm btn-danger am-del" data-i="${i}">✕</button></td>
      </tr>`
      )
      .join('');

    tbody.querySelectorAll('.am-user').forEach((inp) => inp.addEventListener('input', () => (authorMapRows[inp.dataset.i].p4User = inp.value)));
    tbody.querySelectorAll('.am-name').forEach((inp) => inp.addEventListener('input', () => (authorMapRows[inp.dataset.i].name = inp.value)));
    tbody.querySelectorAll('.am-email').forEach((inp) => inp.addEventListener('input', () => (authorMapRows[inp.dataset.i].email = inp.value)));
    tbody.querySelectorAll('.am-del').forEach((btn) =>
      btn.addEventListener('click', () => {
        authorMapRows.splice(Number(btn.dataset.i), 1);
        renderAuthorMap();
      })
    );
  }

  // ---------------------------------------------------------------------------
  // History View
  // ---------------------------------------------------------------------------
  function renderHistoryTable() {
    const q = ($('txtHistSearch').value || '').trim().toLowerCase();
    const list = historyItems.filter((item) => {
      if (historyFilter === 'FullPackage' && item.mode !== 'FullPackage') return false;
      if (historyFilter === 'QuickVerify' && item.mode !== 'QuickVerify') return false;
      if (historyFilter === 'error' && !item.hasErrors) return false;
      if (q && !`${item.id} ${item.ref} ${item.author} ${item.message}`.toLowerCase().includes(q)) return false;
      return true;
    });

    const tbody = $('historyTableBody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">조건에 맞는 빌드 히스토리가 없습니다.</td></tr>';
      return;
    }

    tbody.innerHTML = list
      .map(
        (h) => `
      <tr>
        <td>
          <div style="font-weight:600;">${escapeHtml(h.id)}</div>
          <div style="font-size:11.5px; color:var(--text-muted);">${escapeHtml(h.message || formatDateTime(h.createdAt))}</div>
        </td>
        <td><span class="badge ${h.mode === 'FullPackage' ? 'badge-blue' : 'badge-violet'}">${escapeHtml(h.mode)}</span></td>
        <td><span class="mono-code">${escapeHtml(h.ref || '-')}</span></td>
        <td>${escapeHtml(h.author || '-')}</td>
        <td>${h.hasErrors ? '<span class="badge badge-rose">에러 있음</span>' : '<span class="badge badge-green">정상</span>'}</td>
        <td style="text-align:right; white-space:nowrap;">
          ${h.hasFullLog ? `<button class="btn btn-sm hist-log-btn" data-file="${escapeHtml(h.fullLogPath)}" data-title="전체 로그 — ${escapeHtml(h.id)}">전체 로그</button>` : ''}
          ${h.hasErrors ? `<button class="btn btn-sm btn-danger hist-log-btn" data-file="${escapeHtml(h.errorLogPath)}" data-title="에러 요약 — ${escapeHtml(h.id)}">에러 요약</button>` : ''}
          ${remoteMode ? '' : `<button class="btn btn-sm hist-dir-btn" data-dir="${escapeHtml(h.fullPath)}">폴더</button>`}
        </td>
      </tr>`
      )
      .join('');

    tbody.querySelectorAll('.hist-log-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await safeCall(() => api.invoke('history:readLog', btn.dataset.file));
        if (!res) return;
        $('modalViewerTitle').textContent = btn.dataset.title;
        $('modalViewerContent').textContent = res.content;
        openModal('modalViewer');
      });
    });
    tbody.querySelectorAll('.hist-dir-btn').forEach((btn) => {
      btn.addEventListener('click', () => api.invoke('system:openFolder', btn.dataset.dir));
    });
  }

  async function refreshHistory() {
    const items = await safeCall(() => api.invoke('history:list'));
    if (items) {
      historyItems = items;
      renderHistoryTable();
    }
  }

  // ---------------------------------------------------------------------------
  // GitHub Branches & Repo Picker
  // ---------------------------------------------------------------------------
  async function refreshBranches() {
    if (remoteMode) return;
    const branches = await safeCall(() => api.invoke('github:branches'));
    const sel = $('selBranch');
    sel.innerHTML = '';
    const list = branches && branches.length ? branches : [cfg.LastBranch || 'main'];
    for (const b of list) {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      if (b === cfg.LastBranch) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function renderRepoList() {
    const q = ($('txtRepoSearch').value || '').trim().toLowerCase();
    const list = loadedRepos.filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
    const el = $('modalRepoList');
    if (list.length === 0) {
      el.innerHTML = '<div class="empty-state">검색 결과가 없습니다.</div>';
      return;
    }
    el.innerHTML = list
      .map(
        (r) => `
      <div class="repo-item ${selectedRepo && selectedRepo.fullName === r.fullName ? 'selected' : ''}" data-name="${escapeHtml(r.fullName)}">
        <div>
          <div style="font-weight:600;">${escapeHtml(r.fullName)} ${r.isPrivate ? '<span class="badge badge-amber">Private</span>' : '<span class="badge badge-slate">Public</span>'}</div>
          <div style="font-size:11.5px; color:var(--text-muted);">${escapeHtml(r.description || `기본 브랜치: ${r.defaultBranch}`)}</div>
        </div>
        <span class="badge ${r.canAdmin ? 'badge-green' : 'badge-slate'}">${r.canAdmin ? 'Admin' : 'Member'}</span>
      </div>`
      )
      .join('');

    el.querySelectorAll('.repo-item').forEach((row) => {
      row.addEventListener('click', () => {
        selectedRepo = loadedRepos.find((x) => x.fullName === row.dataset.name) || null;
        $('btnConfirmRepo').disabled = !selectedRepo;
        renderRepoList();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Event Wiring
  // ---------------------------------------------------------------------------
  // Dashboard actions
  $('btnDashRefresh').addEventListener('click', () => bootstrap(true));
  $('btnDashOpenLogs').addEventListener('click', () => api.invoke('system:openFolder', `${cfg.ArchiveRoot || 'C:\\BuildArchive'}\\Logs`));
  $('btnDashOpenPkgs').addEventListener('click', () => api.invoke('system:openFolder', `${cfg.ArchiveRoot || 'C:\\BuildArchive'}\\Packages`));
  $('btnSideOpenArchive').addEventListener('click', () => api.invoke('system:openFolder', cfg.ArchiveRoot || 'C:\\BuildArchive'));

  $('btnSyncSource').addEventListener('click', async () => {
    await safeCall(() => api.invoke('build:sync', { branch: $('selBranch').value || cfg.LastBranch || 'main' }), '소스 동기화가 완료되었습니다.');
  });
  $('btnQuickVerify').addEventListener('click', async () => {
    await safeCall(() => api.invoke('build:start', { mode: 'QuickVerify', branch: $('selBranch').value || cfg.LastBranch || 'main' }));
  });
  $('btnFullPackage').addEventListener('click', async () => {
    await safeCall(() => api.invoke('build:start', { mode: 'FullPackage', branch: $('selBranch').value || cfg.LastBranch || 'main' }));
  });
  $('btnStopBuild').addEventListener('click', async () => {
    await safeCall(() => api.invoke('build:stop'), '빌드 중단 요청을 보냈습니다.');
  });
  $('btnMirrorQuick').addEventListener('click', async () => {
    const r = await safeCall(() => api.invoke('p4:mirrorRun'));
    if (r) {
      toast(r.ok ? 'P4 → GitHub 미러링 완료!' : r.message || '미러링 중 오류 발생', r.ok ? 'success' : 'error');
      refreshMirrorStatus();
    }
  });

  // Terminal toolbar
  $('tabTermAll').addEventListener('click', () => {
    activeTermTab = 'all';
    $('tabTermAll').classList.add('active');
    $('tabTermErr').classList.remove('active');
    renderTerminal();
  });
  $('tabTermErr').addEventListener('click', () => {
    activeTermTab = 'error';
    $('tabTermErr').classList.add('active');
    $('tabTermAll').classList.remove('active');
    renderTerminal();
  });
  $('txtLogFilter').addEventListener('input', renderTerminal);
  $('btnClearLog').addEventListener('click', () => api.invoke('console:clear'));
  $('btnCopyLog').addEventListener('click', async () => {
    const text = (activeTermTab === 'error' ? errorLines : consoleLines).map((l) => `[${l.ts}] ${l.text}`).join('\n');
    await navigator.clipboard.writeText(text);
    toast('콘솔 로그가 클립보드에 복사되었습니다.', 'success');
  });
  $('btnSendReportManual').addEventListener('click', async () => {
    await safeCall(() => api.invoke('notify:sendManual'), 'Slack/Discord 리포트를 전송했습니다.');
  });

  // Packaging & Retention controls
  $('chkEnableRetention').addEventListener('change', () => {
    updateRetentionUIState();
    saveCurrentConfig(false);
  });
  $('numMaxPackages').addEventListener('change', () => {
    const clamped = Math.max(1, Math.min(200, Number($('numMaxPackages').value) || 10));
    $('numMaxPackages').value = clamped;
    updateRetentionUIState();
    saveCurrentConfig(false);
  });
  $('btnRetainMinus').addEventListener('click', () => {
    const cur = Number($('numMaxPackages').value) || 10;
    $('numMaxPackages').value = Math.max(1, cur - 1);
    updateRetentionUIState();
    saveCurrentConfig(false);
  });
  $('btnRetainPlus').addEventListener('click', () => {
    const cur = Number($('numMaxPackages').value) || 10;
    $('numMaxPackages').value = Math.min(200, cur + 1);
    updateRetentionUIState();
    saveCurrentConfig(false);
  });
  document.querySelectorAll('.retain-preset').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('numMaxPackages').value = Number(chip.dataset.val);
      updateRetentionUIState();
      saveCurrentConfig(false);
    });
  });
  $('btnPruneNow').addEventListener('click', async () => {
    const res = await safeCall(() => api.invoke('packages:pruneNow'));
    if (res) {
      if (res.skipped) toast('보관 개수 제한이 꺼져 있어 정리하지 않았습니다.', 'info');
      else if (res.pruned.length === 0) toast('초과된 오래된 패키지가 없습니다.', 'info');
      else toast(`오래된 패키지 ${res.pruned.length}개 정리 완료 (${formatBytes(res.freedBytes)} 확보)`, 'success');
      if (res.summary) renderPackagesSummary(res.summary);
    }
  });

  document.querySelectorAll('#clientConfigCards .option-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('#clientConfigCards .option-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      saveCurrentConfig(false);
    });
  });
  $('btnSavePkgTab').addEventListener('click', () => saveCurrentConfig(true));
  $('btnManualLauncher').addEventListener('click', async () => {
    const res = await safeCall(() => api.invoke('build:makeLauncherManual'));
    if (res && !res.canceled) {
      toast(res.ok ? '게임 옵션 런처(_Launcher.exe) 생성 완료!' : res.message || '런처 생성 실패', res.ok ? 'success' : 'error');
    }
  });

  // Perforce & Mirror controls
  document.querySelectorAll('#vcsModeSegmented button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#vcsModeSegmented button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      saveCurrentConfig(false);
    });
  });
  $('btnSaveP4Tab').addEventListener('click', () => saveCurrentConfig(true));
  $('chkP4AutoMirror').addEventListener('change', () => saveCurrentConfig(false));

  $('btnP4Test').addEventListener('click', async () => {
    await saveCurrentConfig(false);
    const res = await safeCall(() => api.invoke('p4:test'));
    const box = $('p4DiagBox');
    if (!res) return;
    box.style.display = 'block';
    if (res.ok) {
      box.innerHTML = `
        <div style="color:#34d399; font-weight:700;">✔ Perforce 서버 연결 성공 (${escapeHtml(res.serverAddress || cfg.P4Port)})</div>
        <div style="margin-top:4px;">• 버전: ${escapeHtml(res.serverVersion)} · Unicode: <strong>${res.unicodeMode ? '활성화됨' : '미감지'}</strong>${res.serverUptime ? ` · 가동시간: ${escapeHtml(res.serverUptime)}` : ''}</div>
        <div>• 티켓 상태: ${res.ticketOk ? `<span style="color:#34d399;">유효 (${escapeHtml(res.ticketMessage)})</span>` : `<span style="color:#fbbf24;">확인 필요 (${escapeHtml(res.ticketMessage)})</span>`}</div>
        ${res.serverRoot ? `<div>• 실제 P4ROOT: <code>${escapeHtml(res.serverRoot)}</code></div>` : ''}
        <div>• 빌드 Root: <code>${escapeHtml(res.buildRoot || '미조회')}</code> / 미러 Root: <code>${escapeHtml(res.mirrorRoot || '미조회')}</code></div>`;
      if (res.buildRoot && !cfg.ProjectDir) {
        $('txtProjectDir').value = res.buildRoot;
        await saveCurrentConfig(false);
        toast('빌드 워크스페이스 Root가 프로젝트 경로로 자동 반영되었습니다.', 'info');
      }
    } else {
      box.innerHTML = `<div style="color:#fb7185; font-weight:700;">✖ Perforce 연결 실패</div><div style="margin-top:4px;">${escapeHtml(res.rawError)}</div>`;
    }
  });

  $('btnMirrorNow').addEventListener('click', async () => {
    await saveCurrentConfig(false);
    const r = await safeCall(() => api.invoke('p4:mirrorRun'));
    if (r) {
      toast(r.ok ? 'P4 → GitHub 미러링 성공!' : r.message || '미러링 실패 (콘솔 확인)', r.ok ? 'success' : 'error');
      refreshMirrorStatus();
    }
  });
  $('btnMirrorDryRun').addEventListener('click', async () => {
    await saveCurrentConfig(false);
    await safeCall(() => api.invoke('p4:mirrorRun', { dryRun: true }), 'DryRun 완료 — 대시보드 콘솔에서 대상 CL을 확인하세요.');
  });
  $('btnMirrorInitWm').addEventListener('click', async () => {
    if (!confirm('현재 Perforce 최신 CL을 시작 워터마크로 지정할까요? (이후 올라오는 CL부터 미러링됩니다)')) return;
    await saveCurrentConfig(false);
    await safeCall(() => api.invoke('p4:mirrorRun', { initWatermark: true }), '초기 워터마크 설정 완료!');
    refreshMirrorStatus();
  });
  $('btnRegMirrorTask').addEventListener('click', async () => {
    await saveCurrentConfig(false);
    const r = await safeCall(() => api.invoke('p4:registerMirrorTask'));
    if (r) toast(r.ok ? 'Windows 작업 스케줄러 등록 완료!' : r.message, r.ok ? 'success' : 'error');
  });
  $('btnUnregMirrorTask').addEventListener('click', async () => {
    const r = await safeCall(() => api.invoke('p4:unregisterMirrorTask'));
    if (r) toast(r.ok ? '미러링 작업 스케줄러 해제 완료' : r.message, r.ok ? 'info' : 'error');
  });

  $('btnRefreshMirrorFeed').addEventListener('click', refreshMirrorStatus);
  $('btnRefreshP4CLs').addEventListener('click', refreshRecentCLs);

  $('btnAddAuthorRow').addEventListener('click', () => {
    authorMapRows.push({ p4User: '', name: '', email: '' });
    renderAuthorMap();
  });
  $('btnSaveAuthorMap').addEventListener('click', async () => {
    const saved = await safeCall(() => api.invoke('config:authorMap:save', authorMapRows), 'author_map.json 저장 완료!');
    if (saved) {
      authorMapRows = saved;
      renderAuthorMap();
    }
  });

  $('btnRunBackupNow').addEventListener('click', async () => {
    await saveCurrentConfig(false);
    const adminUser = $('txtBackupAdmin').value.trim() || 'admin';
    const r = await safeCall(() => api.invoke('p4:backupRun', { adminUser }));
    if (r) toast(r.ok ? 'Perforce 백업 완료!' : '백업 오류 — 대시보드 콘솔 확인', r.ok ? 'success' : 'error');
  });
  $('btnRegBackupTask').addEventListener('click', async () => {
    await saveCurrentConfig(false);
    const time = $('txtBackupTime').value.trim() || '04:00';
    const adminUser = $('txtBackupAdmin').value.trim() || 'admin';
    const r = await safeCall(() => api.invoke('p4:registerBackupTask', { time, adminUser }));
    if (r) toast(r.ok ? `매일 ${time} 백업 스케줄러 등록 완료!` : r.message, r.ok ? 'success' : 'error');
  });

  // GitHub & Runner controls
  $('btnOpenRepoPicker').addEventListener('click', () => {
    $('txtModalGhToken').value = cfg.GitHubAccessToken || '';
    openModal('modalRepo');
  });
  $('btnOpenPatPage').addEventListener('click', () => {
    api.invoke('system:openExternal', 'https://github.com/settings/tokens/new?description=BuildServerKit_Studio&scopes=repo,workflow,read:org');
  });
  $('btnUseGhCli').addEventListener('click', async () => {
    const r = await safeCall(() => api.invoke('github:ghToken'));
    if (r && r.ok) {
      $('txtModalGhToken').value = r.token;
      toast('GitHub CLI 토큰을 가져왔습니다!', 'success');
      $('btnModalLoadRepos').click();
    } else if (r) {
      toast(r.error, 'error');
    }
  });
  $('btnModalLoadRepos').addEventListener('click', async () => {
    const token = $('txtModalGhToken').value.trim();
    const res = await safeCall(() => api.invoke('github:fetchRepos', token));
    if (!res) return;
    loadedRepos = res.repos || [];
    selectedRepo = loadedRepos.find((r) => r.fullName === cfg.ConnectedRepoFullName) || null;
    $('btnConfirmRepo').disabled = !selectedRepo;
    renderRepoList();
    toast(`${res.user.login} 계정의 저장소 ${loadedRepos.length}개를 불러왔습니다.`, 'success');
  });
  $('txtRepoSearch').addEventListener('input', renderRepoList);
  $('btnConfirmRepo').addEventListener('click', async () => {
    if (!selectedRepo) return;
    const token = $('txtModalGhToken').value.trim();
    const updated = await safeCall(
      () =>
        api.invoke('config:save', {
          GitHubAccessToken: token,
          ConnectedRepoFullName: selectedRepo.fullName,
          GitRemoteUrl: selectedRepo.cloneUrl,
          GitHubRepoUrl: selectedRepo.htmlUrl,
          LastBranch: selectedRepo.defaultBranch || 'main',
        }),
      `저장소 '${selectedRepo.fullName}' 연결 완료!`
    );
    if (updated) {
      cfg = updated;
      hydrateConfigToUI();
      closeModal('modalRepo');
      refreshBranches();
      $('btnScanWorkflow').click();
      if ($('modalWizard')?.classList.contains('open')) {
        syncWizardFieldsFromConfig();
      }
    }
  });

  $('btnRefreshBranches').addEventListener('click', refreshBranches);
  $('btnOpenGhWeb').addEventListener('click', () => {
    if (!cfg.GitHubRepoUrl) return toast('먼저 저장소를 연결해 주세요.', 'error');
    api.invoke('system:openExternal', `${cfg.GitHubRepoUrl}/actions`);
  });
  $('btnScanWorkflow').addEventListener('click', async () => {
    const res = await safeCall(() => api.invoke('github:scanWorkflow', $('selBranch').value || cfg.LastBranch || 'main'));
    if (!res) return;
    $('wfStatusLine').textContent = `워크플로우 상태: ${res.summary}`;
    const runsEl = $('recentRunsList');
    if (!res.recentRuns || res.recentRuns.length === 0) {
      runsEl.innerHTML = '<div class="empty-state">최근 Actions 실행 기록이 없습니다.</div>';
    } else {
      runsEl.innerHTML = res.recentRuns
        .map(
          (r) => `
        <div class="feed-item" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <span class="badge ${r.conclusion === 'success' ? 'badge-green' : r.conclusion === 'failure' ? 'badge-rose' : 'badge-blue'}">${escapeHtml(r.conclusion || r.status)}</span>
            <span style="margin-left:6px;">${escapeHtml(r.title)}</span>
          </div>
          <span style="color:var(--text-muted); font-size:11px; flex-shrink:0;">${formatDateTime(r.createdAt)}</span>
        </div>`
        )
        .join('');
    }
  });
  $('btnPushWorkflow').addEventListener('click', async () => {
    const branch = $('selBranch').value || cfg.LastBranch || 'main';
    const tplType = $('selWorkflowTemplate').value;
    if (!confirm(`'${branch}' 브랜치에 ${tplType === 'perforce' ? 'Perforce 하이브리드' : 'Git 단독'} build.yml을 등록(Push)할까요?`)) return;
    await safeCall(() => api.invoke('github:pushWorkflow', { branch, templateType: tplType }), 'build.yml 원클릭 등록 완료!');
    $('btnScanWorkflow').click();
  });
  $('btnPreviewWorkflow').addEventListener('click', async () => {
    const tplType = $('selWorkflowTemplate').value;
    const tpl = await safeCall(() => api.invoke('github:workflowTemplate', tplType));
    if (!tpl) return;
    $('modalViewerTitle').textContent = `워크플로우 템플릿 — ${tpl.fileName}`;
    $('modalViewerContent').textContent = tpl.content;
    openModal('modalViewer');
  });

  $('btnRunnerDownload').addEventListener('click', () => safeCall(() => api.invoke('runner:download'), 'Runner 다운로드 및 압축 해제 완료!'));
  $('btnRunnerRegister').addEventListener('click', () => safeCall(() => api.invoke('runner:register'), 'Runner 등록이 완료되었습니다!'));
  $('btnRunnerStart').addEventListener('click', () => safeCall(() => api.invoke('runner:start'), 'Self-Hosted Runner 가동을 시작했습니다!'));
  $('btnRunnerStop').addEventListener('click', () => safeCall(() => api.invoke('runner:stop'), 'Runner를 중지했습니다.'));
  $('btnTogglePoller').addEventListener('click', () => safeCall(() => api.invoke('runner:togglePoller')));

  $('btnInitDirs').addEventListener('click', async () => {
    const r = await safeCall(() => api.invoke('system:initDirs'));
    if (r) toast(`폴더 세팅 및 스크립트 ${r.deployed.length}종 배치 완료!`, 'success');
  });
  $('btnCloneRepo').addEventListener('click', async () => {
    const r = await safeCall(() => api.invoke('github:clone'));
    if (r) toast(r.alreadyExists ? `이미 클론됨: ${r.targetDir}` : `클론 완료: ${r.targetDir}`, 'success');
  });
  $('btnLinkAssets').addEventListener('click', async () => {
    const r = await safeCall(() => api.invoke('assets:link'), '.gitignore 제외 에셋 심볼릭 링크 점검 완료!');
    if (r && r.items) {
      $('assetJunctionList').innerHTML =
        r.items.length === 0
          ? '<div class="empty-state">.gitignore에 제외된 Content/ 경로가 없습니다.</div>'
          : r.items.map((i) => `<div class="feed-item">${i.linked ? '✔' : '○'} ${escapeHtml(i.relPath)} → ${escapeHtml(i.sourceDir)}</div>`).join('');
    }
  });

  // History filters
  $('btnRefreshHistory').addEventListener('click', refreshHistory);
  $('txtHistSearch').addEventListener('input', renderHistoryTable);
  document.querySelectorAll('#histFilterChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#histFilterChips .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      historyFilter = chip.dataset.filter;
      renderHistoryTable();
    });
  });

  // Settings & Notifications
  $('btnSaveAllSettings').addEventListener('click', () => saveCurrentConfig(true));
  $('chkWebEnabled').addEventListener('change', () => saveCurrentConfig(true));
  $('chkWebReadOnly').addEventListener('change', () => saveCurrentConfig(true));
  $('chkMinimizeToTray')?.addEventListener('change', () => saveCurrentConfig(true));
  $('btnTestDiscord').addEventListener('click', async () => {
    await saveCurrentConfig(false);
    const r = await safeCall(() => api.invoke('notify:testDiscord'));
    if (r) toast(r.message, r.ok ? 'success' : 'error');
  });
  $('btnTestSlack').addEventListener('click', async () => {
    await saveCurrentConfig(false);
    const r = await safeCall(() => api.invoke('notify:testSlack'));
    if (r) toast(r.message, r.ok ? 'success' : 'error');
  });
  $('btnDetectIp').addEventListener('click', async () => {
    const net = await safeCall(() => api.invoke('system:network'));
    if (!net) return;
    $('txtTailscaleIp').value = net.recommended;
    await saveCurrentConfig(false);
    toast(
      net.tailscaleIp ? `Tailscale IP 감지됨: ${net.tailscaleIp}` : `로컬 IPv4 감지됨: ${net.recommended}`,
      'success'
    );
  });
  $('btnCopyWebUrl').addEventListener('click', async () => {
    const url = appState?.webServer?.url;
    if (!url) return toast('먼저 원격 웹 대시보드를 활성화해 주세요.', 'info');
    await navigator.clipboard.writeText(url);
    toast(`URL 복사됨: ${url}`, 'success');
  });
  $('btnViewerCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('modalViewerContent').textContent || '');
    toast('클립보드에 복사되었습니다.', 'success');
  });

  document.querySelectorAll('.pick-folder-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = $(btn.dataset.target);
      const picked = await api.invoke('system:pickFolder', target.value);
      if (picked) target.value = picked;
    });
  });

  $('btnFactoryReset').addEventListener('click', async () => {
    if (!confirm('모든 GitHub/Slack/Discord 토큰과 개인 경로를 완전히 초기화하시겠습니까?')) return;
    const resetCfg = await safeCall(() => api.invoke('config:factoryReset'), '모든 설정이 배포용 초기 상태로 초기화되었습니다.');
    if (resetCfg) {
      cfg = resetCfg;
      hydrateConfigToUI();
    }
  });

  // Live Event Subscriptions
  api.on('snapshot', (snap) => {
    appState = snap.state;
    consoleLines = snap.consoleLines || [];
    errorLines = snap.errorLines || [];
    renderState();
    renderTerminal();
  });
  api.on('state:update', ({ section, data }) => {
    if (!appState) return;
    appState[section] = data;
    renderState();
  });
  api.on('console:line', (entry) => appendLineToDom(entry, false));
  api.on('console:error', (entry) => appendLineToDom(entry, true));
  api.on('console:clear', () => {
    consoleLines = [];
    errorLines = [];
    renderTerminal();
  });
  api.on('packages:updated', (summary) => renderPackagesSummary(summary));

  // ---------------------------------------------------------------------------
  // Perforce End-to-End GUI Install & One-Click Provisioning
  // ---------------------------------------------------------------------------
  function setProvPill(id, ok, okLabel, pendingLabel) {
    const el = $(id);
    if (!el) return;
    el.className = ok ? 'prov-pill ok' : 'prov-pill';
    el.textContent = ok ? `✔ ${okLabel}` : `○ ${pendingLabel || okLabel}`;
  }

  async function refreshProvStatus() {
    if (remoteMode) return;
    const adminInput = $('txtProvAdminUser')?.value.trim() || '';
    const st = await safeCall(() => api.invoke('p4prov:status', { adminUser: adminInput }));
    if (!st) return;

    setProvPill('ppCli', st.p4CliInstalled, 'P4 CLI 설치됨', 'P4 CLI 미설치');
    setProvPill('ppService', st.serverReachable || st.serviceRunning, 'P4D 실행 중', st.serviceInstalled ? 'P4D 중지됨' : 'P4D 미설치');
    setProvPill('ppUnicode', st.unicodeEnabled, 'Unicode ON', 'Unicode OFF');
    setProvPill('ppFirewall', st.firewallOpen, '방화벽(1666) 열림', '방화벽 미개방');
    setProvPill(
      'ppAdmin',
      st.adminLoggedIn,
      `관리자 로그인(${st.adminUser})`,
      st.serverReachable && st.adminUser ? `관리자 세션 만료(${st.adminUser})` : '관리자 로그인 필요'
    );
    setProvPill('ppStream', st.streamExists, 'Stream 디포 준비됨', 'Stream 미생성');
    setProvPill('ppTypemap', st.typemapApplied, 'UE5 Typemap(+l) 적용됨', 'Typemap 미적용');
    setProvPill('ppBot', st.botTicketValid, `봇 티켓 유효(${cfg.P4User || 'p4bot'})`, '봇 티켓 미발급');
    setProvPill('ppWorkspaces', st.buildClientExists && st.mirrorClientExists, '빌드/미러 워크스페이스 완료', '워크스페이스 미생성');
    setProvPill('ppIgnore', st.p4ignoreExists, '.p4ignore 준비됨', '.p4ignore 미생성');

    if (!$('txtProvAdminUser').value.trim() && st.adminUser) {
      $('txtProvAdminUser').value = st.adminUser;
    }
    const streamParts = (cfg.P4Stream || '//MyProject/main').replace(/^\/\//, '').split('/');
    if (streamParts[0] && $('txtProvDepot').value === 'MyProject') {
      $('txtProvDepot').value = streamParts[0];
    }
    if (streamParts[1]) {
      $('txtProvStreamLeaf').value = streamParts[1];
    }
  }

  function generateStrongBotPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
    let pw = 'P4b!';
    for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    return pw;
  }

  async function withBusyButton(btnId, busyText, fn) {
    const btn = $(btnId);
    const orig = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = busyText;
    }
    try {
      return await fn();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = orig;
      }
    }
  }

  $('btnProvRefresh')?.addEventListener('click', refreshProvStatus);
  $('btnProvGenPass')?.addEventListener('click', () => {
    const pw = generateStrongBotPassword();
    $('txtProvBotPass').type = 'text';
    $('txtProvBotPass').value = pw;
    navigator.clipboard.writeText(pw).catch(() => {});
    toast('강력한 p4bot 비밀번호를 생성하고 클립보드에 복사했습니다!', 'success');
  });

  $('btnProvInstallP4D')?.addEventListener('click', () =>
    withBusyButton('btnProvInstallP4D', '다운로드 중...', async () => {
      const r = await safeCall(() => api.invoke('p4prov:installP4D'));
      if (r && r.ok) {
        toast('Helix Core Server(P4D) 공식 설치 창을 실행했습니다. 설치 완료 후 [세팅 상태 점검]을 누르세요.', 'success');
      }
    })
  );

  $('btnProvInstallP4V')?.addEventListener('click', () =>
    withBusyButton('btnProvInstallP4V', 'winget 설치 중...', async () => {
      toast('winget으로 Perforce P4V + P4 CLI 설치를 시작합니다...', 'info');
      const r = await safeCall(() => api.invoke('p4prov:installP4V'));
      if (r) {
        toast(r.ok ? 'P4V + P4 CLI 설치 완료!' : `설치 종료 (ExitCode=${r.code})`, r.ok ? 'success' : 'error');
        await refreshProvStatus();
      }
    })
  );

  $('btnProvUnicode')?.addEventListener('click', () =>
    withBusyButton('btnProvUnicode', 'UAC 실행 중...', async () => {
      const r = await safeCall(() => api.invoke('p4prov:enableUnicode', { p4Root: $('txtP4DepotRoot').value.trim() }));
      if (r) {
        toast(r.message, r.ok ? 'success' : 'error');
        await refreshProvStatus();
      }
    })
  );

  $('btnProvFirewall')?.addEventListener('click', () =>
    withBusyButton('btnProvFirewall', 'UAC 실행 중...', async () => {
      const r = await safeCall(() => api.invoke('p4prov:openFirewall'));
      if (r) {
        toast(r.message, r.ok ? 'success' : 'error');
        await refreshProvStatus();
      }
    })
  );

  $('btnProvAdminLogin')?.addEventListener('click', () =>
    withBusyButton('btnProvAdminLogin', '로그인 중...', async () => {
      const user = $('txtProvAdminUser').value.trim();
      const password = $('txtProvAdminPass').value;
      const r = await safeCall(() => api.invoke('p4prov:login', { user, password }));
      if (r && r.ok) {
        $('txtProvAdminPass').value = '';
        toast(r.message, 'success');
        await refreshProvStatus();
      }
    })
  );

  $('btnProvStream')?.addEventListener('click', () =>
    withBusyButton('btnProvStream', '생성 중...', async () => {
      const adminUser = $('txtProvAdminUser').value.trim();
      const depotName = $('txtProvDepot').value.trim();
      const streamName = $('txtProvStreamLeaf').value.trim() || 'main';
      const r = await safeCall(() => api.invoke('p4prov:setupStream', { adminUser, depotName, streamName }));
      if (r && r.ok) {
        cfg = await api.invoke('config:get');
        hydrateConfigToUI();
        toast(r.message, 'success');
        await refreshProvStatus();
      }
    })
  );

  $('btnProvTypemap')?.addEventListener('click', () =>
    withBusyButton('btnProvTypemap', '적용 중...', async () => {
      const adminUser = $('txtProvAdminUser').value.trim();
      const r = await safeCall(() => api.invoke('p4prov:applyTypemap', { adminUser }));
      if (r && r.ok) {
        toast(r.message, 'success');
        await refreshProvStatus();
      }
    })
  );

  $('btnProvBot')?.addEventListener('click', () =>
    withBusyButton('btnProvBot', '봇 세팅 중...', async () => {
      const adminUser = $('txtProvAdminUser').value.trim();
      const botPassword = $('txtProvBotPass').value || generateStrongBotPassword();
      if (!$('txtProvBotPass').value) $('txtProvBotPass').value = botPassword;
      const r = await safeCall(() => api.invoke('p4prov:setupBot', { adminUser, botUser: 'p4bot', botPassword }));
      if (r && r.ok) {
        cfg = await api.invoke('config:get');
        hydrateConfigToUI();
        toast(r.message, 'success');
        await refreshProvStatus();
      }
    })
  );

  $('btnProvWorkspaces')?.addEventListener('click', () =>
    withBusyButton('btnProvWorkspaces', '생성 중...', async () => {
      const adminUser = $('txtProvAdminUser').value.trim();
      const depot = $('txtProvDepot').value.trim() || 'MyProject';
      const leaf = $('txtProvStreamLeaf').value.trim() || 'main';
      const r = await safeCall(() =>
        api.invoke('p4prov:createWorkspaces', {
          adminUser,
          stream: `//${depot}/${leaf}`,
          buildClient: $('txtP4BuildClient').value.trim() || 'ws-build-full',
          mirrorClient: $('txtP4MirrorClient').value.trim() || 'ws-mirror-code',
          mirrorRoot: $('txtP4MirrorDir').value.trim() || 'C:\\BuildSystem\\P4MirrorRepo',
        })
      );
      if (r && r.ok) {
        cfg = await api.invoke('config:get');
        hydrateConfigToUI();
        toast(r.message, 'success');
        await refreshProvStatus();
      }
    })
  );

  $('btnProvIgnore')?.addEventListener('click', () =>
    withBusyButton('btnProvIgnore', '생성 중...', async () => {
      const r = await safeCall(() => api.invoke('p4prov:createP4Ignore', { targetDir: cfg.ProjectDir }));
      if (r && r.ok) {
        toast(r.message, 'success');
        await refreshProvStatus();
      }
    })
  );

  $('btnProvRunAll')?.addEventListener('click', () =>
    withBusyButton('btnProvRunAll', '⚡ 일괄 세팅 진행 중...', async () => {
      const adminUser = $('txtProvAdminUser').value.trim();
      const depotName = $('txtProvDepot').value.trim();
      const streamName = $('txtProvStreamLeaf').value.trim() || 'main';
      const createBot = $('chkProvCreateBot').checked;
      let botPassword = $('txtProvBotPass').value;
      if (createBot && !botPassword) {
        botPassword = generateStrongBotPassword();
        $('txtProvBotPass').value = botPassword;
      }
      if (!adminUser) return toast('먼저 관리자 Perforce 아이디를 입력하고 로그인해 주세요.', 'error');
      if (!depotName) return toast('프로젝트 Stream 디포 이름을 입력해 주세요.', 'error');

      const r = await safeCall(() =>
        api.invoke('p4prov:runAll', { adminUser, depotName, streamName, botUser: 'p4bot', botPassword, createBot })
      );
      if (r && r.ok) {
        cfg = await api.invoke('config:get');
        hydrateConfigToUI();
        toast('🎉 Perforce 서버 전체 원클릭 세팅 완료! (Stream + Typemap + 봇 + 워크스페이스 + .p4ignore)', 'success');
        await refreshProvStatus();
        await refreshTeamTab();
      }
    })
  );

  // ---------------------------------------------------------------------------
  // Team & Perforce Account Management Tab (GitHub Profile Auto-Fill)
  // ---------------------------------------------------------------------------
  let teamP4State = { connected: false, users: [], userCount: 0, workspaceCount: 0, activeSystemUser: '', noAutoCreateLocked: false };
  let lastLookedUpGh = null;
  let editingExistingP4Id = '';
  let lastAutoFilledP4Id = '';

  function clearTeamForm() {
    $('txtTeamGhUrl').value = '';
    $('txtTeamP4Id').value = '';
    $('txtTeamName').value = '';
    $('txtTeamEmail').value = '';
    $('txtTeamPasswd').value = '';
    lastLookedUpGh = null;
    editingExistingP4Id = '';
    lastAutoFilledP4Id = '';
    $('teamGhPreview').classList.remove('visible');
  }

  function showGhPreviewCard(profile) {
    lastLookedUpGh = profile;
    if (!profile) {
      $('teamGhPreview').classList.remove('visible');
      return;
    }
    $('imgTeamGhAvatar').src = profile.avatarUrl || '';
    $('lblTeamGhName').textContent = profile.name || profile.login;
    $('lblTeamGhLogin').textContent = `@${profile.login}`;

    const badge = $('badgeTeamEmailSource');
    const note = $('lblTeamEmailNote');
    if (profile.emailSource === 'public_profile') {
      badge.textContent = '✔ 공개 프로필 이메일';
      badge.className = 'badge badge-green';
      note.textContent = `GitHub 공개 이메일(${profile.email})을 불러왔습니다. 필요 시 아래 칸에서 직접 수정할 수 있습니다.`;
    } else if (profile.emailSource === 'public_commit') {
      badge.textContent = '✔ 최근 커밋 이메일 감지';
      badge.className = 'badge badge-blue';
      note.textContent = `최근 공개 커밋 기록에서 이메일(${profile.email})을 찾았습니다. GitHub 등록 이메일과 다른 경우 직접 수정하세요.`;
    } else {
      badge.textContent = 'ℹ 비공개 이메일 → 잔디용 noreply 자동 생성';
      badge.className = 'badge badge-violet';
      note.textContent = `이메일이 비공개여서 GitHub 공식 잔디용 주소(${profile.noreplyEmail})를 자동 입력했습니다. 본인 실제 이메일로 바꿔도 됩니다.`;
    }
    $('teamGhPreview').classList.add('visible');
  }

  function buildTeammateInviteGuide(p4Id, displayName) {
    const ip = cfg.TailscaleIP || '<노트북_Tailscale_IP>';
    const port = (cfg.P4Port || 'localhost:1666').split(':').pop() || '1666';
    const stream = cfg.P4Stream || '//MyProject/main';
    const webUrl = appState?.webServer?.running ? appState.webServer.url : `http://${ip}:${cfg.RemoteWebDashboardPort || 3780}`;
    return [
      `[${displayName || p4Id}님 Perforce 클라이언트 접속 안내]`,
      `1. Tailscale 설치 후 초대받은 팀 네트워크 로그인`,
      `2. P4V(Helix Visual Client) 설치 후 아래 정보로 연결:`,
      `   - Server: ${ip}:${port}`,
      `   - User: ${p4Id}  (⚠️ 대소문자 정확히! 기본 Windows 계정명을 지우고 입력)`,
      `   - Character Encoding: UTF-8 (필수!)`,
      `   - Workspace: New... 클릭 -> [Stream:] 칸을 절대 비워두지 말고 '${stream}' (또는 본인 dev 스트림) 선택!`,
      `   - Workspace 설정 -> [Advanced] 탭에서 'Rmdir' 체크 권장 (삭제된 빈 폴더 자동 정리)`,
      `3. 평소 작업 루틴: 작업 전 [Get Latest] -> 작업 후 P4V 루트 우클릭 [Reconcile Offline Work] (Apply P4IGNORE 체크) -> [Submit]`,
      `4. UE5 에디터 우측 하단 [Revision Control] -> Perforce 선택 후 동일 정보 연결 (에셋 자동 독점 잠금)`,
      `5. 자동 빌드 규칙: main 일반 Submit = 빠른 검증(QuickVerify) / 설명에 [package] 포함 = 전체 패키징(FullPackage)`,
      `6. 실시간 빌드 현황(브라우저): ${webUrl}`,
      `7. 완성 빌드/로그 공유폴더(탐색기): \\\\${ip}\\BuildArchive`,
      ``,
      `[로그인 안 되거나 UTF-8 에러 시 PowerShell 초기화 4줄]`,
      `p4 set P4PORT=${ip}:${port}`,
      `p4 set P4USER=${p4Id}`,
      `p4 set P4CHARSET=utf8`,
      `p4 login`,
    ].join('\n');
  }

  function upsertAuthorMapLocal({ p4User, name, email, githubLogin, githubUrl, avatarUrl }) {
    const idx = authorMapRows.findIndex((r) => r.p4User.toLowerCase() === p4User.toLowerCase());
    const existing = idx >= 0 ? authorMapRows[idx] : {};
    const record = {
      p4User,
      name: name || existing.name || p4User,
      email: email || existing.email || '',
      githubLogin: githubLogin || existing.githubLogin || '',
      githubUrl: githubUrl || existing.githubUrl || '',
      avatarUrl: avatarUrl || existing.avatarUrl || '',
    };
    if (idx >= 0) authorMapRows[idx] = record;
    else authorMapRows.push(record);
    return authorMapRows;
  }

  function renderTeamRoster() {
    const uCount = teamP4State.userCount || 0;
    const wsCount = teamP4State.workspaceCount || 0;

    $('navTeamBadge').textContent = `${uCount}/5`;
    $('navTeamBadge').className = uCount > 5 ? 'nav-badge danger' : uCount > 0 ? 'nav-badge ok' : 'nav-badge';

    $('teamUserQuotaVal').textContent = teamP4State.connected ? `${uCount} / 5명` : `오프라인 (${authorMapRows.length}명 매핑)`;
    $('teamUserQuotaBadge').textContent = !teamP4State.connected
      ? 'P4 미연결'
      : uCount > 5
        ? '한도 초과!'
        : uCount === 5
          ? '최대치 (5/5)'
          : '여유 있음';
    $('teamUserQuotaBadge').className = !teamP4State.connected
      ? 'badge badge-slate'
      : uCount > 5
        ? 'badge badge-rose'
        : uCount === 5
          ? 'badge badge-amber'
          : 'badge badge-green';

    $('teamWsQuotaVal').textContent = teamP4State.connected ? `${wsCount} / 20개` : '- / 20개';
    $('teamWsQuotaBadge').textContent = !teamP4State.connected ? 'P4 미연결' : wsCount > 20 ? '한도 초과!' : '정상';
    $('teamWsQuotaBadge').className = !teamP4State.connected ? 'badge badge-slate' : wsCount > 20 ? 'badge badge-rose' : 'badge badge-green';

    const autoStatus = teamP4State.noAutoCreateStatus || (teamP4State.connected ? (teamP4State.noAutoCreateLocked ? 'locked' : 'open') : 'offline');
    if (autoStatus === 'locked') {
      $('teamAutoCreateBadge').textContent = '차단됨 (안전)';
      $('teamAutoCreateBadge').className = 'badge badge-green';
      $('btnLockAutoCreate').style.display = 'none';
    } else if (autoStatus === 'open') {
      $('teamAutoCreateBadge').textContent = '허용 중 (권장: 차단)';
      $('teamAutoCreateBadge').className = 'badge badge-amber';
      $('btnLockAutoCreate').style.display = 'inline-flex';
    } else if (autoStatus === 'unknown_need_admin') {
      $('teamAutoCreateBadge').textContent = '관리자 로그인 필요';
      $('teamAutoCreateBadge').className = 'badge badge-slate';
      $('btnLockAutoCreate').style.display = 'inline-flex';
    } else {
      $('teamAutoCreateBadge').textContent = '미확인';
      $('teamAutoCreateBadge').className = 'badge badge-slate';
      $('btnLockAutoCreate').style.display = 'none';
    }

    // Auto-fill Admin User input once if empty
    if (!$('txtTeamAdminUser').value.trim()) {
      $('txtTeamAdminUser').value = teamP4State.activeSystemUser || (cfg.P4User !== 'p4bot' ? cfg.P4User : '') || 'p4murmur';
    }

    // Render Admin Session Health / Auth Error Banner
    const authBanner = $('teamAuthBanner');
    if (authBanner) {
      const adminId = $('txtTeamAdminUser').value.trim() || teamP4State.adminUser || '';
      if (!teamP4State.connected) {
        authBanner.style.display = 'flex';
        authBanner.className = 'p4-auth-banner error';
        $('teamAuthBannerTitle').textContent = `✖ Perforce 서버(${cfg.P4Port})에 연결할 수 없습니다`;
        $('teamAuthBannerDesc').textContent = teamP4State.error || 'Helix Core Server(P4D) 서비스가 실행 중인지 확인해 주세요.';
        $('teamQuickLoginRow').style.display = 'none';
      } else if (teamP4State.error) {
        authBanner.style.display = 'flex';
        authBanner.className = 'p4-auth-banner error';
        $('teamAuthBannerTitle').textContent = `⚠ Perforce 유저 목록 조회 실패 — 로그인 세션 만료 또는 권한 오류`;
        $('teamAuthBannerDesc').textContent = `서버(${cfg.P4Port}) 연결은 정상이지만 조회 계정의 티켓이 만료되었습니다. 상세: ${teamP4State.error}`;
        $('teamQuickLoginRow').style.display = 'flex';
        $('txtTeamQuickAdminPass').style.display = '';
        $('btnTeamQuickAdminLogin').style.display = '';
      } else if (teamP4State.authWarning) {
        authBanner.style.display = 'flex';
        authBanner.className = 'p4-auth-banner';
        $('teamAuthBannerTitle').textContent = `⚠ 관리자(${adminId}) 로그인 세션 만료됨 (기본 12시간) — '${teamP4State.queriedAs}' 계정으로 목록 표시 중`;
        $('teamAuthBannerDesc').textContent = `팀원 계정 상태·이메일은 정상 조회되고 있습니다. 신규 팀원 생성/비밀번호 설정을 하려면 우측에서 관리자로 재로그인하세요. (재로그인 후 [12시간 만료 해제]를 누르면 이후 만료되지 않습니다.)`;
        $('teamQuickLoginRow').style.display = 'flex';
        $('txtTeamQuickAdminPass').style.display = '';
        $('btnTeamQuickAdminLogin').style.display = '';
      } else if (teamP4State.adminTicketValid) {
        authBanner.style.display = 'flex';
        authBanner.className = 'p4-auth-banner ok';
        $('teamAuthBannerTitle').textContent = `✔ 관리자(${adminId}) Perforce 세션 유효`;
        $('teamAuthBannerDesc').textContent = teamP4State.adminTicketMessage || '계정 생성·수정 및 비밀번호 변경을 바로 수행할 수 있습니다.';
        $('teamQuickLoginRow').style.display = 'flex';
        $('txtTeamQuickAdminPass').style.display = 'none';
        $('btnTeamQuickAdminLogin').style.display = 'none';
      } else {
        authBanner.style.display = 'none';
      }
    }

    if (!teamP4State.connected) {
      $('teamRosterSubtitle').textContent = `Perforce 서버에 아직 연결되지 않아 로컬 author_map.json(${authorMapRows.length}건)만 표시 중입니다.`;
    } else if (teamP4State.error) {
      $('teamRosterSubtitle').textContent = `⚠ Perforce 서버(${cfg.P4Port}) 연결됨 — 단, 로그인 세션 만료로 유저 목록을 불러오지 못했습니다. 위 배너에서 관리자로 재로그인하세요.`;
    } else {
      const via = teamP4State.queriedAs ? ` · 조회 계정: ${teamP4State.queriedAs}` : '';
      $('teamRosterSubtitle').textContent = `Perforce 서버(${cfg.P4Port}) 유저 ${uCount}명과 로컬 잔디 매핑 ${authorMapRows.length}건을 통합 표시합니다.${via}`;
    }

    // Merge P4 users + author_map rows
    const mergedMap = new Map();
    for (const u of teamP4State.users || []) {
      mergedMap.set(u.p4User.toLowerCase(), {
        p4User: u.p4User,
        p4Name: u.fullName,
        p4Email: u.email,
        hasPassword: Boolean(u.hasPassword),
        lastAccess: u.lastAccess || '',
        inP4: true,
        mapName: '',
        mapEmail: '',
        githubLogin: '',
        githubUrl: '',
        avatarUrl: '',
        inMap: false,
      });
    }
    for (const m of authorMapRows || []) {
      const k = (m.p4User || '').toLowerCase();
      if (!k) continue;
      const cur = mergedMap.get(k) || {
        p4User: m.p4User,
        p4Name: '',
        p4Email: '',
        hasPassword: false,
        lastAccess: '',
        inP4: false,
      };
      cur.mapName = m.name || '';
      cur.mapEmail = m.email || '';
      cur.githubLogin = m.githubLogin || '';
      cur.githubUrl = m.githubUrl || '';
      cur.avatarUrl = m.avatarUrl || '';
      cur.inMap = true;
      mergedMap.set(k, cur);
    }

    const rows = Array.from(mergedMap.values());
    const tbody = $('teamRosterBody');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">등록된 팀원이 없습니다. 위 카드에 GitHub 프로필 링크를 붙여넣어 첫 팀원을 추가해 보세요!</td></tr>';
      return;
    }

    tbody.innerHTML = rows
      .map((r) => {
        const isBot = r.p4User.toLowerCase().includes('bot');
        const initial = (r.p4User || '?').slice(0, 1).toUpperCase();
        const avatarHtml = r.avatarUrl
          ? `<img class="gh-avatar-sm" src="${escapeHtml(r.avatarUrl)}" alt="" />`
          : `<span class="gh-avatar-placeholder">${escapeHtml(initial)}</span>`;
        const statusBadge = isBot
          ? '<span class="badge badge-violet">자동화 봇</span>'
          : r.inP4 && r.inMap
            ? '<span class="badge badge-green">✔ P4 + 잔디 연동</span>'
            : r.inP4
              ? '<span class="badge badge-blue">P4 등록됨</span>'
              : '<span class="badge badge-amber">매핑 전용</span>';
        const noPassBadge =
          r.inP4 && !r.hasPassword
            ? ' <span class="badge badge-rose" title="비밀번호가 미설정되어 P4V 로그인이 거부됩니다. [수정]을 눌러 8자 이상 비밀번호를 설정하세요.">⚠ 비번 미설정</span>'
            : '';
        const accessHint = r.inP4
          ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">최근 접속: ${r.lastAccess ? escapeHtml(formatDateTime(r.lastAccess)) : '기록 없음'}</div>`
          : '';

        return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:9px;">
              ${avatarHtml}
              <div>
                <div style="font-weight:700;">${escapeHtml(r.p4User)}</div>
                ${r.githubLogin ? `<div style="font-size:11px; color:var(--text-muted);">@${escapeHtml(r.githubLogin)}</div>` : ''}
              </div>
            </div>
          </td>
          <td>${escapeHtml(r.mapName || r.p4Name || '-')}</td>
          <td><span class="mono-code">${escapeHtml(r.p4Email || '미등록')}</span></td>
          <td><span class="mono-code">${escapeHtml(r.mapEmail || (r.inP4 ? 'P4 이메일 자동 사용' : '-'))}</span></td>
          <td><div>${statusBadge}${noPassBadge}</div>${accessHint}</td>
          <td style="text-align:right; white-space:nowrap;">
            <button class="btn btn-sm team-edit-btn" data-id="${escapeHtml(r.p4User)}">수정</button>
            <button class="btn btn-sm team-invite-btn" data-id="${escapeHtml(r.p4User)}" data-name="${escapeHtml(r.mapName || r.p4Name || r.p4User)}">안내복사</button>
            ${remoteMode ? '' : `<button class="btn btn-sm btn-danger team-del-btn" data-id="${escapeHtml(r.p4User)}" data-inp4="${r.inP4 ? '1' : '0'}">삭제</button>`}
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('.team-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = rows.find((x) => x.p4User === btn.dataset.id);
        if (!row) return;
        editingExistingP4Id = row.p4User;
        lastAutoFilledP4Id = '';
        $('txtTeamP4Id').value = row.p4User;
        $('txtTeamName').value = row.mapName || row.p4Name || row.p4User;
        $('txtTeamEmail').value = row.mapEmail || row.p4Email || '';
        $('txtTeamGhUrl').value = row.githubUrl || (row.githubLogin ? `https://github.com/${row.githubLogin}` : '');
        $('txtTeamPasswd').value = '';
        if (row.avatarUrl || row.githubLogin) {
          showGhPreviewCard({
            login: row.githubLogin || row.p4User,
            name: row.mapName || row.p4Name || row.p4User,
            email: row.mapEmail || row.p4Email || '',
            noreplyEmail: row.mapEmail || '',
            emailSource: 'public_profile',
            githubUrl: row.githubUrl || `https://github.com/${row.githubLogin}`,
            avatarUrl: row.avatarUrl || '',
          });
        } else {
          $('teamGhPreview').classList.remove('visible');
        }
        document.querySelector('.content-area')?.scrollTo({ top: 0, behavior: 'smooth' });
        toast(`'${row.p4User}' 정보를 편집창에 불러왔습니다. GitHub 링크를 붙여넣어 자동 업데이트할 수 있습니다.`, 'info');
      });
    });

    tbody.querySelectorAll('.team-invite-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const text = buildTeammateInviteGuide(btn.dataset.id, btn.dataset.name);
        await navigator.clipboard.writeText(text);
        toast(`'${btn.dataset.id}' 팀원용 P4V 접속 가이드가 복사되었습니다!`, 'success');
      });
    });

    tbody.querySelectorAll('.team-del-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetId = btn.dataset.id;
        const inP4 = btn.dataset.inp4 === '1';
        const adminId = $('txtTeamAdminUser').value.trim();

        if (inP4 && adminId && targetId.toLowerCase() === adminId.toLowerCase()) {
          return toast('현재 사용 중인 관리자 계정은 안전상 여기서 삭제할 수 없습니다.', 'error');
        }

        const msg = inP4
          ? `'${targetId}'의 잔디 매핑(author_map.json)을 삭제할까요?\n\n(확인 시 매핑을 제거하고, 이어서 Perforce 서버 계정 삭제 여부를 한 번 더 확인합니다.)`
          : `'${targetId}'의 잔디 매핑(author_map.json)을 삭제할까요?`;
        if (!confirm(msg)) return;

        authorMapRows = authorMapRows.filter((r) => r.p4User.toLowerCase() !== targetId.toLowerCase());
        const saved = await safeCall(() => api.invoke('config:authorMap:save', authorMapRows));
        if (saved) {
          authorMapRows = saved;
          renderAuthorMap();
        }

        if (inP4 && confirm(`Perforce 서버에서도 '${targetId}' 계정을 완전히 삭제(p4 user -d)할까요?\n(취소를 누르면 P4 계정은 유지됩니다.)`)) {
          await safeCall(() => api.invoke('p4:team:deleteUser', { adminUser: adminId, p4User: targetId }), `P4 계정 '${targetId}' 삭제 완료!`);
        } else {
          toast(`'${targetId}' 매핑이 제거되었습니다.`, 'info');
        }
        await refreshTeamTab();
      });
    });
  }

  async function refreshTeamTab() {
    if (remoteMode) return;
    const mapRows = await safeCall(() => api.invoke('config:authorMap:get'));
    if (mapRows) {
      authorMapRows = mapRows;
      renderAuthorMap();
    }
    const adminUser = $('txtTeamAdminUser')?.value.trim() || '';
    const res = await safeCall(() => api.invoke('p4:team:list', { adminUser }));
    if (res) {
      teamP4State = res;
    }
    renderTeamRoster();
  }

  async function lookupTeamGitHubProfile() {
    const input = $('txtTeamGhUrl').value.trim();
    if (!input) return toast('GitHub 프로필 링크 또는 아이디를 입력해 주세요.', 'error');
    const btn = $('btnTeamLookupGh');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '조회 중...';
    const profile = await safeCall(() => api.invoke('github:lookupProfile', input));
    btn.disabled = false;
    btn.textContent = orig;
    if (!profile) return;

    showGhPreviewCard(profile);
    // Preserve existing P4 ID ONLY when explicitly editing a selected existing account (e.g. p4murmur).
    // When switching GitHub link A -> B in add mode (or after saving A), always update P4 ID to B!
    const curP4Id = $('txtTeamP4Id').value.trim();
    const isLockedToExisting = editingExistingP4Id && curP4Id.toLowerCase() === editingExistingP4Id.toLowerCase();
    if (!isLockedToExisting && (!curP4Id || curP4Id === lastAutoFilledP4Id || !editingExistingP4Id)) {
      $('txtTeamP4Id').value = profile.login;
      lastAutoFilledP4Id = profile.login;
    }
    $('txtTeamName').value = profile.name || profile.login;
    $('txtTeamEmail').value = profile.email || profile.noreplyEmail;
    toast(`GitHub 프로필(@${profile.login}) 정보를 불러왔습니다!`, 'success');
  }

  $('txtTeamP4Id')?.addEventListener('input', () => {
    const v = $('txtTeamP4Id').value.trim();
    if (!v) {
      editingExistingP4Id = '';
      lastAutoFilledP4Id = '';
    }
  });

  $('btnTeamRefresh')?.addEventListener('click', refreshTeamTab);
  $('btnTeamOpenP4Logs')?.addEventListener('click', () => switchView('p4logs'));
  $('btnTeamClearForm')?.addEventListener('click', clearTeamForm);

  async function runQuickAdminLogin() {
    const user = $('txtTeamAdminUser').value.trim() || teamP4State.adminUser || '';
    const password = $('txtTeamQuickAdminPass').value;
    if (!user) return toast('관리자 Perforce 아이디를 먼저 입력해 주세요.', 'error');
    if (!password) return toast('관리자 비밀번호를 입력해 주세요.', 'error');
    const r = await safeCall(() => api.invoke('p4prov:login', { user, password }));
    if (r && r.ok) {
      $('txtTeamQuickAdminPass').value = '';
      toast(r.message, 'success');
      await refreshTeamTab();
      refreshProvStatus();
    }
  }
  $('btnTeamQuickAdminLogin')?.addEventListener('click', () =>
    withBusyButton('btnTeamQuickAdminLogin', '로그인 중...', runQuickAdminLogin)
  );
  $('txtTeamQuickAdminPass')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('btnTeamQuickAdminLogin')?.click();
    }
  });
  $('btnTeamExtendTimeout')?.addEventListener('click', () =>
    withBusyButton('btnTeamExtendTimeout', '연장 중...', async () => {
      const adminUser = $('txtTeamAdminUser').value.trim() || teamP4State.adminUser || '';
      if (!adminUser) return toast('관리자 Perforce 아이디를 입력해 주세요.', 'error');
      const r = await safeCall(() => api.invoke('p4:team:extendTimeout', { adminUser, includeAllUsers: true }));
      if (r && r.ok) {
        toast(r.message, 'success');
        await refreshTeamTab();
      }
    })
  );

  // ---------------------------------------------------------------------------
  // Perforce Server Log Recording & Live Diagnostics View
  // ---------------------------------------------------------------------------
  let p4LogSource = 'p4log';
  let p4LogFilter = 'all';
  let p4LogLastData = null;
  let p4LogLiveTimer = null;
  let p4LogSearchDebounce = null;

  function stopP4LogLiveTimer() {
    if (p4LogLiveTimer) {
      clearInterval(p4LogLiveTimer);
      p4LogLiveTimer = null;
    }
  }

  function syncP4LogLiveTimer() {
    stopP4LogLiveTimer();
    const isP4LogView = $('view-p4logs')?.classList.contains('active');
    if ($('chkP4LogLive')?.checked && isP4LogView) {
      p4LogLiveTimer = setInterval(() => {
        refreshP4Logs(true);
      }, 5000);
    }
  }

  function renderP4Logs(data) {
    if (!data) return;
    p4LogLastData = data;
    const stats = data.stats || {};
    const c = data.config || {};

    // KPIs & Sidebar Badge
    const issueCount = (stats.authFailCount || 0) + (stats.errorCount || 0);
    const navBadge = $('navP4LogBadge');
    if (navBadge) {
      navBadge.textContent = String(issueCount);
      navBadge.className = issueCount > 0 ? 'nav-badge danger' : 'nav-badge ok';
      navBadge.style.display = issueCount > 0 ? 'inline-flex' : 'none';
    }

    $('p4LogKpiTotal').textContent = `${stats.parsedEntries || 0}건`;
    $('p4LogStatusBadge').textContent = data.exists ? formatBytes(data.fileSizeBytes || 0) : '파일 없음';
    $('p4LogStatusBadge').className = data.exists ? 'badge badge-blue' : 'badge badge-amber';
    $('p4LogKpiFile').textContent = data.filePath || 'P4LOG 경로 미감지';

    $('p4LogKpiAuthFail').textContent = `${stats.authFailCount || 0}건`;
    $('p4LogAuthBadge').textContent = (stats.authFailCount || 0) > 0 ? '확인 필요' : '정상';
    $('p4LogAuthBadge').className = (stats.authFailCount || 0) > 0 ? 'badge badge-rose' : 'badge badge-green';

    $('p4LogKpiErrors').textContent = `${stats.errorCount || 0}건`;
    $('p4LogErrBadge').textContent = (stats.errorCount || 0) > 0 ? '감지됨' : '정상';
    $('p4LogErrBadge').className = (stats.errorCount || 0) > 0 ? 'badge badge-amber' : 'badge badge-green';

    $('p4LogKpiIps').textContent = `${stats.uniqueIps || 0}대`;
    $('p4LogKpiUptime').textContent = c.serverUptime ? `P4D 가동시간: ${c.serverUptime}` : (c.serverReachable ? 'P4D 실행 중' : 'P4D 미연결');

    // Config summary & P4ROOT mismatch warning
    const structTxt = c.structuredLogs && c.structuredLogs.length > 0 ? ` · 구조화 로그 활성(${c.structuredLogs.length}개 설정)` : '';
    $('p4LogConfigSummary').innerHTML =
      `실제 <code>P4ROOT</code>: <code>${escapeHtml(c.serverRoot || '-')}</code> · <code>P4LOG</code>: <code>${escapeHtml(c.files?.p4log?.path || '-')}</code> · 로그 레벨: <strong>${escapeHtml(c.serverLogLevel || '3')}</strong>${escapeHtml(structTxt)}`;

    const mismatchBox = $('p4LogRootMismatchAlert');
    const syncRootBtn = $('btnP4LogSyncRoot');
    if (c.depotRootMismatch && !remoteMode) {
      mismatchBox.style.display = 'block';
      mismatchBox.innerHTML =
        `<div class="wiz-tip-title">⚠ 설정된 백업/디포 경로(P4DepotRoot)가 실제 Perforce 서버 경로와 다릅니다!</div>` +
        `앱 설정: <code>${escapeHtml(c.configuredDepotRoot)}</code> → 실제 P4D 서비스 경로: <code>${escapeHtml(c.serverRoot)}</code>. 우측 <strong>[실제 P4ROOT 경로 자동 동기화]</strong>를 눌러 맞춰주세요.`;
      syncRootBtn.style.display = 'inline-flex';
      syncRootBtn.dataset.root = c.serverRoot;
    } else {
      mismatchBox.style.display = 'none';
      syncRootBtn.style.display = 'none';
    }

    if (!$('txtP4LogAdminUser').value.trim()) {
      $('txtP4LogAdminUser').value =
        $('txtTeamAdminUser')?.value.trim() ||
        $('txtProvAdminUser')?.value.trim() ||
        teamP4State.activeSystemUser ||
        '';
    }

    // Active monitor badge
    const monCount = (data.activeConnections || []).length;
    $('p4LogActiveMonBadge').textContent = `현재 활성 연결 ${monCount}건`;
    $('p4LogActiveMonBadge').className = monCount > 0 ? 'badge badge-green' : 'badge badge-slate';

    // Connected Client IPs table
    const clientsBody = $('p4LogClientsBody');
    const clients = data.recentClients || [];
    if (clients.length === 0) {
      clientsBody.innerHTML = '<tr><td colspan="7" class="empty-state">최근 서버 로그에서 감지된 클라이언트 IP가 없습니다.</td></tr>';
    } else {
      clientsBody.innerHTML = clients
        .map(
          (cl) => `
        <tr class="p4log-client-row" data-ip="${escapeHtml(cl.ip)}" title="클릭하여 ${escapeHtml(cl.ip)} 로그만 필터링">
          <td><span class="mono-code">${escapeHtml(cl.ip)}</span>${cl.ip === '127.0.0.1' ? ' <span class="badge badge-slate">로컬 서버</span>' : ''}</td>
          <td><strong>${escapeHtml(cl.users.join(', ') || '미인증/unknown')}</strong></td>
          <td style="color:var(--text-secondary);">${escapeHtml(cl.apps.slice(0, 3).join(', ') || '-')}</td>
          <td style="color:var(--text-secondary);"><span class="mono-code">${escapeHtml(cl.lastSeen || '-')}</span></td>
          <td><span class="mono-code">${cl.requestCount}</span></td>
          <td>${cl.authFailCount > 0 ? `<span class="badge badge-rose">${cl.authFailCount}건</span>` : '<span class="badge badge-green">0</span>'}</td>
          <td>${cl.errorCount > 0 ? `<span class="badge badge-amber">${cl.errorCount}건</span>` : '<span class="badge badge-slate">0</span>'}</td>
        </tr>`
        )
        .join('');

      clientsBody.querySelectorAll('.p4log-client-row').forEach((row) => {
        row.addEventListener('click', () => {
          $('txtP4LogSearch').value = row.dataset.ip || '';
          refreshP4Logs(true);
        });
      });
    }

    // Log Viewer output
    const out = $('p4LogOutput');
    const entries = data.entries || [];
    if (!data.exists && data.source !== 'audit') {
      out.innerHTML = `<div class="empty-state">선택한 로그 파일(<code>${escapeHtml(data.filePath || data.source)}</code>)이 아직 생성되지 않았습니다.<br/>구조화 로그(<code>auth.csv</code> / <code>errors.csv</code>)를 보려면 상단에서 <strong>[⚙ 로그 설정 적용]</strong>을 눌러 활성화하세요.</div>`;
      return;
    }
    if (entries.length === 0) {
      out.innerHTML = '<div class="empty-state">현재 필터/검색 조건에 일치하는 로그 항목이 없습니다.</div>';
      return;
    }

    const tagMap = {
      auth_fail: 'AUTH FAIL',
      error: 'ERROR',
      warn: 'WARN',
      admin: 'ADMIN',
      auth: 'AUTH',
      connect: 'CONN',
      command: 'INFO',
    };

    const frag = document.createDocumentFragment();
    for (const e of entries) {
      const div = document.createElement('div');
      const cls = e.level === 'auth_fail' ? 'auth_fail' : e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : e.category === 'admin' ? 'admin' : 'info';
      const tag = e.level === 'auth_fail' ? tagMap.auth_fail : e.level === 'error' ? tagMap.error : e.level === 'warn' ? tagMap.warn : tagMap[e.category] || 'INFO';
      div.className = `p4log-entry ${cls}`;
      const ts = e.timestamp ? e.timestamp.replace(/^\d{4}\//, '') : '--:--:--';
      div.innerHTML = `<span class="log-ts">${escapeHtml(ts)}</span><span class="p4log-tag">${tag}</span><span class="log-txt">${escapeHtml(e.summary || e.raw)}</span>`;
      frag.appendChild(div);
    }
    out.innerHTML = '';
    out.appendChild(frag);
    out.scrollTop = out.scrollHeight;
  }

  async function refreshP4Logs(silent = false) {
    const adminUser = $('txtP4LogAdminUser')?.value.trim() || $('txtTeamAdminUser')?.value.trim() || '';
    const tailLines = Number($('selP4LogLimit')?.value) || 500;
    const query = ($('txtP4LogSearch')?.value || '').trim();
    const res = await safeCall(() =>
      api.invoke('p4:logs:read', {
        source: p4LogSource,
        tailLines,
        filter: p4LogFilter,
        query,
        adminUser,
      })
    );
    if (res) {
      renderP4Logs(res);
      if (!silent) toast('Perforce 서버 로그를 갱신했습니다.', 'info');
    }
    syncP4LogLiveTimer();
  }

  $('btnP4LogRefresh')?.addEventListener('click', () => refreshP4Logs(false));
  $('chkP4LogLive')?.addEventListener('change', syncP4LogLiveTimer);
  $('selP4LogLimit')?.addEventListener('change', () => refreshP4Logs(true));
  $('txtP4LogSearch')?.addEventListener('input', () => {
    if (p4LogSearchDebounce) clearTimeout(p4LogSearchDebounce);
    p4LogSearchDebounce = setTimeout(() => refreshP4Logs(true), 220);
  });
  $('btnP4LogClearSearch')?.addEventListener('click', () => {
    $('txtP4LogSearch').value = '';
    refreshP4Logs(true);
  });
  $('btnP4LogCopy')?.addEventListener('click', async () => {
    const lines = (p4LogLastData?.entries || []).map((e) => e.raw || `[${e.timestamp}] ${e.summary}`).join('\n');
    if (!lines) return toast('복사할 로그가 없습니다.', 'info');
    await navigator.clipboard.writeText(lines);
    toast('Perforce 서버 로그가 클립보드에 복사되었습니다.', 'success');
  });
  $('btnP4LogSnapshot')?.addEventListener('click', () =>
    withBusyButton('btnP4LogSnapshot', '저장 중...', async () => {
      const adminUser = $('txtP4LogAdminUser')?.value.trim() || $('txtTeamAdminUser')?.value.trim() || '';
      const r = await safeCall(() => api.invoke('p4:logs:snapshot', { adminUser }));
      if (r && r.ok) {
        toast(`진단 스냅샷 저장 완료: ${r.filePath}`, 'success');
        refreshP4Logs(true);
      }
    })
  );
  $('btnP4LogOpenDir')?.addEventListener('click', () => {
    const dir = p4LogLastData?.config?.auditDir || `${cfg.ArchiveRoot || 'C:\\BuildArchive'}\\P4ServerLogs`;
    api.invoke('system:openFolder', dir);
  });
  $('btnP4LogSyncRoot')?.addEventListener('click', async () => {
    const serverRoot = $('btnP4LogSyncRoot').dataset.root || '';
    if (!serverRoot) return;
    const saved = await safeCall(() => api.invoke('p4:logs:syncDepotRoot', { serverRoot }), `P4DepotRoot를 '${serverRoot}'로 동기화했습니다!`);
    if (saved) {
      cfg = saved;
      hydrateConfigToUI();
      refreshP4Logs(true);
    }
  });
  $('btnP4LogApplyConfig')?.addEventListener('click', () =>
    withBusyButton('btnP4LogApplyConfig', '적용 중...', async () => {
      const adminUser = $('txtP4LogAdminUser').value.trim() || $('txtTeamAdminUser')?.value.trim() || '';
      const logLevel = Number($('selP4LogLevel').value) || 3;
      const enableStructuredLogs = Boolean($('chkP4StructuredLogs').checked);
      const r = await safeCall(() =>
        api.invoke('p4:logs:configure', { adminUser, logLevel, enableStructuredLogs, maxMb: 20, retainCount: 5 })
      );
      if (r && r.ok) {
        toast(r.message, 'success');
        refreshP4Logs(true);
      }
    })
  );
  document.querySelectorAll('#p4LogSourceTabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#p4LogSourceTabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      p4LogSource = btn.dataset.source || 'p4log';
      refreshP4Logs(true);
    });
  });
  document.querySelectorAll('#p4LogFilterChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#p4LogFilterChips .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      p4LogFilter = chip.dataset.filter || 'all';
      refreshP4Logs(true);
    });
  });
  $('btnTeamLookupGh')?.addEventListener('click', lookupTeamGitHubProfile);
  $('txtTeamGhUrl')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      lookupTeamGitHubProfile();
    }
  });
  $('btnTeamOpenGhProfile')?.addEventListener('click', () => {
    if (lastLookedUpGh && lastLookedUpGh.githubUrl) {
      api.invoke('system:openExternal', lastLookedUpGh.githubUrl);
    }
  });
  $('btnLockAutoCreate')?.addEventListener('click', async () => {
    const adminUser = $('txtTeamAdminUser').value.trim();
    const r = await safeCall(() => api.invoke('p4:team:lockAutoCreate', { adminUser }));
    if (r && r.ok) {
      toast(r.message, 'success');
      refreshTeamTab();
    }
  });
  $('btnTeamSaveMapOnly')?.addEventListener('click', async () => {
    const p4User = $('txtTeamP4Id').value.trim();
    const name = $('txtTeamName').value.trim() || p4User;
    const email = $('txtTeamEmail').value.trim();
    if (!p4User || !email) return toast('Perforce 아이디와 이메일을 입력해 주세요.', 'error');

    upsertAuthorMapLocal({
      p4User,
      name,
      email,
      githubLogin: lastLookedUpGh?.login || '',
      githubUrl: lastLookedUpGh?.githubUrl || $('txtTeamGhUrl').value.trim(),
      avatarUrl: lastLookedUpGh?.avatarUrl || '',
    });
    const saved = await safeCall(() => api.invoke('config:authorMap:save', authorMapRows), `'${p4User}' 잔디 매핑 저장 완료!`);
    if (saved) {
      authorMapRows = saved;
      editingExistingP4Id = '';
      lastAutoFilledP4Id = p4User;
      renderAuthorMap();
      renderTeamRoster();
    }
  });
  $('btnTeamSaveBoth')?.addEventListener('click', async () => {
    const p4User = $('txtTeamP4Id').value.trim();
    const fullName = $('txtTeamName').value.trim() || p4User;
    const email = $('txtTeamEmail').value.trim();
    const password = $('txtTeamPasswd').value;
    const adminUser = $('txtTeamAdminUser').value.trim();

    if (!p4User || !email) return toast('Perforce 아이디와 이메일을 입력해 주세요.', 'error');

    const p4Res = await safeCall(() =>
      api.invoke('p4:team:upsertUser', { adminUser, p4User, fullName, email, password })
    );
    if (!p4Res) return;

    upsertAuthorMapLocal({
      p4User,
      name: fullName,
      email,
      githubLogin: lastLookedUpGh?.login || '',
      githubUrl: lastLookedUpGh?.githubUrl || $('txtTeamGhUrl').value.trim(),
      avatarUrl: lastLookedUpGh?.avatarUrl || '',
    });
    const saved = await safeCall(() => api.invoke('config:authorMap:save', authorMapRows));
    if (saved) {
      authorMapRows = saved;
      renderAuthorMap();
    }
    editingExistingP4Id = '';
    lastAutoFilledP4Id = p4User;
    $('txtTeamPasswd').value = '';
    toast(`${p4Res.message} + 잔디 매핑 저장 완료!`, 'success');
    await refreshTeamTab();
  });
  $('btnTeamCopyInvite')?.addEventListener('click', async () => {
    const p4User = $('txtTeamP4Id').value.trim() || '<팀원_P4_ID>';
    const name = $('txtTeamName').value.trim() || p4User;
    await navigator.clipboard.writeText(buildTeammateInviteGuide(p4User, name));
    toast(`'${p4User}' 팀원용 P4V 접속 가이드가 클립보드에 복사되었습니다!`, 'success');
  });

  $('btnTeamGenPass')?.addEventListener('click', () => {
    const pw = generateStrongBotPassword();
    $('txtTeamPasswd').type = 'text';
    $('txtTeamPasswd').value = pw;
    navigator.clipboard.writeText(pw).catch(() => {});
    toast('P4D 보안 정책을 통과하는 팀원 비밀번호를 생성하고 클립보드에 복사했습니다!', 'success');
  });

  // ---------------------------------------------------------------------------
  // First-Run & On-Demand Setup Wizard + PC Environment Diagnostics
  // ---------------------------------------------------------------------------
  let wizStep = 1;
  let wizDiagReport = null;

  function syncWizardFieldsFromConfig() {
    const isP4 = (cfg.VcsMode || 'PerforceHybrid') === 'PerforceHybrid';
    document.querySelectorAll('#wizVcsSegmented button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === (cfg.VcsMode || 'PerforceHybrid'));
    });

    $('wizUE5Root').value = cfg.UE5Root || '';
    $('wizProjectDir').value = cfg.ProjectDir || '';
    $('wizArchiveRoot').value = cfg.ArchiveRoot || 'C:\\BuildArchive';
    $('wizEnableRetain').checked = Boolean(cfg.EnablePackageRetention);
    $('wizMaxPkgs').value = cfg.MaxRetainedPackages || 10;

    $('wizGhStatus').textContent = cfg.ConnectedRepoFullName
      ? `✔ 연결 완료: ${cfg.ConnectedRepoFullName} (브랜치: ${cfg.LastBranch || 'main'})`
      : '아직 연결된 저장소가 없습니다. 우측 버튼으로 로그인해 선택하세요.';
    $('wizWfDesc').textContent = isP4
      ? 'Perforce 하이브리드 전용 build.yml(로컬 P4 sync + QuickVerify/FullPackage 분기)을 등록합니다.'
      : 'Git 단독 모드 전용 build.yml을 선택한 브랜치에 자동 등록합니다.';

    const runner = appState?.runner || {};
    $('wizRunnerBadge').textContent = runner.running
      ? '가동 중'
      : runner.configured
        ? '등록 완료 (대기)'
        : runner.installed
          ? '설치됨 (미등록)'
          : '미설치';
    $('wizRunnerBadge').className = runner.running
      ? 'badge badge-green'
      : runner.configured
        ? 'badge badge-blue'
        : 'badge badge-slate';

    $('wizP4Box').style.display = isP4 ? 'flex' : 'none';
    $('wizGitBox').style.display = isP4 ? 'none' : 'flex';
    $('wizP4Port').value = cfg.P4Port || 'localhost:1666';
    $('wizP4User').value = cfg.P4User || 'p4bot';
    $('wizP4Stream').value = cfg.P4Stream || '//MyProject/main';
    $('wizP4BuildClient').value = cfg.P4BuildClient || 'ws-build-full';
    $('wizP4MirrorClient').value = cfg.P4MirrorClient || 'ws-mirror-code';

    $('wizDiscordUrl').value = cfg.DiscordWebhookUrl || '';
    $('wizSlackToken').value = cfg.SlackBotToken || '';
    $('wizSlackChannel').value = cfg.SlackChannelId || '';
    $('wizTailscaleIp').value = cfg.TailscaleIP || '';
    $('wizWebEnabled').checked = Boolean(cfg.RemoteWebDashboardEnabled);
    $('chkWizDontAutoOpen').checked = Boolean(cfg.SetupCompleted);
  }

  function populateWizUEDropdown(ueList) {
    const sel = $('wizSelUE5');
    sel.innerHTML = '';
    if (!ueList || ueList.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '자동 감지된 UE5 없음 — 아래 [찾아보기]로 직접 지정하세요';
      sel.appendChild(opt);
      return;
    }
    for (const item of ueList) {
      const opt = document.createElement('option');
      opt.value = item.path;
      opt.textContent = `UE ${item.version} — ${item.path}`;
      if (cfg.UE5Root && cfg.UE5Root.toLowerCase() === item.path.toLowerCase()) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function renderWizardDiagnostics(report) {
    wizDiagReport = report;
    populateWizUEDropdown(report.ueInstallations || []);

    const banner = $('wizDiagSummary');
    const s = report.summary;
    if (s.missingRequired > 0) {
      banner.className = 'diag-summary-banner missing';
      banner.innerHTML = `<span>⚠ <strong>필수 요소 ${s.missingRequired}개가 부족합니다.</strong> 아래 항목에서 바로 설치하거나 다운로드한 뒤 <strong>[다시 검사]</strong>를 누르세요. (정상 ${s.passed}/${s.total})</span>`;
    } else if (s.warnings > 0) {
      banner.className = 'diag-summary-banner warn';
      banner.innerHTML = `<span>✔ <strong>필수 프로그램이 모두 준비되었습니다!</strong> 권장·초기 설정 ${s.warnings}개는 다음 단계에서 원클릭으로 완료할 수 있습니다.</span>`;
    } else {
      banner.className = 'diag-summary-banner ok';
      banner.innerHTML = `<span>🎉 <strong>완벽합니다!</strong> 이 PC는 모든 필수 및 권장 요소가 준비되어 있습니다. (${s.passed}/${s.total} 통과)</span>`;
    }

    const listEl = $('wizDiagList');
    const badgeMap = {
      ok: '<span class="badge badge-green">✔ 정상</span>',
      warn: '<span class="badge badge-amber">⚠ 권장/설정필요</span>',
      missing: '<span class="badge badge-rose">✖ 필수 부족</span>',
      optional: '<span class="badge badge-slate">○ 선택</span>',
    };

    listEl.innerHTML = (report.checks || [])
      .map((c) => {
        const showActions = c.status === 'missing' || c.status === 'warn';
        const autoP4dBtn =
          showActions && c.autoInstallP4D
            ? `<button class="btn btn-sm btn-primary wiz-install-p4d">⬇ P4D 자동 다운로드·설치</button>`
            : '';
        const applyUserBtn =
          showActions && c.applyP4User
            ? `<button class="btn btn-sm btn-success wiz-apply-p4user" data-user="${escapeHtml(c.applyP4User)}">✔ ${escapeHtml(c.applyP4User)} 계정 적용</button>`
            : '';
        const jumpBtn =
          showActions && c.jumpToStep
            ? `<button class="btn btn-sm wiz-jump-step" data-step="${c.jumpToStep}">${c.jumpToStep}단계 설정 →</button>`
            : '';
        const wingetBtn =
          showActions && c.wingetKey
            ? `<button class="btn btn-sm btn-primary wiz-winget-btn" data-pkg="${escapeHtml(c.wingetKey)}">⚡ winget 설치</button>`
            : '';
        const dlBtn =
          showActions && c.downloadUrl
            ? `<button class="btn btn-sm wiz-dl-btn" data-url="${escapeHtml(c.downloadUrl)}">${escapeHtml(c.downloadLabel || '다운로드')} ↗</button>`
            : '';
        return `
        <div class="diag-card ${escapeHtml(c.status)}">
          <div class="diag-card-main">
            <div class="diag-card-top">
              ${badgeMap[c.status] || badgeMap.optional}
              <span class="diag-card-name">${escapeHtml(c.name)}</span>
              <span class="diag-card-summary">${escapeHtml(c.summary)}</span>
            </div>
            <div class="diag-card-detail">${escapeHtml(c.detail)}</div>
          </div>
          <div class="diag-card-actions">${autoP4dBtn}${applyUserBtn}${jumpBtn}${wingetBtn}${dlBtn}</div>
        </div>`;
      })
      .join('');

    listEl.querySelectorAll('.wiz-install-p4d').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '다운로드 중...';
        const r = await safeCall(() => api.invoke('p4prov:installP4D'));
        btn.disabled = false;
        btn.textContent = orig;
        if (r && r.ok) toast('P4D 공식 설치 프로그램을 실행했습니다. 설치 후 [다시 검사]를 누르세요!', 'success');
      });
    });

    listEl.querySelectorAll('.wiz-apply-p4user').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const u = btn.dataset.user;
        const saved = await safeCall(() => api.invoke('config:save', { P4User: u }), `P4USER를 '${u}' 계정으로 적용했습니다!`);
        if (saved) {
          cfg = saved;
          hydrateConfigToUI();
          syncWizardFieldsFromConfig();
          await runWizardDiagnostics();
        }
      });
    });
    listEl.querySelectorAll('.wiz-jump-step').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await saveWizardProgress();
        setWizardStep(Number(btn.dataset.step));
      });
    });
    listEl.querySelectorAll('.wiz-dl-btn').forEach((btn) => {
      btn.addEventListener('click', () => api.invoke('system:openExternal', btn.dataset.url));
    });
    listEl.querySelectorAll('.wiz-winget-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '설치 중...';
        toast('winget 자동 설치를 시작했습니다. 완료될 때까지 잠시 기다려 주세요.', 'info');
        const r = await safeCall(() => api.invoke('diag:wingetInstall', btn.dataset.pkg));
        btn.disabled = false;
        btn.textContent = origText;
        if (r) {
          toast(r.ok ? `${r.label} 설치 완료! 환경을 다시 검사합니다.` : `${r.label} 설치 종료 (코드 ${r.code})`, r.ok ? 'success' : 'error');
          await runWizardDiagnostics();
        }
      });
    });
  }

  async function runWizardDiagnostics(modeOverride = '') {
    if (remoteMode) return;
    $('wizDiagSummary').className = 'diag-summary-banner';
    $('wizDiagSummary').innerHTML = '<span>🔍 이 PC의 필수 요소(UE5, MSVC C++, Git, Perforce, Tailscale, 디스크/RAM)를 검사하는 중...</span>';
    const report = await safeCall(() => api.invoke('diag:run', { vcsMode: modeOverride || cfg.VcsMode || 'PerforceHybrid' }));
    if (report) {
      if (report.autoPatched) {
        cfg = { ...cfg, ...report.autoPatched };
        hydrateConfigToUI();
        syncWizardFieldsFromConfig();
      }
      renderWizardDiagnostics(report);
    }
  }

  function setWizardStep(stepNum) {
    wizStep = Math.max(1, Math.min(5, stepNum));
    document.querySelectorAll('#wizardStepper .wiz-step-btn').forEach((b) => {
      const s = Number(b.dataset.step);
      b.classList.toggle('active', s === wizStep);
      b.classList.toggle('done', s < wizStep);
    });
    for (let i = 1; i <= 5; i++) {
      $(`wizPane${i}`)?.classList.toggle('active', i === wizStep);
    }
    $('btnWizPrev').disabled = wizStep === 1;
    $('btnWizNext').style.display = wizStep < 5 ? 'inline-flex' : 'none';
    $('btnWizFinish').style.display = wizStep === 5 ? 'inline-flex' : 'none';
    syncWizardFieldsFromConfig();
  }

  async function saveWizardProgress() {
    if (remoteMode) return;
    const activeWizVcs = document.querySelector('#wizVcsSegmented button.active');
    const partial = {
      VcsMode: activeWizVcs ? activeWizVcs.dataset.mode : cfg.VcsMode,
      UE5Root: $('wizUE5Root').value.trim(),
      ProjectDir: $('wizProjectDir').value.trim(),
      ArchiveRoot: $('wizArchiveRoot').value.trim() || 'C:\\BuildArchive',
      EnablePackageRetention: $('wizEnableRetain').checked,
      MaxRetainedPackages: Math.max(1, Math.min(200, Number($('wizMaxPkgs').value) || 10)),
      P4Port: $('wizP4Port').value.trim() || 'localhost:1666',
      P4User: $('wizP4User').value.trim() || 'p4bot',
      P4Stream: $('wizP4Stream').value.trim() || '//MyProject/main',
      P4BuildClient: $('wizP4BuildClient').value.trim() || 'ws-build-full',
      P4MirrorClient: $('wizP4MirrorClient').value.trim() || 'ws-mirror-code',
      DiscordWebhookUrl: $('wizDiscordUrl').value.trim(),
      SlackBotToken: $('wizSlackToken').value.trim(),
      SlackChannelId: $('wizSlackChannel').value.trim(),
      TailscaleIP: $('wizTailscaleIp').value.trim(),
      RemoteWebDashboardEnabled: $('wizWebEnabled').checked,
    };
    const saved = await safeCall(() => api.invoke('config:save', partial));
    if (saved) {
      cfg = saved;
      hydrateConfigToUI();
      refreshPackages();
    }
  }

  async function openWizard(startStep = 1) {
    if (remoteMode) return;
    syncWizardFieldsFromConfig();
    setWizardStep(startStep);
    openModal('modalWizard');
    await runWizardDiagnostics();
  }

  // Wizard button bindings
  $('btnOpenWizardSide')?.addEventListener('click', () => openWizard(1));
  $('btnOpenWizardDash')?.addEventListener('click', () => openWizard(1));

  document.querySelectorAll('#wizardStepper .wiz-step-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      await saveWizardProgress();
      setWizardStep(Number(b.dataset.step));
    });
  });

  document.querySelectorAll('#wizVcsSegmented button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('#wizVcsSegmented button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      const saved = await safeCall(() => api.invoke('config:save', { VcsMode: mode }));
      if (saved) {
        cfg = saved;
        hydrateConfigToUI();
        syncWizardFieldsFromConfig();
      }
      await runWizardDiagnostics(mode);
    });
  });

  $('btnWizRescan')?.addEventListener('click', () => runWizardDiagnostics());
  $('wizSelUE5')?.addEventListener('change', () => {
    if ($('wizSelUE5').value) $('wizUE5Root').value = $('wizSelUE5').value;
  });
  $('btnWizInitDirs')?.addEventListener('click', async () => {
    await saveWizardProgress();
    const r = await safeCall(() => api.invoke('system:initDirs'));
    if (r) {
      toast(`필수 폴더 생성 및 스크립트 ${r.deployed.length}종 배치 완료!`, 'success');
      runWizardDiagnostics();
    }
  });
  $('btnWizConnectGh')?.addEventListener('click', () => {
    $('txtModalGhToken').value = cfg.GitHubAccessToken || '';
    openModal('modalRepo');
  });
  $('btnWizPushWf')?.addEventListener('click', async () => {
    const branch = cfg.LastBranch || 'main';
    const tplType = cfg.VcsMode === 'PerforceHybrid' ? 'perforce' : 'git';
    await safeCall(() => api.invoke('github:pushWorkflow', { branch, templateType: tplType }), `'${branch}' 브랜치에 build.yml 등록 완료!`);
  });
  $('btnWizDlRunner')?.addEventListener('click', async () => {
    const r = await safeCall(() => api.invoke('runner:download'), 'Runner 다운로드 완료!');
    if (r && r.status && appState) {
      appState.runner = r.status;
      renderState();
    }
  });
  $('btnWizRegRunner')?.addEventListener('click', async () => {
    const r = await safeCall(() => api.invoke('runner:register'), 'Runner 자동 등록 완료!');
    if (r && r.status && appState) {
      appState.runner = r.status;
      renderState();
    }
  });
  $('btnWizStartRunner')?.addEventListener('click', async () => {
    const st = await safeCall(() => api.invoke('runner:start'), 'Runner 가동 시작!');
    if (st && appState) {
      appState.runner = st;
      renderState();
    }
  });
  $('btnWizP4Test')?.addEventListener('click', async () => {
    await saveWizardProgress();
    const r = await safeCall(() => api.invoke('p4:test'));
    const box = $('wizP4DiagOut');
    if (!r) return;
    box.style.display = 'block';
    box.innerHTML = r.ok
      ? `<span style="color:#34d399; font-weight:700;">✔ P4 연결 성공!</span> Unicode: ${r.unicodeMode ? 'ON' : 'OFF'} · 티켓: ${r.ticketOk ? '유효' : '로그인 필요'} · 빌드 Root: <code>${escapeHtml(r.buildRoot || '미조회')}</code>`
      : `<span style="color:#fb7185; font-weight:700;">✖ 연결 실패:</span> ${escapeHtml(r.rawError)}`;
  });
  $('btnWizCloneMirror')?.addEventListener('click', async () => {
    await saveWizardProgress();
    const r = await safeCall(() => api.invoke('github:clone'));
    if (r) toast(r.alreadyExists ? `이미 클론됨: ${r.targetDir}` : `미러 저장소 클론 완료: ${r.targetDir}`, 'success');
  });
  $('btnWizInitWm')?.addEventListener('click', async () => {
    await saveWizardProgress();
    await safeCall(() => api.invoke('p4:mirrorRun', { initWatermark: true }), '현재 P4 HEAD로 워터마크 초기화 완료!');
  });
  $('btnWizRegMirrorTask')?.addEventListener('click', async () => {
    await saveWizardProgress();
    const r = await safeCall(() => api.invoke('p4:registerMirrorTask'));
    if (r) toast(r.ok ? 'Windows 자동 미러링 작업 스케줄러 등록 완료!' : r.message, r.ok ? 'success' : 'error');
  });
  $('btnWizOpenP4Provision')?.addEventListener('click', async () => {
    await saveWizardProgress();
    closeModal('modalWizard');
    switchView('perforce');
    document.querySelector('.content-area')?.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('btnWizOpenTeam')?.addEventListener('click', async () => {
    await saveWizardProgress();
    const saved = await safeCall(() => api.invoke('wizard:complete', { completed: true }));
    if (saved) {
      cfg = saved;
      hydrateConfigToUI();
    }
    closeModal('modalWizard');
    switchView('team');
    refreshTeamTab();
  });
  $('btnWizGitClone')?.addEventListener('click', async () => {
    const r = await safeCall(() => api.invoke('github:clone'));
    if (r) toast(r.alreadyExists ? `이미 클론됨: ${r.targetDir}` : `클론 완료: ${r.targetDir}`, 'success');
  });
  $('btnWizGitAssets')?.addEventListener('click', () => safeCall(() => api.invoke('assets:link'), '제외 에셋 심볼릭 링크 연결 완료!'));
  $('btnWizTestDiscord')?.addEventListener('click', async () => {
    await saveWizardProgress();
    const r = await safeCall(() => api.invoke('notify:testDiscord'));
    if (r) toast(r.message, r.ok ? 'success' : 'error');
  });
  $('btnWizTestSlack')?.addEventListener('click', async () => {
    await saveWizardProgress();
    const r = await safeCall(() => api.invoke('notify:testSlack'));
    if (r) toast(r.message, r.ok ? 'success' : 'error');
  });
  $('btnWizDetectIp')?.addEventListener('click', async () => {
    const net = await safeCall(() => api.invoke('system:network'));
    if (net) {
      $('wizTailscaleIp').value = net.recommended;
      toast(`IP 감지됨: ${net.recommended}`, 'success');
    }
  });

  $('btnWizPrev')?.addEventListener('click', async () => {
    await saveWizardProgress();
    setWizardStep(wizStep - 1);
  });
  $('btnWizNext')?.addEventListener('click', async () => {
    await saveWizardProgress();
    setWizardStep(wizStep + 1);
  });
  $('btnWizSkip')?.addEventListener('click', async () => {
    if ($('chkWizDontAutoOpen').checked) {
      const saved = await safeCall(() => api.invoke('wizard:complete', { completed: true }));
      if (saved) cfg = saved;
    }
    closeModal('modalWizard');
  });
  $('btnWizFinish')?.addEventListener('click', async () => {
    await saveWizardProgress();
    const saved = await safeCall(() => api.invoke('wizard:complete', { completed: true }), '초기 설정이 완료되었습니다!');
    if (saved) {
      cfg = saved;
      hydrateConfigToUI();
    }
    closeModal('modalWizard');
  });

  // ---------------------------------------------------------------------------
  // Blank UE5 Project Generator Modal (Installed Versions Only + P4 CL #1)
  // ---------------------------------------------------------------------------
  let ueGenInstalledList = [];
  let ueGenType = 'cpp';
  let ueGenDirManuallyEdited = false;

  function updateUeGenSubmitBtnLabel() {
    const isP4 = (cfg.VcsMode || 'PerforceHybrid') === 'PerforceHybrid';
    const doP4 = isP4 && $('chkUeGenP4Submit').checked;
    $('ueGenP4Fields').style.display = doP4 ? 'grid' : 'none';
    $('btnUeGenCreate').textContent = doP4 ? '✨ 빈 UE5 프로젝트 생성 + P4 최초 Submit' : '✨ 로컬 빈 UE5 프로젝트 생성';
  }

  async function refreshUeGenEngines() {
    const sel = $('selUeGenEngine');
    const hint = $('lblUeGenEngineHint');
    sel.innerHTML = '<option value="">설치된 Unreal Engine 5 스캔 중...</option>';
    const list = await safeCall(() => api.invoke('ue:listInstalled'));
    ueGenInstalledList = Array.isArray(list) ? list : [];
    sel.innerHTML = '';

    if (ueGenInstalledList.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '이 PC에 설치된 Unreal Engine 5를 찾을 수 없습니다';
      sel.appendChild(opt);
      hint.innerHTML = '<span style="color:#fb7185;">⚠️ Epic Games Launcher에서 UE5를 먼저 설치한 뒤 [다시 스캔]을 눌러 주세요.</span>';
      $('btnUeGenCreate').disabled = true;
      return;
    }

    for (const eng of ueGenInstalledList) {
      const opt = document.createElement('option');
      opt.value = eng.path;
      const tplTag = eng.hasCppTemplate ? '공식 템플릿 ✔' : '표준 내장 생성';
      opt.textContent = `UE ${eng.version} (${eng.fullVersion}) — ${eng.path} [${tplTag}]`;
      if (cfg.UE5Root && cfg.UE5Root.toLowerCase() === eng.path.toLowerCase()) opt.selected = true;
      sel.appendChild(opt);
    }
    hint.textContent = `이 PC에서 ${ueGenInstalledList.length}개의 UE5 설치를 감지했습니다. 선택한 버전 폴더의 공식 Blank 템플릿을 사용합니다.`;
    $('btnUeGenCreate').disabled = false;
  }

  async function openUeProjectModal() {
    if (remoteMode) return;
    ueGenDirManuallyEdited = false;
    $('ueGenResultBox').style.display = 'none';
    $('ueGenResultBox').innerHTML = '';

    const stream = cfg.P4Stream || '//MyProject/main';
    const depotGuess = stream.replace(/^\/\//, '').split('/')[0] || '';
    const defaultName = /^[A-Za-z][A-Za-z0-9_]{1,19}$/.test(depotGuess) && depotGuess.toLowerCase() !== 'myproject'
      ? depotGuess
      : '';
    $('txtUeGenName').value = defaultName;
    const baseWs = cfg.WorkspaceRoot || 'C:\\BuildSystem\\Workspace';
    $('txtUeGenDir').value = defaultName ? `${baseWs}\\${defaultName}` : (cfg.ProjectDir || `${baseWs}\\MyProject`);

    const isP4 = (cfg.VcsMode || 'PerforceHybrid') === 'PerforceHybrid';
    $('ueGenP4SubmitBox').style.display = isP4 ? 'block' : 'none';
    $('chkUeGenP4Submit').checked = isP4;
    $('txtUeGenStream').value = stream;
    $('txtUeGenAdmin').value =
      $('txtProvAdminUser')?.value.trim() ||
      $('txtTeamAdminUser')?.value.trim() ||
      (cfg.P4User && cfg.P4User.toLowerCase() !== 'p4bot' ? cfg.P4User : '');

    updateUeGenSubmitBtnLabel();
    openModal('modalUeProject');
    await refreshUeGenEngines();
  }

  $('btnOpenUeGen')?.addEventListener('click', openUeProjectModal);
  $('btnWizOpenUeGen')?.addEventListener('click', async () => {
    await saveWizardProgress();
    openUeProjectModal();
  });
  $('btnWizOpenUeGenGit')?.addEventListener('click', async () => {
    await saveWizardProgress();
    openUeProjectModal();
  });
  $('btnUeGenRescan')?.addEventListener('click', refreshUeGenEngines);

  document.querySelectorAll('#segUeGenType button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#segUeGenType button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      ueGenType = btn.dataset.type || 'cpp';
    });
  });

  $('txtUeGenName')?.addEventListener('input', () => {
    if (ueGenDirManuallyEdited) return;
    const n = $('txtUeGenName').value.trim();
    const baseWs = cfg.WorkspaceRoot || 'C:\\BuildSystem\\Workspace';
    if (n) $('txtUeGenDir').value = `${baseWs}\\${n}`;
  });
  $('txtUeGenDir')?.addEventListener('input', () => {
    ueGenDirManuallyEdited = true;
  });
  $('chkUeGenP4Submit')?.addEventListener('change', updateUeGenSubmitBtnLabel);

  $('btnUeGenCreate')?.addEventListener('click', async () => {
    const ue5Root = $('selUeGenEngine').value;
    const projectName = $('txtUeGenName').value.trim();
    const targetDir = $('txtUeGenDir').value.trim();
    const isP4 = (cfg.VcsMode || 'PerforceHybrid') === 'PerforceHybrid';
    const submitToPerforce = isP4 && $('chkUeGenP4Submit').checked;
    const adminUser = $('txtUeGenAdmin').value.trim();
    const p4Stream = $('txtUeGenStream').value.trim();

    if (!ue5Root) return toast('먼저 PC에 설치된 Unreal Engine 5 버전을 선택해 주세요.', 'error');
    if (!projectName) return toast('프로젝트 이름을 입력해 주세요.', 'error');
    if (submitToPerforce && !adminUser) return toast('Perforce 최초 Submit에 사용할 관리자 P4 ID를 입력해 주세요.', 'error');

    const btn = $('btnUeGenCreate');
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = submitToPerforce ? '생성 및 Perforce Submit 중...' : '프로젝트 생성 중...';

    const res = await safeCall(() =>
      api.invoke('ue:createBlankProject', {
        ue5Root,
        projectName,
        projectType: ueGenType,
        targetDir,
        includeP4Ignore: $('chkUeGenP4Ignore').checked,
        includeGitIgnore: $('chkUeGenGitIgnore').checked,
        submitToPerforce,
        adminUser,
        p4Stream,
        updateProjectDirConfig: $('chkUeGenSyncCfg').checked,
      })
    );

    btn.disabled = false;
    btn.textContent = origText;

    if (!res || !res.ok) return;

    const latestCfg = await safeCall(() => api.invoke('config:get'));
    if (latestCfg) {
      cfg = latestCfg;
      hydrateConfigToUI();
      syncWizardFieldsFromConfig();
    }

    const p4Line = res.p4Submit && res.p4Submit.ok
      ? `<li><strong>Perforce 최초 Submit:</strong> ✔ <code>${escapeHtml(res.p4Submit.stream)}</code> → <strong>CL #${escapeHtml(res.p4Submit.cl)}</strong> 등록 및 <code>ws-build-full</code> 동기화 완료!</li>`
      : '';
    const mirrorBtnHtml = res.p4Submit && res.p4Submit.ok
      ? `<button id="btnUeGenTestMirror" class="btn btn-sm btn-primary">↻ 지금 1회 미러링 테스트 (GitHub 첫 빌드)</button>`
      : '';

    const box = $('ueGenResultBox');
    box.style.display = 'block';
    box.innerHTML = `
      <div class="wiz-tip-title">🎉 빈 UE ${escapeHtml(res.engineVersion)} (${res.projectType === 'cpp' ? 'C++' : 'Blueprint'}) 프로젝트 생성 완료!</div>
      <ul class="wiz-tip-list">
        <li><strong>프로젝트 파일:</strong> <code>${escapeHtml(res.uprojectPath)}</code> (총 ${res.filesCreated.length}개 정석 파일, 캐시 0개)</li>
        ${p4Line}
      </ul>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
        <button id="btnUeGenOpenFolder" class="btn btn-sm">📂 프로젝트 폴더 열기</button>
        ${mirrorBtnHtml}
      </div>
    `;

    $('btnUeGenOpenFolder')?.addEventListener('click', () => api.invoke('system:openFolder', res.targetDir));
    $('btnUeGenTestMirror')?.addEventListener('click', async () => {
      closeModal('modalUeProject');
      closeModal('modalWizard');
      switchView('dashboard');
      await safeCall(() => api.invoke('p4:mirrorRun', {}), '미러링 완료! GitHub Actions에서 첫 QuickVerify 빌드가 시작됩니다.');
      refreshMirrorStatus();
    });

    toast(
      res.p4Submit && res.p4Submit.ok
        ? `🎉 ${res.projectName} 생성 + Perforce CL #${res.p4Submit.cl} Submit 완료!`
        : `🎉 ${res.projectName} 빈 프로젝트 생성 완료!`,
      'success'
    );
  });

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  async function bootstrap(silent = false) {
    const snap = await safeCall(() => api.invoke('state:snapshot'));
    if (snap) {
      appState = snap.state;
      consoleLines = snap.consoleLines || [];
      errorLines = snap.errorLines || [];
      remoteMode = Boolean(snap.remoteMode);
      readOnlyMode = Boolean(snap.readOnly);
    }

    const loadedCfg = await safeCall(() => api.invoke('config:get'));
    if (loadedCfg) {
      cfg = loadedCfg;
      hydrateConfigToUI();
    }

    applyRemoteRestrictions();
    renderState();
    renderTerminal();
    refreshPackages();
    refreshMirrorStatus();

    if (!remoteMode) {
      refreshBranches();
      const mapRows = await safeCall(() => api.invoke('config:authorMap:get'));
      if (mapRows) {
        authorMapRows = mapRows;
        renderAuthorMap();
      }
      refreshTeamTab();
      if ((cfg.VcsMode || 'PerforceHybrid') === 'PerforceHybrid') {
        refreshP4Logs(true);
      }
      // ★ PC 최초 실행 시 설정 마법사 자동 작동!
      if (!silent && !cfg.SetupCompleted) {
        openWizard(1);
      }
    }
    if (silent) toast('상태를 새로고침했습니다.', 'info');
  }

  bootstrap();
})();
