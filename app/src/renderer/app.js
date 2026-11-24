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
    if (viewId === 'perforce') refreshMirrorStatus();
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
    const mirrorVal = mirror.lastCL ? `CL #${mirror.lastCL}` : 'CL #0';
    $('kpiMirrorVal').textContent = mirrorVal;
    $('mirrorLiveBadge').textContent = mirror.running ? '동기화 중...' : mirrorVal;
    $('kpiMirrorBadge').textContent = mirror.running ? '실행 중' : mirror.autoEnabled ? '자동 ON' : '수동';
    $('kpiMirrorBadge').className = mirror.running ? 'badge badge-blue' : mirror.autoEnabled ? 'badge badge-green' : 'badge badge-slate';
    $('kpiMirrorSub').textContent = mirror.lastMessage || '대기 중';
    $('navMirrorBadge').textContent = mirror.autoEnabled ? 'AUTO' : 'OFF';
    $('navMirrorBadge').className = mirror.autoEnabled ? 'nav-badge ok' : 'nav-badge';

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
        <div style="margin-top:4px;">• 버전: ${escapeHtml(res.serverVersion)} · Unicode: <strong>${res.unicodeMode ? '활성화됨' : '미감지'}</strong></div>
        <div>• 티켓 상태: ${res.ticketOk ? `<span style="color:#34d399;">유효 (${escapeHtml(res.ticketMessage)})</span>` : `<span style="color:#fbbf24;">확인 필요 (${escapeHtml(res.ticketMessage)})</span>`}</div>
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
          <div class="diag-card-actions">${wingetBtn}${dlBtn}</div>
        </div>`;
      })
      .join('');

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
    await safeCall(() => api.invoke('runner:download'), 'Runner 다운로드 완료!');
    syncWizardFieldsFromConfig();
  });
  $('btnWizRegRunner')?.addEventListener('click', async () => {
    await safeCall(() => api.invoke('runner:register'), 'Runner 자동 등록 완료!');
    syncWizardFieldsFromConfig();
  });
  $('btnWizStartRunner')?.addEventListener('click', async () => {
    await safeCall(() => api.invoke('runner:start'), 'Runner 가동 시작!');
    syncWizardFieldsFromConfig();
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
  $('btnWizCopyP4Guide')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText($('wizP4Cheat').textContent || '');
    toast('Perforce 초기 세팅 명령어가 복사되었습니다.', 'success');
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
      // ★ PC 최초 실행 시 설정 마법사 자동 작동!
      if (!silent && !cfg.SetupCompleted) {
        openWizard(1);
      }
    }
    if (silent) toast('상태를 새로고침했습니다.', 'info');
  }

  bootstrap();
})();
