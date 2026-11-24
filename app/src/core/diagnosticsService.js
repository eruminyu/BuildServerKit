const fs = require('fs');
const os = require('os');
const path = require('path');
const { execCapture, spawnStreamed } = require('./processRunner');
const { detectNetworkIPs, getDiskUsage } = require('./systemService');
const { SCRIPTS_DIR } = require('./configStore');

// Trusted allowlist for 1-click winget installation (prevents arbitrary package execution)
const WINGET_ALLOWLIST = {
  git: { id: 'Git.Git', label: 'Git for Windows' },
  tailscale: { id: 'Tailscale.Tailscale', label: 'Tailscale VPN' },
  gh: { id: 'GitHub.cli', label: 'GitHub CLI (gh)' },
  p4cli: { id: 'Perforce.P4', label: 'Perforce CLI (p4)' },
  vsbuildtools: { id: 'Microsoft.VisualStudio.2022.BuildTools', label: 'Visual Studio 2022 Build Tools' },
};

async function detectUE5Installations(configuredRoot) {
  const foundMap = new Map();

  const tryAdd = (dirPath) => {
    if (!dirPath) return;
    const norm = path.resolve(dirPath);
    const runUat = path.join(norm, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat');
    if (fs.existsSync(runUat)) {
      const key = norm.toLowerCase();
      if (!foundMap.has(key)) {
        const folderName = path.basename(norm);
        const verMatch = folderName.match(/UE[_-]?(\d+\.\d+(?:\.\d+)?)/i);
        foundMap.set(key, {
          path: norm,
          version: verMatch ? verMatch[1] : folderName,
          runUat,
        });
      }
    }
  };

  tryAdd(configuredRoot);

  // 1. Scan common Epic Games install locations across drives C..F
  const baseFolders = [
    'Program Files\\Epic Games',
    'Epic Games',
    'UnrealEngine',
  ];
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    for (const rel of baseFolders) {
      const parent = path.join(drive + '\\', rel);
      if (!fs.existsSync(parent)) continue;
      try {
        for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
          if (entry.isDirectory() && /^UE[_-]?5/i.test(entry.name)) {
            tryAdd(path.join(parent, entry.name));
          }
        }
      } catch {}
    }
  }

  // 2. Check Windows Registry for Epic Games Launcher UE5 installs
  try {
    const reg = await execCapture(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\EpicGames\\Unreal Engine', '/s', '/v', 'InstalledDirectory'],
      { timeoutMs: 5000 }
    );
    if (reg.code === 0 && reg.stdout) {
      for (const line of reg.stdout.split(/\r?\n/)) {
        const m = line.match(/InstalledDirectory\s+REG_SZ\s+(.+)$/i);
        if (m) tryAdd(m[1].trim());
      }
    }
  } catch {}

  // Sort newest UE5 version first
  return Array.from(foundMap.values()).sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true })
  );
}

async function detectVisualStudioCpp() {
  const vswherePaths = [
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe',
  ];
  const vswhere = vswherePaths.find((p) => fs.existsSync(p));
  if (!vswhere) {
    return { installed: false, detail: 'Visual Studio / C++ Build Tools 미감지 (UE5 C++ 컴파일에 필수)' };
  }

  const res = await execCapture(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'displayName',
    ],
    { timeoutMs: 6000 }
  );
  const name = (res.stdout || '').trim().split(/\r?\n/)[0] || '';
  if (res.code === 0 && name) {
    return { installed: true, detail: `${name} (MSVC C++ 도구 확인됨)` };
  }

  // Check if VS is installed without C++ workload
  const anyVs = await execCapture(vswhere, ['-latest', '-products', '*', '-property', 'displayName'], { timeoutMs: 5000 });
  const anyName = (anyVs.stdout || '').trim().split(/\r?\n/)[0] || '';
  if (anyName) {
    return {
      installed: false,
      partial: true,
      detail: `${anyName} 설치됨 — 단, 'C++를 사용한 게임/데스크톱 개발' 워크로드(MSVC) 누락`,
    };
  }
  return { installed: false, detail: 'MSVC C++ 컴파일러가 설치되어 있지 않습니다.' };
}

async function detectGit() {
  const res = await execCapture('git', ['--version'], { timeoutMs: 5000 });
  if (res.code === 0 && res.stdout.trim()) {
    return { installed: true, version: res.stdout.trim() };
  }
  const fallback = 'C:\\Program Files\\Git\\cmd\\git.exe';
  if (fs.existsSync(fallback)) {
    const r2 = await execCapture(fallback, ['--version'], { timeoutMs: 5000 });
    if (r2.code === 0) return { installed: true, version: `${r2.stdout.trim()} (PATH 확인 권장)` };
  }
  return { installed: false, version: '' };
}

