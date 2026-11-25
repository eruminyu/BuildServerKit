const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  SetupCompleted: false,
  VcsMode: 'PerforceHybrid',
  UE5Root: '',
  WorkspaceRoot: 'C:\\BuildSystem\\Workspace',
  ProjectDir: '',
  SharedAssetsDir: 'C:\\BuildSystem\\SharedAssets',
  ArchiveRoot: 'C:\\BuildArchive',
  RunnerDir: 'C:\\actions-runner',

  P4Port: 'localhost:1666',
  P4User: 'p4bot',
  P4Stream: '//MyProject/main',
  P4BuildClient: 'ws-build-full',
  P4MirrorClient: 'ws-mirror-code',
  P4MirrorDir: 'C:\\BuildSystem\\P4MirrorRepo',
  P4DepotRoot: 'C:\\Perforce\\Server',
  P4BackupRoot: 'D:\\P4Backup',
  P4RetainCheckpoints: 7,
  P4MirrorIntervalMinutes: 2,
  P4AutoMirrorEnabled: false,
  P4MirrorAssetLogPath: '.p4-sync/asset_changelog.md',

  GitHubUser: '',
  GitHubAccessToken: '',
  ConnectedRepoFullName: '',
  GitRemoteUrl: '',
  GitHubRepoUrl: '',
  RunnerToken: '',
  LastBranch: 'main',

  ClientConfig: 'Development',
  DefaultQualityPreset: 'Epic',
  DefaultResolution: '1920x1080',
  DefaultWindowMode: 'WindowedFullscreen',
  DefaultFrameRateLimit: 0,
  DefaultVSync: false,
  GenerateLauncherOnPackage: true,

  EnablePackageRetention: true,
  MaxRetainedPackages: 10,

  SlackBotToken: '',
  SlackChannelId: '',
  AutoSendSlack: true,
  DiscordWebhookUrl: '',
  AutoSendDiscord: true,

  TailscaleIP: '',
  RemoteWebDashboardEnabled: false,
  RemoteWebDashboardPort: 3780,
  RemoteWebDashboardReadOnly: true,
  MinimizeToTrayOnClose: true,
};

const SCRIPTS_DIR = 'C:\\BuildSystem\\Scripts';

class ConfigStore {
  constructor(kitDir) {
    this.kitDir = kitDir;
    const persistDir = process.env.PORTABLE_EXECUTABLE_DIR || kitDir;
    this.persistDir = persistDir;
    this.localConfigPath = path.join(persistDir, 'build_manager_config.json');
    this.scriptsConfigPath = path.join(SCRIPTS_DIR, 'build_manager_config.json');
    this.config = this.load();
  }

  getKitDir() {
    return this.kitDir;
  }

  getScriptsDir() {
    return SCRIPTS_DIR;
  }

  resolveScriptPath(fileName) {
    const inScripts = path.join(SCRIPTS_DIR, fileName);
    if (fs.existsSync(inScripts)) return inScripts;
    const inKit = path.join(this.kitDir, fileName);
    if (fs.existsSync(inKit)) return inKit;
    return inKit;
  }

