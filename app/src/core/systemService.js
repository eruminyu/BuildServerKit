const fs = require('fs');
const os = require('os');
const path = require('path');
const { execCapture } = require('./processRunner');
const { SCRIPTS_DIR } = require('./configStore');

function detectNetworkIPs() {
  const ifaces = os.networkInterfaces();
  let tailscaleIp = '';
  let lanIp = '';
  const all = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      const parts = addr.address.split('.').map(Number);
      const isTailscale = parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
      all.push({ name, ip: addr.address, isTailscale });
      if (isTailscale && !tailscaleIp) tailscaleIp = addr.address;
      if (!isTailscale && !lanIp) lanIp = addr.address;
    }
  }
  return {
    recommended: tailscaleIp || lanIp || os.hostname(),
    tailscaleIp,
    lanIp,
    all,
  };
}

function getDiskUsage(targetPath) {
  try {
    const root = path.parse(targetPath || 'C:\\').root || 'C:\\';
    const stat = fs.statfsSync(root);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    const used = Math.max(0, total - free);
    return {
      drive: root.replace(/\\+$/, ''),
      totalBytes: total,
      usedBytes: used,
      freeBytes: free,
      usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
  } catch {
    return { drive: 'C:', totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPercent: 0 };
  }
}

function getDirSizeBytes(dirPath, maxDepth = 6) {
  let total = 0;
  function walk(curr, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(curr, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(curr, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isFile()) {
          total += fs.statSync(full).size;
        } else if (e.isDirectory()) {
          walk(full, depth + 1);
        }
      } catch {}
    }
  }
  walk(dirPath, 0);
  return total;
}

function getPackageArchiveSummary(cfg) {
  const pkgsRoot = path.join(cfg.ArchiveRoot || 'C:\\BuildArchive', 'Packages');
  const disk = getDiskUsage(cfg.ArchiveRoot || 'C:\\BuildArchive');
  const items = [];
  let totalPkgBytes = 0;

  if (fs.existsSync(pkgsRoot)) {
    const dirs = fs
      .readdirSync(pkgsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const fullPath = path.join(pkgsRoot, d.name);
        const st = fs.statSync(fullPath);
        return {
          name: d.name,
          fullPath,
          createdMs: st.birthtimeMs || st.mtimeMs,
          createdAt: new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
        };
      })
      .sort((a, b) => b.createdMs - a.createdMs || b.name.localeCompare(a.name));

    const maxKeep = cfg.EnablePackageRetention ? Math.max(1, Number(cfg.MaxRetainedPackages) || 10) : Infinity;

    dirs.forEach((d, idx) => {
      const sizeBytes = getDirSizeBytes(d.fullPath);
      totalPkgBytes += sizeBytes;
      items.push({
        ...d,
        rank: idx + 1,
        sizeBytes,
        willPruneNext: cfg.EnablePackageRetention && idx >= maxKeep,
      });
    });
  }

  return {
    packagesRoot: pkgsRoot,
    count: items.length,
    totalBytes: totalPkgBytes,
    retentionEnabled: Boolean(cfg.EnablePackageRetention),
    maxRetained: Number(cfg.MaxRetainedPackages) || 10,
    disk,
    items,
  };
}

function applyPackageRetention(cfg, protectFullPath = '') {
  if (!cfg.EnablePackageRetention) {
    return { pruned: [], freedBytes: 0, skipped: true };
  }
  const maxKeep = Math.max(1, Number(cfg.MaxRetainedPackages) || 10);
  const pkgsRoot = path.join(cfg.ArchiveRoot || 'C:\\BuildArchive', 'Packages');
  if (!fs.existsSync(pkgsRoot)) {
    return { pruned: [], freedBytes: 0, skipped: false };
  }

  const dirs = fs
    .readdirSync(pkgsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const fullPath = path.join(pkgsRoot, d.name);
      const st = fs.statSync(fullPath);
      return {
        name: d.name,
        fullPath,
        createdMs: st.birthtimeMs || st.mtimeMs,
      };
    })
    .sort((a, b) => b.createdMs - a.createdMs || b.name.localeCompare(a.name));

  const pruned = [];
  let freedBytes = 0;

  if (dirs.length > maxKeep) {
    const toRemove = dirs.slice(maxKeep);
    for (const item of toRemove) {
      if (protectFullPath && path.resolve(item.fullPath).toLowerCase() === path.resolve(protectFullPath).toLowerCase()) {
        continue;
      }
      const sizeBytes = getDirSizeBytes(item.fullPath);
      try {
        fs.rmSync(item.fullPath, { recursive: true, force: true });
        pruned.push({ name: item.name, sizeBytes });
        freedBytes += sizeBytes;
      } catch {}
    }
  }

  return { pruned, freedBytes, skipped: false };
}

