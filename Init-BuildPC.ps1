#Requires -RunAsAdministrator
<#
.SYNOPSIS
    전용 빌드 PC(노트북 올인원 포함) 초기 디렉토리 구조 및 스크립트 자동 배치 스크립트
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Dirs = @(
    "C:\actions-runner",
    "C:\BuildSystem\Scripts",
    "C:\BuildSystem\Scripts\.p4_state",
    "C:\BuildSystem\SharedAssets",
    "C:\BuildSystem\Workspace",
    "C:\BuildSystem\P4MirrorRepo",
    "C:\BuildArchive\Logs",
    "C:\BuildArchive\Packages"
)

Write-Host "=== [1/3] 전용 빌드 PC 기본 디렉토리 생성 중 ===" -ForegroundColor Cyan
foreach ($Dir in $Dirs) {
    if (-not (Test-Path $Dir)) {
        New-Item -ItemType Directory -Force -Path $Dir | Out-Null
        Write-Host "  생성됨: $Dir" -ForegroundColor Green
    } else {
        Write-Host "  이미 존재함: $Dir" -ForegroundColor Gray
    }
}

Write-Host "`n=== [2/3] 빌드 · Perforce 미러링 · 백업 · 알림 스크립트 배치 중 ===" -ForegroundColor Cyan
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$FilesToCopy = @(
    "Run-UEBuild.ps1",
    "Send-SlackReport.ps1",
    "Send-DiscordReport.ps1",
    "Sync-P4ToGitHub.ps1",
    "Backup-P4Server.ps1",
    "github_workflow_build.yml",
    "github_workflow_p4_build.yml",
    "author_map.example.json",
    "UE_BuildManager.exe"
)

$Utf8Bom = New-Object System.Text.UTF8Encoding($true)
foreach ($File in $FilesToCopy) {
    $Src = Join-Path $ScriptRoot $File
    $Dst = Join-Path "C:\BuildSystem\Scripts" $File
    if (Test-Path $Src) {
        if ($File -like "*.ps1") {
            $Txt = [System.IO.File]::ReadAllText($Src, [System.Text.Encoding]::UTF8)
            [System.IO.File]::WriteAllText($Dst, $Txt, $Utf8Bom)
        } else {
            Copy-Item -Path $Src -Destination $Dst -Force
        }
        Write-Host "  배치 완료: $Dst" -ForegroundColor Green
    }
}

Write-Host "`n=== [3/3] 초기 폴더 및 스크립트 세팅 완료 ===" -ForegroundColor Cyan
Write-Host "이제 BuildServerKit Electron 앱(launch_app.bat)을 실행하여:"
Write-Host "  1. [Perforce & 미러링] 또는 [GitHub & CI] 탭에서 저장소/P4 연결을 완료하세요."
Write-Host "  2. [패키징 & 보관 관리] 탭에서 패키지 보관 개수(기본 10개)와 그래픽 옵션을 설정하세요."
Write-Host "  3. [알림 · 네트워크 · 설정] 탭에서 Slack/Discord Webhook 및 원격 웹 대시보드를 활성화하세요." -ForegroundColor Green
