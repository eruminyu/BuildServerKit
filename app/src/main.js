const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { ConfigStore } = require('./core/configStore');
const { StateHub } = require('./core/stateHub');
const {
  detectNetworkIPs,
  getPackageArchiveSummary,
  applyPackageRetention,
  deletePackageFolder,
  getBuildHistory,
  readBuildLogFile,
  initBuildDirectories,
  discoverIgnoredContentFolders,
  ensureAssetJunctions,
} = require('./core/systemService');
const { P4Service } = require('./core/p4Service');
const { P4ProvisionService } = require('./core/p4ProvisionService');
const { BuildService } = require('./core/buildService');
const { GitHubService } = require('./core/githubService');
const { RemoteWebServer } = require('./core/webServer');
const { runFullDiagnostics, installViaWinget } = require('./core/diagnosticsService');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let trayNoticeShown = false;

const kitDir = app.isPackaged ? path.join(process.resourcesPath, 'kit') : path.resolve(__dirname, '..', '..');
const rendererDir = path.join(__dirname, 'renderer');

const configStore = new ConfigStore(kitDir);
const stateHub = new StateHub();
const p4Service = new P4Service(configStore, stateHub);
const p4ProvisionService = new P4ProvisionService(configStore, stateHub);
const buildService = new BuildService(configStore, stateHub, p4Service);
const githubService = new GitHubService(configStore, stateHub, buildService);
const webServer = new RemoteWebServer({ rendererDir, configStore, stateHub, buildService, p4Service });

// Single-instance lock so 24/7 laptop never spawns duplicate runner/mirror managers
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createTrayIcon(forTray = false) {
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(iconPng)) {
    const img = nativeImage.createFromPath(iconPng);
    return forTray ? img.resize({ width: 32, height: 32 }) : img;
  }
  return nativeImage.createEmpty();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideToTrayWithNotice() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  if (tray && !trayNoticeShown && typeof tray.displayBalloon === 'function') {
    trayNoticeShown = true;
    try {
      tray.displayBalloon({
        iconType: 'info',
        title: 'BuildServerKit Studio',
        content: '시스템 트레이에서 백그라운드로 계속 실행 중입니다. 트레이 아이콘을 클릭하면 다시 열립니다.',
      });
    } catch {}
  }
}