function deletePackageFolder(cfg, folderName) {
  if (!folderName || /[\\/:*?"<>|]/.test(folderName) || folderName.includes('..')) {
    throw new Error('유효하지 않은 패키지 폴더 이름입니다.');
  }
  const pkgsRoot = path.resolve(path.join(cfg.ArchiveRoot || 'C:\\BuildArchive', 'Packages'));
  const target = path.resolve(path.join(pkgsRoot, folderName));
  if (!target.startsWith(pkgsRoot + path.sep)) {
    throw new Error('허용되지 않은 경로입니다.');
  }
  if (!fs.existsSync(target)) {
    throw new Error('삭제할 폴더를 찾을 수 없습니다.');
  }
  fs.rmSync(target, { recursive: true, force: true });
  return { deleted: folderName };
}

function getBuildHistory(cfg) {
  const logsRoot = path.join(cfg.ArchiveRoot || 'C:\\BuildArchive', 'Logs');
  if (!fs.existsSync(logsRoot)) return [];

  const dirs = fs
    .readdirSync(logsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const fullPath = path.join(logsRoot, d.name);
      const st = fs.statSync(fullPath);
      const infoPath = path.join(fullPath, 'Build_Info.txt');
      const errPath = path.join(fullPath, 'Error_Summary.log');
      const fullLogPath = path.join(fullPath, 'Full_UAT_Console.log');

      const meta = {};
      if (fs.existsSync(infoPath)) {
        try {
          const lines = fs.readFileSync(infoPath, 'utf8').split(/\r?\n/);
          for (const line of lines) {
            const m = line.match(/^([^:]+):\s*(.*)$/);
            if (m) meta[m[1].trim()] = m[2].trim();
          }
        } catch {}
      }

      const hasErrors = fs.existsSync(errPath) && fs.statSync(errPath).size > 3;
      const mode =
        meta['Build Mode'] ||
        (d.name.includes('FullPackage') ? 'FullPackage' : d.name.includes('QuickVerify') ? 'QuickVerify' : 'Unknown');

      return {
        id: d.name,
        fullPath,
        projectName: meta['Project Name'] || '',
        vcsMode: meta['VCS Mode'] || (d.name.includes('_CL') ? 'PerforceHybrid' : 'Git'),
        mode,
        branch: meta['Branch'] || '',
        ref: meta['Version Ref'] || meta['Commit Hash'] || '',
        author: meta['Commit Author'] || '',
        message: meta['Commit Message'] || '',
        createdAt: new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
        createdMs: st.birthtimeMs || st.mtimeMs,
        hasErrors,
        hasFullLog: fs.existsSync(fullLogPath),
        fullLogPath,
        errorLogPath: errPath,
      };
    })
    .sort((a, b) => b.createdMs - a.createdMs);

  return dirs.slice(0, 150);
}

