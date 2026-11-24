const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

async function main() {
  const appDir = path.resolve(__dirname, '..');
  const electronDir = path.join(appDir, 'node_modules', 'electron');
  const distDir = path.join(electronDir, 'dist');
  const exePath = path.join(distDir, 'electron.exe');
  const pathTxt = path.join(electronDir, 'path.txt');

  if (fs.existsSync(exePath) && fs.existsSync(pathTxt)) {
    return;
  }

  console.log('[BuildServerKit] Electron 런타임 바이너리 확인 및 추출 중...');
  const { downloadArtifact } = require('@electron/get');
  const pkg = require(path.join(electronDir, 'package.json'));
  const zipPath = await downloadArtifact({
    version: pkg.version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
  });

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${distDir.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit' }
  );
  fs.writeFileSync(pathTxt, 'electron.exe', 'utf8');
  console.log('[BuildServerKit] Electron 바이너리 준비 완료!');
}

main().catch((err) => {
  console.error('[BuildServerKit] Electron 준비 실패:', err);
  process.exit(1);
});