function setupTray() {
  try {
    tray = new Tray(createTrayIcon(true));
    tray.setToolTip('BuildServerKit Studio — 클릭하여 창 열기 (우클릭: 완전 종료)');
    const menu = Menu.buildFromTemplate([
      {
        label: 'BuildServerKit Studio 열기',
        click: () => showMainWindow(),
      },
      { type: 'separator' },
      {
        label: '지금 P4 → GitHub 미러링 실행',
        click: () => p4Service.runMirrorOnce().catch(() => {}),
      },
      {
        label: '패키징 보관함 폴더 열기',
        click: () => {
          const p = path.join(configStore.get().ArchiveRoot || 'C:\\BuildArchive', 'Packages');
          if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
          shell.openPath(p);
        },
      },
      { type: 'separator' },
      {
        label: '완전 종료',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
  } catch {}
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    center: true,
    frame: false,
    backgroundColor: '#090c12',
    title: 'BuildServerKit Studio',
    icon: createTrayIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  stateHub.attachWindow(mainWindow);
  mainWindow.loadFile(path.join(rendererDir, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized', false);
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && tray && configStore.get().MinimizeToTrayOnClose !== false) {
      e.preventDefault();
      hideToTrayWithNotice();
    }
  });
}

function registerIpcHandlers() {
  // Window controls
  ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:hideToTray', () => hideToTrayWithNotice());
  ipcMain.handle('window:close', () => {
    if (tray && configStore.get().MinimizeToTrayOnClose !== false) {
      hideToTrayWithNotice();
    } else {
      isQuitting = true;
      app.quit();
    }
  });

  // Config & System
  ipcMain.handle('state:snapshot', () => ({
    ...stateHub.getSnapshot(),
    remoteMode: false,
    readOnly: false,
  }));
  ipcMain.handle('config:get', () => configStore.get());
  ipcMain.handle('config:save', async (_e, partial) => {
    const updated = configStore.save(partial || {});
    p4Service.syncAutoMirrorTimer();
    await webServer.start();
    return updated;
  });
  ipcMain.handle('config:factoryReset', async () => {
    p4Service.stopAutoMirrorTimer();
    await webServer.stop();
    await githubService.stopRunner();
    githubService.stopApiPoller();
    return configStore.factoryReset();
  });
  ipcMain.handle('config:authorMap:get', () => configStore.loadAuthorMap());
  ipcMain.handle('config:authorMap:save', (_e, entries) => configStore.saveAuthorMap(entries));

  ipcMain.handle('system:network', () => detectNetworkIPs());
  ipcMain.handle('system:initDirs', () => initBuildDirectories(configStore));
  ipcMain.handle('system:pickFolder', async (_e, defaultPath) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('system:openFolder', async (_e, targetPath) => {
    if (!targetPath) return false;
    if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
    await shell.openPath(targetPath);
    return true;
  });
  ipcMain.handle('system:openExternal', async (_e, url) => {
    if (url && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  // Packages & Retention
  ipcMain.handle('packages:list', () => getPackageArchiveSummary(configStore.get()));
  ipcMain.handle('packages:pruneNow', () => {
    const cfg = configStore.get();
    const res = applyPackageRetention(cfg);
    const summary = getPackageArchiveSummary(cfg);
    stateHub.broadcast('packages:updated', summary);
    return { ...res, summary };
  });
  ipcMain.handle('packages:delete', (_e, folderName) => {
    const cfg = configStore.get();
    const res = deletePackageFolder(cfg, folderName);
    const summary = getPackageArchiveSummary(cfg);
    stateHub.broadcast('packages:updated', summary);
    return { ...res, summary };
  });

  // History & Logs
  ipcMain.handle('history:list', () => getBuildHistory(configStore.get()));
  ipcMain.handle('history:readLog', (_e, filePath) => readBuildLogFile(configStore.get(), filePath));
  ipcMain.handle('console:clear', () => stateHub.clearConsole());

  // Asset Junctions (Git mode)
  ipcMain.handle('assets:discover', () => discoverIgnoredContentFolders(configStore.get()));
  ipcMain.handle('assets:link', () => ensureAssetJunctions(configStore.get()));

  // Build & Reports
  ipcMain.handle('build:sync', (_e, { branch, targetCL } = {}) => buildService.syncSource(branch, targetCL));
  ipcMain.handle('build:start', (_e, { mode, branch, changelist, clientConfig } = {}) => {
    buildService.startBuild(mode || 'QuickVerify', { branch, changelist, clientConfig }).catch((err) => {
      stateHub.appendLog(`[빌드 시작 오류] ${err.message}`, 'error');
    });
    return { ok: true, started: true };
  });
  ipcMain.handle('build:stop', () => buildService.stopBuild());
  ipcMain.handle('build:makeLauncherManual', async (_e, folderPath) => {
    let dir = folderPath;
    if (!dir) {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: '런처를 생성할 패키징 결과물 폴더 선택',
        defaultPath: path.join(configStore.get().ArchiveRoot || 'C:\\BuildArchive', 'Packages'),
        properties: ['openDirectory'],
      });
      if (picked.canceled) return { ok: false, canceled: true };
      dir = picked.filePaths[0];
    }
    return await buildService.generateLauncher(dir);
  });
  ipcMain.handle('notify:testSlack', () => buildService.testSlackConnection());
  ipcMain.handle('notify:testDiscord', () => buildService.testDiscordWebhook());
  ipcMain.handle('notify:sendManual', async () => {
    const b = stateHub.state.build;
    if (!b.currentLogPath || !fs.existsSync(b.currentLogPath)) {
      throw new Error('전송할 최근 빌드 로그가 없습니다.');
    }
    return await buildService.sendReports({
      projectName: b.projectName || 'UEProject',
      exitCode: b.lastExitCode ?? 0,
      mode: b.mode || 'QuickVerify',
      branch: b.branch || 'main',
      ref: b.ref || 'latest',
      author: b.author || 'builder',
      message: b.message || '(수동 전송)',
      duration: b.duration || '00분 00초',
      logArchiveDir: b.currentArchiveDir,
      uatLogFile: b.currentLogPath,
    });
  });

  // Perforce & Mirror & Backup
  ipcMain.handle('p4:test', () => p4Service.testConnection());
  ipcMain.handle('p4:recentCLs', (_e, limit) => p4Service.getRecentCLs(limit || 12));
  ipcMain.handle('p4:mirrorStatus', () => p4Service.getMirrorStatus());
  ipcMain.handle('p4:mirrorRun', (_e, opts) => p4Service.runMirrorOnce(opts || {}));
  ipcMain.handle('p4:registerMirrorTask', () => p4Service.registerMirrorTaskScheduler());
  ipcMain.handle('p4:unregisterMirrorTask', () => p4Service.unregisterMirrorTaskScheduler());
  ipcMain.handle('p4:backupRun', (_e, opts) => p4Service.runBackupOnce(opts || {}));
  ipcMain.handle('p4:registerBackupTask', (_e, { time, adminUser } = {}) =>
    p4Service.registerBackupTaskScheduler(time || '04:00', adminUser || 'admin')
  );
  ipcMain.handle('p4:team:list', (_e, { adminUser } = {}) => p4Service.listUsersAndQuotas(adminUser || ''));
  ipcMain.handle('p4:team:upsertUser', (_e, payload) => p4Service.upsertP4User(payload || {}));
  ipcMain.handle('p4:team:deleteUser', (_e, payload) => p4Service.deleteP4User(payload || {}));
  ipcMain.handle('p4:team:lockAutoCreate', (_e, { adminUser } = {}) => p4Service.lockAutoUserCreate(adminUser || ''));

  // Perforce Full GUI Provisioning (Install -> Unicode/Firewall -> Stream -> Typemap -> p4bot -> Workspaces -> .p4ignore)
  ipcMain.handle('p4prov:status', (_e, { adminUser } = {}) => p4ProvisionService.inspectStatus(adminUser || ''));
  ipcMain.handle('p4prov:installP4D', () => p4ProvisionService.downloadAndRunP4DInstaller());
  ipcMain.handle('p4prov:installP4V', () => p4ProvisionService.installP4ClientViaWinget());
  ipcMain.handle('p4prov:enableUnicode', (_e, { p4Root } = {}) => p4ProvisionService.enableUnicodeAndEnvironment(p4Root || ''));
  ipcMain.handle('p4prov:openFirewall', () => p4ProvisionService.openFirewallPorts());
  ipcMain.handle('p4prov:login', (_e, payload) => p4ProvisionService.loginP4User(payload || {}));
  ipcMain.handle('p4prov:setupStream', (_e, payload) => p4ProvisionService.setupStreamDepot(payload || {}));
  ipcMain.handle('p4prov:applyTypemap', (_e, payload) => p4ProvisionService.applyUe5Typemap(payload || {}));
  ipcMain.handle('p4prov:setupBot', (_e, payload) => p4ProvisionService.setupReadOnlyBot(payload || {}));
  ipcMain.handle('p4prov:createWorkspaces', (_e, payload) => p4ProvisionService.createStandardWorkspaces(payload || {}));
  ipcMain.handle('p4prov:createP4Ignore', (_e, { targetDir } = {}) => p4ProvisionService.createUe5P4Ignore(targetDir || ''));
  ipcMain.handle('p4prov:runAll', (_e, payload) => p4ProvisionService.runOneClickProvisionAll(payload || {}));

  // GitHub & Runner
  ipcMain.handle('github:ghToken', () => githubService.getGhCliToken());
  ipcMain.handle('github:fetchRepos', (_e, token) => githubService.fetchUserAndRepos(token));
  ipcMain.handle('github:lookupProfile', (_e, input) => githubService.lookupGitHubProfile(input));
  ipcMain.handle('github:branches', () => githubService.fetchBranches());
  ipcMain.handle('github:workflowTemplate', (_e, type) => githubService.getWorkflowTemplate(type));
  ipcMain.handle('github:scanWorkflow', (_e, branch) => githubService.scanWorkflow(branch));
  ipcMain.handle('github:pushWorkflow', (_e, { branch, templateType }) => githubService.pushWorkflow(branch, templateType));
  ipcMain.handle('github:clone', () => githubService.cloneGitWorkspace());
  ipcMain.handle('runner:status', () => githubService.getRunnerStatus());
  ipcMain.handle('runner:download', () => githubService.downloadRunner());
  ipcMain.handle('runner:register', () => githubService.registerRunner());
  ipcMain.handle('runner:start', () => githubService.startRunner());
  ipcMain.handle('runner:stop', () => githubService.stopRunner());
  ipcMain.handle('runner:togglePoller', () => githubService.toggleApiPoller());

  // Web Server
  ipcMain.handle('web:restart', () => webServer.start());

  // First-Run Setup Wizard & PC Environment Diagnostics
  ipcMain.handle('diag:run', async (_e, { vcsMode } = {}) => {
    const report = await runFullDiagnostics(configStore, vcsMode || '');
    // Auto-fill detected UE5Root & Tailscale IP when blank (distribution-friendly!)
    const cur = configStore.get();
    const patch = {};
    if ((!cur.UE5Root || !fs.existsSync(path.join(cur.UE5Root, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat'))) && report.ueInstallations.length > 0) {
      patch.UE5Root = report.ueInstallations[0].path;
    }
    if (!cur.TailscaleIP && report.network && report.network.tailscaleIp) {
      patch.TailscaleIP = report.network.tailscaleIp;
    }
    if (Object.keys(patch).length > 0) {
      configStore.save(patch);
      report.autoPatched = patch;
    }
    return report;
  });

  ipcMain.handle('diag:wingetInstall', (_e, wingetKey) => installViaWinget(wingetKey, stateHub));

  ipcMain.handle('wizard:complete', (_e, { completed = true } = {}) => {
    return configStore.save({ SetupCompleted: Boolean(completed) });
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  setupTray();
  createMainWindow();

  stateHub.appendLog('=== BuildServerKit Studio v2.0 (Perforce Hybrid + GitHub Actions + Tailscale) ===', 'cyan');
  p4Service.getMirrorStatus();
  p4Service.syncAutoMirrorTimer();
  await githubService.getRunnerStatus();
  await webServer.start();
});

app.on('before-quit', async () => {
  isQuitting = true;
  p4Service.stopAutoMirrorTimer();
  githubService.stopApiPoller();
  await webServer.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
