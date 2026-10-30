param(
    [ValidateSet("QuickVerify", "FullPackage")]
    [string]$BuildMode = "QuickVerify",
    [string]$BranchName = "main",
    [string]$ProjectDir = "",
    [string]$UE5Root = "",
    [string]$SharedAssets = "C:\BuildSystem\SharedAssets",
    [string]$ArchiveRoot = "C:\BuildArchive"
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ==============================================================================
# 1. 설정 파일(build_manager_config.json) 또는 파라미터에서 경로 로드
# ==============================================================================
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ScriptDir "build_manager_config.json"
if (-not (Test-Path $ConfigPath)) {
    $ConfigPath = "C:\BuildSystem\Scripts\build_manager_config.json"
}

if (Test-Path $ConfigPath) {
    try {
        $Cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($UE5Root) -and $Cfg.UE5Root) { $UE5Root = $Cfg.UE5Root }
        if ([string]::IsNullOrWhiteSpace($ProjectDir) -and $Cfg.ProjectDir) { $ProjectDir = $Cfg.ProjectDir }
        if ($Cfg.SharedAssetsDir) { $SharedAssets = $Cfg.SharedAssetsDir }
        if ($Cfg.ArchiveRoot) { $ArchiveRoot = $Cfg.ArchiveRoot }
    } catch {}
}

if ([string]::IsNullOrWhiteSpace($UE5Root)) { $UE5Root = "C:\Program Files\Epic Games\UE_5.8" }
if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
    # Workspace 내 첫 번째 Git 저장소 자동 탐색
    $FirstRepo = Get-ChildItem -Path "C:\BuildSystem\Workspace" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($FirstRepo) { $ProjectDir = $FirstRepo.FullName }
}

$RunUAT = "$UE5Root\Engine\Build\BatchFiles\RunUAT.bat"
if (-not (Test-Path $RunUAT)) {
    Write-Error "RunUAT.bat 경로를 찾을 수 없습니다: $RunUAT"
    exit 1
}

# 프로젝트 폴더 내 *.uproject 자동 탐색
$UProjectItem = Get-ChildItem -Path $ProjectDir -Filter "*.uproject" -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $UProjectItem) {
    Write-Error "워크스페이스 경로에서 .uproject 파일을 찾을 수 없습니다: $ProjectDir"
    exit 1
}
$UProjectFile = $UProjectItem.FullName
$ProjectName  = $UProjectItem.BaseName

Set-Location $ProjectDir

# ==============================================================================
# 2. 현재 커밋 메타데이터 수집
# ==============================================================================
$CommitHash    = (git rev-parse --short HEAD).Trim()
$CommitAuthor  = (git log -1 --pretty=format:"%an").Trim()
$CommitMsg     = (git log -1 --pretty=format:"%s").Trim()
$TimeStamp     = Get-Date -Format "yyyy-MM-dd_HHmmss"
$SafeBranch    = ($BranchName -replace '^origin/', '') -replace '[\\/:*?"<>|]', '_'

# ==============================================================================
# 3. 이번 빌드의 전수 로그 아카이브 폴더 생성
# ==============================================================================
$BuildId       = "${TimeStamp}_${BuildMode}_${SafeBranch}_${CommitHash}"
$LogArchiveDir = "$ArchiveRoot\Logs\$BuildId"
New-Item -ItemType Directory -Force -Path $LogArchiveDir | Out-Null

@"
Project Name  : $ProjectName
Build ID      : $BuildId
Build Mode    : $BuildMode
Branch        : $BranchName
Commit Hash   : $CommitHash
Commit Author : $CommitAuthor
Commit Message: $CommitMsg
Start Time    : $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
"@ | Out-File -FilePath "$LogArchiveDir\Build_Info.txt" -Encoding utf8

# ==============================================================================
# 4. .gitignore 내 Content/ 하위 제외 에셋 폴더 자동 감지 및 정션(심볼릭 링크) 연결
# ==============================================================================
$GitIgnoreFile = Join-Path $ProjectDir ".gitignore"
if (Test-Path $GitIgnoreFile) {
    $IgnoreLines = Get-Content $GitIgnoreFile -Encoding UTF8
    foreach ($Line in $IgnoreLines) {
        $Trimmed = $Line.Trim()
        if ($Trimmed -match '^Content/(.+?)(\/\*)?$') {
            $RelSubPath = $Matches[1].TrimEnd('/') -replace '/', '\'
            $TargetLink = Join-Path "$ProjectDir\Content" $RelSubPath
            $LeafName   = Split-Path -Leaf $TargetLink
            $SourceDir  = Join-Path $SharedAssets $LeafName

            if (-not (Test-Path $SourceDir)) {
                New-Item -ItemType Directory -Force -Path $SourceDir | Out-Null
            }
            if (-not (Test-Path $TargetLink)) {
                $ParentDir = Split-Path -Parent $TargetLink
                if (-not (Test-Path $ParentDir)) {
                    New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null
                }
                cmd /c mklink /J "`"$TargetLink`"" "`"$SourceDir`"" | Out-Null
            }
        }
    }
}