async function detectPerforce(cfg) {
  const cliRes = await execCapture('p4', ['-V'], { timeoutMs: 5000 });
  const cliInstalled = cliRes.code === 0;
  let cliVer = '';
  if (cliInstalled) {
    const m = (cliRes.stdout || '').match(/Rev\.\s+(.+)/);
    cliVer = m ? m[1].trim() : 'p4 CLI 설치됨';
  }

  // Check Windows Helix Core (P4D) Service
  let serviceInstalled = false;
  let serviceRunning = false;
  let serviceName = '';
  for (const svc of ['Perforce', 'HelixCore', 'p4d']) {
    const q = await execCapture('sc', ['query', svc], { timeoutMs: 4000 });
    if (q.code === 0 && /STATE/i.test(q.stdout || '')) {
      serviceInstalled = true;
      serviceName = svc;
      serviceRunning = /RUNNING/i.test(q.stdout);
      break;
    }
  }

  let serverReachable = false;
  let unicodeMode = false;
  let ticketOk = false;
  if (cliInstalled) {
    const base = ['-p', cfg.P4Port || 'localhost:1666', '-u', cfg.P4User || 'p4bot'];
    const info = await execCapture('p4', [...base, 'info'], { timeoutMs: 5000 });
    if (info.code === 0) {
      serverReachable = true;
      unicodeMode = /unicode enabled/i.test(info.stdout || '');
      const login = await execCapture('p4', [...base, 'login', '-s'], { timeoutMs: 4000 });
      ticketOk = login.code === 0;
    }
  }

  return {
    cliInstalled,
    cliVer,
    serviceInstalled,
    serviceRunning,
    serviceName,
    serverReachable,
    unicodeMode,
    ticketOk,
  };
}

async function detectTailscale() {
  const net = detectNetworkIPs();
  let cliInstalled = false;
  const r = await execCapture('tailscale', ['version'], { timeoutMs: 4000 });
  if (r.code === 0) cliInstalled = true;
  else if (fs.existsSync('C:\\Program Files\\Tailscale\\tailscale.exe')) cliInstalled = true;

  return {
    installed: cliInstalled || Boolean(net.tailscaleIp),
    connected: Boolean(net.tailscaleIp),
    ip: net.tailscaleIp || '',
    lanIp: net.lanIp || '',
  };
}

async function detectGhCli() {
  const r = await execCapture('gh', ['--version'], { timeoutMs: 4000 });
  if (r.code !== 0) return { installed: false, loggedIn: false, version: '' };
  const ver = (r.stdout || '').trim().split(/\r?\n/)[0] || 'gh CLI';
  const auth = await execCapture('gh', ['auth', 'status'], { timeoutMs: 4000 });
  return { installed: true, loggedIn: auth.code === 0, version: ver };
}

async function detectWinget() {
  const r = await execCapture('winget', ['--version'], { timeoutMs: 4000 });
  return r.code === 0;
}

