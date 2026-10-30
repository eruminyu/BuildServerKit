#Requires -RunAsAdministrator
<#
.SYNOPSIS
    전용 빌드 PC 초기 디렉토리 구조 및 스크립트 자동 배치 스크립트 (클린 배포용)
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Dirs = @(
    "C:\actions-runner",
    "C:\BuildSystem\Scripts",
    "C:\BuildSystem\SharedAssets",
    "C:\BuildSystem\Workspace",
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

Write-Host "`n=== [2/3] 빌드 및 Slack 전송 스크립트 배치 중 ===" -ForegroundColor Cyan
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($File in @("Run-UEBuild.ps1", "Send-SlackReport.ps1", "github_workflow_build.yml")) {
    $Src = Join-Path $ScriptRoot $File
    $Dst = Join-Path "C:\BuildSystem\Scripts" $File
    if (Test-Path $Src) {
        Copy-Item -Path $Src -Destination $Dst -Force
        Write-Host "  배치 완료: $Dst" -ForegroundColor Green
    }
}

Write-Host "`n=== [3/3] 초기 폴더 세팅 완료 ===" -ForegroundColor Cyan
Write-Host "이제 UE_BuildManager.exe 를 실행하여:"
Write-Host "  1. [GitHub 로그인 & 사용할 저장소 선택하기] 버튼으로 웹 브라우저에서 로그인 후 사용할 저장소를 선택하세요."
Write-Host "  2. GitHub Actions Runner 설치/등록 및 Slack 알림 설정을 진행하세요." -ForegroundColor Green