# 이전 빌드의 Saved/Logs 정리
if (Test-Path "$ProjectDir\Saved\Logs") {
    Remove-Item "$ProjectDir\Saved\Logs\*" -Recurse -Force -ErrorAction SilentlyContinue
}

# ==============================================================================
# 5. 빌드 모드별 RunUAT.bat 인자 구성
# ==============================================================================
$UATLogFile = "$LogArchiveDir\Full_UAT_Console.log"

if ($BuildMode -eq "QuickVerify") {
    $UATArgs = @(
        "BuildCookRun",
        "-project=`"$UProjectFile`"",
        "-noP4",
        "-platform=Win64",
        "-clientconfig=Development",
        "-build",
        "-cook",
        "-iterate",
        "-skipstage",
        "-utf8output"
    )
} else {
    $PackageOutDir = "$ArchiveRoot\Packages\$BuildId"
    New-Item -ItemType Directory -Force -Path $PackageOutDir | Out-Null
    $UATArgs = @(
        "BuildCookRun",
        "-project=`"$UProjectFile`"",
        "-noP4",
        "-platform=Win64",
        "-clientconfig=Development",
        "-build",
        "-cook",
        "-allmaps",
        "-stage",
        "-pak",
        "-archive",
        "-archivedirectory=`"$PackageOutDir`"",
        "-utf8output"
    )
}

# ==============================================================================
# 6. RunUAT 실행 및 모든 실시간 콘솔 로그를 파일로 동시 저장
# ==============================================================================
$StartTime = Get-Date
& $RunUAT @UATArgs 2>&1 | Tee-Object -FilePath $UATLogFile
$ExitCode = $LASTEXITCODE
$Elapsed = (Get-Date) - $StartTime
$Duration = "{0:D2}분 {1:D2}초" -f [int]$Elapsed.TotalMinutes, $Elapsed.Seconds

# ==============================================================================
# 7. 언리얼 엔진 내부 상세 로그(Saved/Logs 및 Engine UAT 로그) 전수 복사 보관
# ==============================================================================
if (Test-Path "$ProjectDir\Saved\Logs") {
    $SavedLogDest = "$LogArchiveDir\Saved_Logs"
    New-Item -ItemType Directory -Force -Path $SavedLogDest | Out-Null
    Copy-Item "$ProjectDir\Saved\Logs\*" -Destination $SavedLogDest -Recurse -Force -ErrorAction SilentlyContinue
}

$EngineUATLogs = "$env:APPDATA\Unreal Engine\AutomationTool\Logs"
if (Test-Path $EngineUATLogs) {
    $UATDetailDest = "$LogArchiveDir\Engine_UAT_Logs"
    New-Item -ItemType Directory -Force -Path $UATDetailDest | Out-Null
    Copy-Item "$EngineUATLogs\*" -Destination $UATDetailDest -Recurse -Force -ErrorAction SilentlyContinue
}

# ==============================================================================
# 8. Slack 리포트 및 에러 발생 시 로그 즉시 전송 호출
# ==============================================================================
$SlackScript = Join-Path $ScriptDir "Send-SlackReport.ps1"
if (-not (Test-Path $SlackScript)) {
    $SlackScript = "C:\BuildSystem\Scripts\Send-SlackReport.ps1"
}

if (Test-Path $SlackScript) {
    & $SlackScript `
        -ProjectName $ProjectName `
        -ExitCode $ExitCode `
        -BuildMode $BuildMode `
        -BranchName $SafeBranch `
        -CommitHash $CommitHash `
        -CommitAuthor $CommitAuthor `
        -CommitMsg $CommitMsg `
        -Duration $Duration `
        -LogArchiveDir $LogArchiveDir `
        -UATLogFile $UATLogFile
}

exit $ExitCode