  load() {
    let loaded = {};
    const candidates = [this.localConfigPath, this.scriptsConfigPath];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
          const parsed = JSON.parse(raw);
          loaded = { ...loaded, ...parsed };
          break;
        } catch {
          // ignore corrupted file and fall back
        }
      }
    }
    this.config = this._normalize({ ...DEFAULT_CONFIG, ...loaded });
    return this.config;
  }

  _normalize(cfg) {
    const out = { ...DEFAULT_CONFIG, ...cfg };
    out.SetupCompleted = Boolean(out.SetupCompleted);
    out.MinimizeToTrayOnClose = out.MinimizeToTrayOnClose !== false;
    const maxPkgs = Number(out.MaxRetainedPackages);
    out.MaxRetainedPackages = Number.isFinite(maxPkgs) && maxPkgs >= 1 ? Math.min(200, Math.round(maxPkgs)) : 10;
    out.EnablePackageRetention = Boolean(out.EnablePackageRetention);

    const retainCp = Number(out.P4RetainCheckpoints);
    out.P4RetainCheckpoints = Number.isFinite(retainCp) && retainCp >= 1 ? Math.min(60, Math.round(retainCp)) : 7;

    const interval = Number(out.P4MirrorIntervalMinutes);
    out.P4MirrorIntervalMinutes = Number.isFinite(interval) && interval >= 1 ? Math.min(60, Math.round(interval)) : 2;

    const webPort = Number(out.RemoteWebDashboardPort);
    out.RemoteWebDashboardPort = Number.isFinite(webPort) && webPort >= 1024 && webPort <= 65535 ? Math.round(webPort) : 3780;

    if (out.VcsMode !== 'Git' && out.VcsMode !== 'PerforceHybrid') {
      out.VcsMode = 'PerforceHybrid';
    }
    return out;
  }

  get() {
    return { ...this.config };
  }

  getSanitizedForRemote() {
    const safe = { ...this.config };
    safe.GitHubAccessToken = safe.GitHubAccessToken ? '••••••••' : '';
    safe.SlackBotToken = safe.SlackBotToken ? '••••••••' : '';
    safe.DiscordWebhookUrl = safe.DiscordWebhookUrl ? '••••••••' : '';
    safe.RunnerToken = safe.RunnerToken ? '••••••••' : '';
    return safe;
  }

  save(partial) {
    this.config = this._normalize({ ...this.config, ...partial });
    const json = JSON.stringify(this.config, null, 2) + '\n';
    try {
      fs.writeFileSync(this.localConfigPath, json, 'utf8');
    } catch {
      // ignore if kit dir is read-only
    }
    try {
      if (fs.existsSync(SCRIPTS_DIR)) {
        fs.writeFileSync(this.scriptsConfigPath, json, 'utf8');
      }
    } catch {
      // ignore
    }
    return this.get();
  }

  factoryReset() {
    for (const p of [this.localConfigPath, this.scriptsConfigPath]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    }
    this.config = this._normalize({ ...DEFAULT_CONFIG });
    return this.get();
  }

  getAuthorMapPath() {
    if (fs.existsSync(SCRIPTS_DIR)) {
      return path.join(SCRIPTS_DIR, 'author_map.json');
    }
    return path.join(this.kitDir, 'author_map.json');
  }

  loadAuthorMap() {
    const paths = [
      path.join(SCRIPTS_DIR, 'author_map.json'),
      path.join(this.persistDir, 'author_map.json'),
      path.join(this.kitDir, 'author_map.json'),
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
          const parsed = JSON.parse(raw);
          const entries = [];
          for (const [k, v] of Object.entries(parsed)) {
            if (k.startsWith('_') || !v || typeof v !== 'object') continue;
            entries.push({
              p4User: k,
              name: v.name || '',
              email: v.email || '',
              githubLogin: v.githubLogin || '',
              githubUrl: v.githubUrl || '',
              avatarUrl: v.avatarUrl || '',
            });
          }
          return entries;
        } catch {}
      }
    }
    return [];
  }

  saveAuthorMap(entries) {
    const obj = {
      _comment: 'Perforce 사용자 ID와 GitHub 이메일이 다를 때 등록하세요.',
    };
    for (const item of entries || []) {
      const id = (item.p4User || '').trim();
      if (!id) continue;
      const rec = {
        name: (item.name || id).trim(),
        email: (item.email || '').trim(),
      };
      if (item.githubLogin) rec.githubLogin = String(item.githubLogin).trim();
      if (item.githubUrl) rec.githubUrl = String(item.githubUrl).trim();
      if (item.avatarUrl) rec.avatarUrl = String(item.avatarUrl).trim();
      obj[id] = rec;
    }
    const json = JSON.stringify(obj, null, 2) + '\n';
    try {
      fs.writeFileSync(path.join(this.persistDir, 'author_map.json'), json, 'utf8');
    } catch {}
    try {
      if (fs.existsSync(SCRIPTS_DIR)) {
        fs.writeFileSync(path.join(SCRIPTS_DIR, 'author_map.json'), json, 'utf8');
      }
    } catch {}
    return this.loadAuthorMap();
  }
}

module.exports = { ConfigStore, DEFAULT_CONFIG, SCRIPTS_DIR };