async function runFullDiagnostics(configStore, modeOverride = '') {
  const cfg = configStore.get();
  const vcsMode = modeOverride || cfg.VcsMode || 'PerforceHybrid';
  const isP4 = vcsMode === 'PerforceHybrid';

  const [ueList, vsCpp, git, p4, tailscale, gh, hasWinget] = await Promise.all([
    detectUE5Installations(cfg.UE5Root),
    detectVisualStudioCpp(),
    detectGit(),
    detectPerforce(cfg),
    detectTailscale(),
    detectGhCli(),
    detectWinget(),
  ]);

  const totalRamGb = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
  const disk = getDiskUsage(cfg.ArchiveRoot || 'C:\\BuildArchive');
  const freeGb = Math.round((disk.freeBytes / (1024 ** 3)) * 10) / 10;

  const scriptsReady =
    fs.existsSync(path.join(SCRIPTS_DIR, 'Run-UEBuild.ps1')) &&
    fs.existsSync(path.join(SCRIPTS_DIR, 'Sync-P4ToGitHub.ps1'));
  const runnerInstalled = fs.existsSync(path.join(cfg.RunnerDir || 'C:\\actions-runner', 'config.cmd'));
  const runnerConfigured = fs.existsSync(path.join(cfg.RunnerDir || 'C:\\actions-runner', '.runner'));

  const checks = [];

  // 1. Hardware (RAM & SSD)
  const hwStatus = totalRamGb < 16 || freeGb < 80 ? 'warn' : 'ok';
  checks.push({
    id: 'hardware',
    category: 'system',
    name: 'PC 하드웨어 (RAM · SSD 여유 공간)',
    required: true,
    status: hwStatus,
    summary: `RAM ${totalRamGb} GB · ${disk.drive} 여유 ${freeGb} GB`,
    detail:
      hwStatus === 'ok'
        ? 'UE5 올인원 빌드 및 패키징에 충분한 사양입니다.'
        : 'UE5 빌드·패키징에는 RAM 16GB 이상(권장 32GB), 디스크 여유 100GB 이상을 권장합니다.',
  });

  // 2. Unreal Engine 5
  const ueOk = ueList.length > 0;
  checks.push({
    id: 'ue5',
    category: 'build',
    name: 'Unreal Engine 5 (RunUAT.bat)',
    required: true,
    status: ueOk ? 'ok' : 'missing',
    summary: ueOk
      ? ueList.length > 1
        ? `UE ${ueList[0].version} 외 ${ueList.length - 1}개 자동 감지됨`
        : `UE ${ueList[0].version} 자동 감지됨`
      : '설치된 UE5를 찾을 수 없음',
    detail: ueOk
      ? `감지 경로: ${ueList[0].path}`
      : 'Epic Games Launcher에서 Unreal Engine 5를 설치하거나, 다음 단계에서 직접 엔진 폴더를 지정하세요.',
    downloadUrl: 'https://store.epicgames.com/download',
    downloadLabel: 'Epic Games Launcher 열기',
  });

  // 3. Visual Studio / MSVC C++
  checks.push({
    id: 'vscpp',
    category: 'build',
    name: 'Visual Studio C++ 빌드 도구 (MSVC)',
    required: true,
    status: vsCpp.installed ? 'ok' : 'missing',
    summary: vsCpp.installed ? '설치됨' : vsCpp.partial ? 'C++ 워크로드 누락' : '미설치',
    detail: vsCpp.detail,
    downloadUrl: 'https://visualstudio.microsoft.com/ko/downloads/',
    downloadLabel: 'VS / Build Tools 다운로드',
    wingetKey: hasWinget ? 'vsbuildtools' : '',
  });

  // 4. Git CLI
  checks.push({
    id: 'git',
    category: 'vcs',
    name: 'Git CLI (git.exe)',
    required: true,
    status: git.installed ? 'ok' : 'missing',
    summary: git.installed ? git.version : '미설치',
    detail: git.installed
      ? 'GitHub 미러링 및 저장소 동기화를 수행할 수 있습니다.'
      : 'GitHub 연동 및 코드 미러링에 필수입니다.',
    downloadUrl: 'https://git-scm.com/download/win',
    downloadLabel: 'Git 공식 다운로드',
    wingetKey: hasWinget ? 'git' : '',
  });

  // 5. Perforce CLI (required in PerforceHybrid)
  checks.push({
    id: 'p4cli',
    category: 'vcs',
    name: 'Perforce CLI (p4.exe)',
    required: isP4,
    status: p4.cliInstalled ? 'ok' : isP4 ? 'missing' : 'optional',
    summary: p4.cliInstalled ? '설치됨' : isP4 ? '미설치 (필수)' : '미설치 (Git 모드에선 불필요)',
    detail: p4.cliInstalled
      ? p4.cliVer
      : 'Perforce 미러링과 로컬 p4 sync에 필수입니다. Helix Command-Line Client(P4)를 설치하세요.',
    downloadUrl: 'https://www.perforce.com/downloads/helix-command-line-client-p4',
    downloadLabel: 'P4 CLI 다운로드',
    wingetKey: hasWinget ? 'p4cli' : '',
  });

  // 6. Perforce Server (P4D)
  const p4dStatus = p4.serverReachable
    ? p4.unicodeMode && p4.ticketOk
      ? 'ok'
      : 'warn'
    : p4.serviceInstalled
      ? 'warn'
      : isP4
        ? 'missing'
        : 'optional';
  checks.push({
    id: 'p4d',
    category: 'vcs',
    name: 'Helix Core Server (P4D) 및 연결',
    required: isP4,
    status: p4dStatus,
    summary: p4.serverReachable
      ? `연결됨 (${cfg.P4Port}) · Unicode:${p4.unicodeMode ? 'ON' : 'OFF'} · 티켓:${p4.ticketOk ? '유효' : '필요'}`
      : p4.serviceInstalled
        ? `서비스(${p4.serviceName}) 감지됨 — ${p4.serviceRunning ? '연결 확인 필요' : '중지됨'}`
        : isP4
          ? '로컬 P4D 서버 미감지'
          : 'Git 모드에선 불필요',
    detail: p4.serverReachable
      ? p4.unicodeMode && p4.ticketOk
        ? '로컬 Perforce 서버, Unicode 모드, 자동화 계정 티켓이 모두 준비되었습니다.'
        : 'Unicode 모드(p4d -xi) 또는 자동화 계정(p4bot) 로그인 티켓을 4단계에서 마무리하세요.'
      : '노트북 올인원 구성 시 Windows용 Helix Core Server(P4D)를 설치하세요. (원격 P4 서버를 쓴다면 4단계에서 P4PORT만 변경)',
    downloadUrl: 'https://www.perforce.com/downloads/helix-core-p4d',
    downloadLabel: 'Helix Core(P4D) 다운로드',
  });

  // 7. Tailscale VPN (Recommended)
  checks.push({
    id: 'tailscale',
    category: 'network',
    name: 'Tailscale VPN (팀원 외부 접속 · 웹 대시보드)',
    required: false,
    status: tailscale.connected ? 'ok' : 'warn',
    summary: tailscale.connected
      ? `연결됨 (${tailscale.ip})`
      : tailscale.installed
        ? '설치됨 (로그인 필요)'
        : '미설치 (권장)',
    detail: tailscale.connected
      ? `포트포워딩 없이 팀원들이 ${tailscale.ip} 주소로 P4·공유폴더·웹 대시보드에 안전하게 접속할 수 있습니다.`
      : '포트포워딩 없이 팀원 PC와 내부망처럼 연결하려면 Tailscale 설치를 강력 권장합니다.',
    downloadUrl: 'https://tailscale.com/download/windows',
    downloadLabel: 'Tailscale 다운로드',
    wingetKey: hasWinget ? 'tailscale' : '',
  });

  // 8. Scripts & Directories
  checks.push({
    id: 'scripts',
    category: 'kit',
    name: '빌드 시스템 폴더 & 스크립트 배치',
    required: true,
    status: scriptsReady ? 'ok' : 'warn',
    summary: scriptsReady ? 'C:\\BuildSystem\\Scripts 배치 완료' : '초기 배치 필요 (2단계에서 원클릭 생성)',
    detail: scriptsReady
      ? '빌드·미러링·Discord/Slack·백업 스크립트가 정상 배치되어 있습니다.'
      : '2단계 [필수 폴더 & 스크립트 일괄 생성] 버튼 한 번으로 자동 생성됩니다.',
  });

  // 9. GitHub Runner & gh CLI
  checks.push({
    id: 'runner',
    category: 'ci',
    name: 'GitHub Actions Self-Hosted Runner',
    required: false,
    status: runnerConfigured ? 'ok' : runnerInstalled ? 'warn' : 'warn',
    summary: runnerConfigured
      ? '설치 및 등록 완료'
      : runnerInstalled
        ? '설치됨 (저장소 등록 필요)'
        : '미설치 (3단계에서 원클릭 설치)',
    detail: gh.installed
      ? `보조 도구 GitHub CLI(${gh.version}) 감지됨 — 3단계에서 원클릭 로그인 가능`
      : '3단계에서 GitHub 로그인 후 버튼 클릭만으로 Runner 다운로드 및 자동 등록이 가능합니다.',
    downloadUrl: 'https://cli.github.com/',
    downloadLabel: 'GitHub CLI (선택)',
    wingetKey: hasWinget && !gh.installed ? 'gh' : '',
  });

  const missingRequired = checks.filter((c) => c.required && c.status === 'missing');
  const warnings = checks.filter((c) => c.status === 'warn');
  const passed = checks.filter((c) => c.status === 'ok');

  return {
    scannedAt: new Date().toISOString(),
    vcsMode,
    hasWinget,
    ueInstallations: ueList,
    hardware: { totalRamGb, freeGb, drive: disk.drive },
    network: { tailscaleIp: tailscale.ip, lanIp: tailscale.lanIp },
    summary: {
      total: checks.length,
      passed: passed.length,
      missingRequired: missingRequired.length,
      warnings: warnings.length,
      readyToBuild: missingRequired.length === 0,
    },
    checks,
  };
}

