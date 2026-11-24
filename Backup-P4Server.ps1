<#
.SYNOPSIS
    Perforce(P4D) 정기 체크포인트 생성, 외부 스토리지 복제 및 구형 체크포인트 정리 스크립트
.DESCRIPTION
    Windows 작업 스케줄러로 매일 새벽 실행하여 단일 노트북 디스크 장애에 대비합니다.
    1) p4 admin checkpoint 로 DB 스냅샷 생성 (관리자 권한 필요)
    2) robocopy 로 체크포인트·저널·디포 파일을 외장 드라이브/NAS로 미러 백업
    3) 1TB SSD 공간 보호를 위해 최근 N개의 체크포인트/저널만 유지하고 오래된 항목 자동 정리
#>
param(
    [string]$ConfigPath = "",
    [string]$P4Port = "",
    [string]$AdminUser = "admin",
    [string]$P4DepotRoot = "",
    [string]$P4BackupRoot = "",
    [int]$RetainCheckpoints = 0,
    [string]$RcloneRemote = "",
    [switch]$SkipCheckpoint
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:P4CHARSET = "utf8"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $C1 = Join-Path $ScriptDir "build_manager_config.json"
    $C2 = "C:\BuildSystem\Scripts\build_manager_config.json"
    if (Test-Path $C1) { $ConfigPath = $C1 }
    elseif (Test-Path $C2) { $ConfigPath = $C2 }
}

$Cfg = $null
if ($ConfigPath -and (Test-Path $ConfigPath)) {
    try { $Cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}

if ([string]::IsNullOrWhiteSpace($P4Port))       { $P4Port       = if ($Cfg -and $Cfg.P4Port) { $Cfg.P4Port } else { "localhost:1666" } }
if ([string]::IsNullOrWhiteSpace($P4DepotRoot))  { $P4DepotRoot  = if ($Cfg -and $Cfg.P4DepotRoot) { $Cfg.P4DepotRoot } else { "C:\Perforce\Server" } }
if ([string]::IsNullOrWhiteSpace($P4BackupRoot)) { $P4BackupRoot = if ($Cfg -and $Cfg.P4BackupRoot) { $Cfg.P4BackupRoot } else { "D:\P4Backup" } }
if ($RetainCheckpoints -le 0) {
    $RetainCheckpoints = if ($Cfg -and $Cfg.P4RetainCheckpoints -gt 0) { [int]$Cfg.P4RetainCheckpoints } else { 7 }
}

Write-Host "=== [P4 정기 백업 시작] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -ForegroundColor Cyan
Write-Host "  P4Port      : $P4Port (Admin: $AdminUser)"
Write-Host "  Depot Root  : $P4DepotRoot"
Write-Host "  Backup Root : $P4BackupRoot (체크포인트 보관: 최신 ${RetainCheckpoints}개)"

# 1. Perforce 체크포인트 생성
if (-not $SkipCheckpoint) {
    if (-not (Get-Command p4 -ErrorAction SilentlyContinue)) {
        Write-Error "p4.exe를 찾을 수 없습니다."
        exit 1
    }
    Write-Host "`n[1/4] Perforce DB 체크포인트 생성 중 (p4 admin checkpoint)..." -ForegroundColor Cyan
    & p4 -p $P4Port -u $AdminUser admin checkpoint
    if ($LASTEXITCODE -ne 0) {
        Write-Error "p4 admin checkpoint 실패 (ExitCode=$LASTEXITCODE). 관리자($AdminUser) 로그인 티켓을 확인하세요."
        exit $LASTEXITCODE
    }
}

# 2. 체크포인트/저널 로테이션 (원본 디포 폴더 SSD 보호)
function Remove-OldCheckpoints {
    param([string]$TargetDir, [int]$KeepCount)
    if (-not (Test-Path $TargetDir)) { return }

    foreach ($Pattern in @("checkpoint.*", "journal.*")) {
        $Files = @(Get-ChildItem -Path $TargetDir -Filter $Pattern -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^(checkpoint|journal)\.\d+(\.gz|\.md5)?$' } |
            Sort-Object LastWriteTime -Descending)

        # 같은 번호(.md5 포함)를 세트로 묶기 위해 숫자 기준 그룹화
        $Groups = @($Files | Group-Object {
            if ($_.Name -match '\.(\d+)') { [int]$Matches[1] } else { 0 }
        } | Sort-Object { [int]$_.Name } -Descending)

        if ($Groups.Count -gt $KeepCount) {
            $ToDelete = $Groups | Select-Object -Skip $KeepCount
            foreach ($Grp in $ToDelete) {
                foreach ($F in $Grp.Group) {
                    Write-Host "  [정리] 구형 파일 삭제: $($F.FullName)" -ForegroundColor DarkYellow
                    Remove-Item $F.FullName -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
}

Write-Host "`n[2/4] 구형 체크포인트/저널 정리 중 (최신 ${RetainCheckpoints}개 유지)..." -ForegroundColor Cyan
Remove-OldCheckpoints -TargetDir $P4DepotRoot -KeepCount $RetainCheckpoints

# 3. 외부 스토리지/NAS 복제 (robocopy)
if (-not (Test-Path $P4DepotRoot)) {
    Write-Error "P4 디포 루트 폴더가 존재하지 않습니다: $P4DepotRoot"
    exit 1
}

$BackupDest = Join-Path $P4BackupRoot "PerforceServer"
if (-not (Test-Path $BackupDest)) {
    New-Item -ItemType Directory -Force -Path $BackupDest | Out-Null
}

Write-Host "`n[3/4] 백업 스토리지 미러링 중 (robocopy -> $BackupDest)..." -ForegroundColor Cyan
# 실행 중인 db.* 파일은 잠겨 있을 수 있으므로 체크포인트+저널+디포 아카이브만 안전 복제 (db.* 제외)
& robocopy $P4DepotRoot $BackupDest /MIR /XF "db.*" "journal" "server.locks" "*.lck" /R:2 /W:2 /MT:4 /NP /NDL
$RoboCode = $LASTEXITCODE
if ($RoboCode -ge 8) {
    Write-Error "robocopy 백업 실패 (ExitCode=$RoboCode)"
    exit $RoboCode
}
Write-Host "  robocopy 완료 (ExitCode=$RoboCode)" -ForegroundColor Green

# 4. 선택적 클라우드 복제 (rclone)
if (-not [string]::IsNullOrWhiteSpace($RcloneRemote)) {
    if (Get-Command rclone -ErrorAction SilentlyContinue) {
        Write-Host "`n[4/4] rclone 원격 동기화 중 (-> $RcloneRemote)..." -ForegroundColor Cyan
        & rclone sync $BackupDest $RcloneRemote --transfers 4 --checkers 8
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "rclone 동기화 경고 (ExitCode=$LASTEXITCODE)"
        }
    } else {
        Write-Warning "rclone 명령어를 찾을 수 없어 클라우드 동기화를 건너뜁니다."
    }
} else {
    Write-Host "`n[4/4] rclone 원격 대상 미지정 — 로컬/외장 백업으로 완료합니다." -ForegroundColor Gray
}

Write-Host "`n✔ [P4 정기 백업 완료] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Green
exit 0