function readBuildLogFile(cfg, targetFile) {
  const logsRoot = path.resolve(path.join(cfg.ArchiveRoot || 'C:\\BuildArchive', 'Logs'));
  const resolved = path.resolve(targetFile || '');
  if (!resolved.startsWith(logsRoot + path.sep) || !fs.existsSync(resolved)) {
    throw new Error('로그 파일을 읽을 수 없습니다.');
  }
  const stat = fs.statSync(resolved);
  const maxBytes = 512 * 1024;
  if (stat.size <= maxBytes) {
    return { content: fs.readFileSync(resolved, 'utf8'), truncated: false, totalBytes: stat.size };
  }
  const fd = fs.openSync(resolved, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    return {
      content: `[... 상위 ${Math.round((stat.size - maxBytes) / 1024)} KB 생략됨 — 마지막 512 KB 표시 ...]\n` + buf.toString('utf8'),
      truncated: true,
      totalBytes: stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

const BUNDLED_SCRIPTS = [
  'Run-UEBuild.ps1',
  'Send-SlackReport.ps1',
  'Send-DiscordReport.ps1',
  'Sync-P4ToGitHub.ps1',
  'Backup-P4Server.ps1',
  'github_workflow_build.yml',
  'github_workflow_p4_build.yml',
  'author_map.example.json',
  'UE_BuildManager.exe',
];

function syncBundledScriptsToLocal(configStore) {
  if (!fs.existsSync(SCRIPTS_DIR)) return [];
  const kitDir = configStore.getKitDir();
  const deployed = [];
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);

  for (const f of BUNDLED_SCRIPTS) {
    const src = path.join(kitDir, f);
    const dst = path.join(SCRIPTS_DIR, f);
    if (!fs.existsSync(src)) continue;
    try {
      if (f.endsWith('.ps1')) {
        const raw = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
        const nextBuf = Buffer.concat([bom, Buffer.from(raw, 'utf8')]);
        const same = fs.existsSync(dst) && fs.readFileSync(dst).equals(nextBuf);
        if (!same) {
          fs.writeFileSync(dst, nextBuf);
          deployed.push(f);
        }
      } else {
        const srcBuf = fs.readFileSync(src);
        const same = fs.existsSync(dst) && fs.readFileSync(dst).equals(srcBuf);
        if (!same) {
          fs.writeFileSync(dst, srcBuf);
          deployed.push(f);
        }
      }
    } catch {
      // Ignore locked exe/file during silent startup auto-sync
    }
  }
  return deployed;
}

function initBuildDirectories(configStore) {
  const cfg = configStore.get();
  const dirs = [
    cfg.RunnerDir || 'C:\\actions-runner',
    SCRIPTS_DIR,
    path.join(SCRIPTS_DIR, '.p4_state'),
    cfg.SharedAssetsDir || 'C:\\BuildSystem\\SharedAssets',
    cfg.WorkspaceRoot || 'C:\\BuildSystem\\Workspace',
    cfg.P4MirrorDir || 'C:\\BuildSystem\\P4MirrorRepo',
    path.join(cfg.ArchiveRoot || 'C:\\BuildArchive', 'Logs'),
    path.join(cfg.ArchiveRoot || 'C:\\BuildArchive', 'Packages'),
  ];

  const created = [];
  for (const d of dirs) {
    if (d && !fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      created.push(d);
    }
  }

  const kitDir = configStore.getKitDir();
  const deployed = [];
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  for (const f of BUNDLED_SCRIPTS) {
    const src = path.join(kitDir, f);
    const dst = path.join(SCRIPTS_DIR, f);
    if (fs.existsSync(src)) {
      if (f.endsWith('.ps1')) {
        const raw = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
        fs.writeFileSync(dst, Buffer.concat([bom, Buffer.from(raw, 'utf8')]));
      } else {
        fs.copyFileSync(src, dst);
      }
      deployed.push(f);
    }
  }

  // Sync config to C:\BuildSystem\Scripts
  configStore.save({});
  return { dirs, created, deployed };
}

function discoverIgnoredContentFolders(cfg) {
  const result = [];
  if (!cfg.ProjectDir || !fs.existsSync(cfg.ProjectDir)) return result;
  const gitignorePath = path.join(cfg.ProjectDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return result;

  const lines = fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/);
  const seen = new Set();
  for (const raw of lines) {
    const trimmed = raw.trim();
    const m = trimmed.match(/^Content\/(.+?)(\/\*)?$/);
    if (!m) continue;
    const rel = m[1].replace(/\/+$/, '').replace(/\//g, '\\');
    const targetLink = path.join(cfg.ProjectDir, 'Content', rel);
    if (seen.has(targetLink.toLowerCase())) continue;
    seen.add(targetLink.toLowerCase());
    const leaf = path.basename(targetLink);
    const sourceDir = path.join(cfg.SharedAssetsDir || 'C:\\BuildSystem\\SharedAssets', leaf);
    result.push({
      relPath: `Content\\${rel}`,
      targetLink,
      sourceDir,
      linked: fs.existsSync(targetLink),
      sourceExists: fs.existsSync(sourceDir),
    });
  }
  return result;
}

async function ensureAssetJunctions(cfg) {
  const items = discoverIgnoredContentFolders(cfg);
  let created = 0;
  for (const item of items) {
    if (!fs.existsSync(item.sourceDir)) {
      fs.mkdirSync(item.sourceDir, { recursive: true });
    }
    if (!fs.existsSync(item.targetLink)) {
      fs.mkdirSync(path.dirname(item.targetLink), { recursive: true });
      await execCapture('cmd.exe', ['/c', 'mklink', '/J', item.targetLink, item.sourceDir]);
      if (fs.existsSync(item.targetLink)) created += 1;
    }
  }
  return { items: discoverIgnoredContentFolders(cfg), created };
}

module.exports = {
  detectNetworkIPs,
  getDiskUsage,
  getPackageArchiveSummary,
  applyPackageRetention,
  deletePackageFolder,
  getBuildHistory,
  readBuildLogFile,
  syncBundledScriptsToLocal,
  initBuildDirectories,
  discoverIgnoredContentFolders,
  ensureAssetJunctions,
};