async function installViaWinget(wingetKey, stateHub) {
  const pkg = WINGET_ALLOWLIST[wingetKey];
  if (!pkg) {
    throw new Error(`허용되지 않은 설치 패키지입니다: ${wingetKey}`);
  }
  stateHub.appendLog(`=== [winget 자동 설치] ${pkg.label} (${pkg.id}) 설치 시작 ===`, 'cyan');

  const { promise } = spawnStreamed(
    'winget',
    [
      'install',
      '--id',
      pkg.id,
      '-e',
      '--source',
      'winget',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ],
    {},
    (line, stream) => {
      if (line.trim()) {
        stateHub.appendLog(`[winget] ${line}`, stream === 'stderr' ? 'warn' : 'info');
      }
    }
  );
  const code = await promise;
  if (code === 0) {
    stateHub.appendLog(`✔ [winget] ${pkg.label} 설치 완료! (PATH 반영을 위해 앱 재시작이 필요할 수 있습니다.)`, 'success');
  } else {
    stateHub.appendLog(`[winget] ${pkg.label} 설치 종료 (ExitCode=${code})`, 'warn');
  }
  return { ok: code === 0, code, label: pkg.label };
}

module.exports = {
  runFullDiagnostics,
  installViaWinget,
  detectUE5Installations,
};
