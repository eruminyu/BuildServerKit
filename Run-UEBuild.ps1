param(
    [ValidateSet("QuickVerify", "FullPackage")]
    [string]$BuildMode = "QuickVerify",
    [string]$BranchName = "main",
    [string]$ClientConfig = "",
    [string]$ProjectDir = "",
    [string]$UE5Root = "",
    [string]$SharedAssets = "C:\BuildSystem\SharedAssets",
    [string]$ArchiveRoot = "C:\BuildArchive",
    [ValidateSet("", "Git", "PerforceHybrid")]
    [string]$VcsMode = "",
    [string]$Changelist = "",
    [string]$CommitAuthor = "",
    [string]$CommitMsg = "",
    [Nullable[bool]]$EnablePackageRetention = $null,
    [int]$MaxRetainedPackages = 0
)

$ErrorActionPreference = "Continue"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:P4CHARSET = "utf8"

# ==============================================================================
# 1. 설정 파일(build_manager_config.json) 또는 파라미터에서 경로/정책 로드
# ==============================================================================
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ScriptDir "build_manager_config.json"
if (-not (Test-Path $ConfigPath)) {
    $ConfigPath = "C:\BuildSystem\Scripts\build_manager_config.json"
}

$Cfg = $null
if (Test-Path $ConfigPath) {
    try {
        $Cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($VcsMode) -and $Cfg.VcsMode) { $VcsMode = $Cfg.VcsMode }
        if ([string]::IsNullOrWhiteSpace($UE5Root) -and $Cfg.UE5Root) { $UE5Root = $Cfg.UE5Root }
        if ([string]::IsNullOrWhiteSpace($ProjectDir) -and $Cfg.ProjectDir) { $ProjectDir = $Cfg.ProjectDir }
        if ($Cfg.SharedAssetsDir) { $SharedAssets = $Cfg.SharedAssetsDir }
        if ($Cfg.ArchiveRoot) { $ArchiveRoot = $Cfg.ArchiveRoot }
        if ([string]::IsNullOrWhiteSpace($ClientConfig) -and $Cfg.ClientConfig) { $ClientConfig = $Cfg.ClientConfig }
        if ($null -eq $EnablePackageRetention -and $null -ne $Cfg.EnablePackageRetention) {
            $EnablePackageRetention = [bool]$Cfg.EnablePackageRetention
        }
        if ($MaxRetainedPackages -le 0 -and $Cfg.MaxRetainedPackages -gt 0) {
            $MaxRetainedPackages = [int]$Cfg.MaxRetainedPackages
        }
    } catch {}
}

if ([string]::IsNullOrWhiteSpace($VcsMode)) { $VcsMode = if (-not [string]::IsNullOrWhiteSpace($Changelist)) { "PerforceHybrid" } else { "Git" } }
if ([string]::IsNullOrWhiteSpace($ClientConfig)) { $ClientConfig = "Development" }
if ([string]::IsNullOrWhiteSpace($UE5Root)) {
    # 배포 호환성: 설치된 최신 UE_5.* 폴더를 자동 탐지
    foreach ($BaseDir in @("C:\Program Files\Epic Games", "D:\Epic Games", "E:\Epic Games")) {
        if (Test-Path $BaseDir) {
            $AutoUE = Get-ChildItem -Path $BaseDir -Directory -Filter "UE_5*" -ErrorAction SilentlyContinue |
                Where-Object { Test-Path (Join-Path $_.FullName "Engine\Build\BatchFiles\RunUAT.bat") } |
                Sort-Object Name -Descending |
                Select-Object -First 1
            if ($AutoUE) { $UE5Root = $AutoUE.FullName; break }
        }
    }
}
if ([string]::IsNullOrWhiteSpace($UE5Root)) { $UE5Root = "C:\Program Files\Epic Games\UE_5.5" }
if ($null -eq $EnablePackageRetention) { $EnablePackageRetention = $true }
if ($MaxRetainedPackages -le 0) { $MaxRetainedPackages = 10 }

if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
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
# 2. 현재 버전 메타데이터 수집 (Perforce CL 또는 Git + GitHub API 폴백)
# ==============================================================================
$SafeBranch = ($BranchName -replace '^origin/', '') -replace '[\\/:*?"<>|]', '_'
$CommitHash = ""

if ($VcsMode -eq "PerforceHybrid") {
    $P4Port   = if ($Cfg -and $Cfg.P4Port) { $Cfg.P4Port } else { "localhost:1666" }
    $P4User   = if ($Cfg -and $Cfg.P4User) { $Cfg.P4User } else { "p4bot" }
    $P4Stream = if ($Cfg -and $Cfg.P4Stream) { $Cfg.P4Stream.TrimEnd('/') } else { "" }

    if ([string]::IsNullOrWhiteSpace($Changelist) -and (Get-Command p4 -ErrorAction SilentlyContinue) -and -not [string]::IsNullOrWhiteSpace($P4Stream)) {
        try {
            $HeadLines = & p4 -p $P4Port -u $P4User -ztag changes -s submitted -m 1 "$P4Stream/..." 2>$null
            foreach ($L in $HeadLines) {
                if ($L -match '^\.\.\.\s+change\s+(\d+)$') { $Changelist = $Matches[1]; break }
            }
        } catch {}
    }

    if (-not [string]::IsNullOrWhiteSpace($Changelist)) {
        $CommitHash = "CL$Changelist"
        if (([string]::IsNullOrWhiteSpace($CommitAuthor) -or [string]::IsNullOrWhiteSpace($CommitMsg)) -and (Get-Command p4 -ErrorAction SilentlyContinue)) {
            try {
                $DescLines = & p4 -p $P4Port -u $P4User -ztag describe -s $Changelist 2>$null
                foreach ($L in $DescLines) {
                    if ([string]::IsNullOrWhiteSpace($CommitAuthor) -and $L -match '^\.\.\.\s+user\s+(.+)$') {
                        $CommitAuthor = $Matches[1].Trim()
                    }
                    if ([string]::IsNullOrWhiteSpace($CommitMsg) -and $L -match '^\.\.\.\s+desc\s+(.+)$') {
                        $CommitMsg = $Matches[1].Trim()
                    }
                }
            } catch {}
        }
    }
} else {
    $CommitHash = (git -c safe.directory=* -c core.quotepath=false rev-parse --short HEAD 2>$null)
    if ($CommitHash) { $CommitHash = $CommitHash.Trim() }
    if ([string]::IsNullOrWhiteSpace($CommitAuthor)) {
        $CommitAuthor = (git -c safe.directory=* -c core.quotepath=false -c i18n.logOutputEncoding=utf-8 log -1 --pretty=format:"%an" 2>$null)
        if ($CommitAuthor) { $CommitAuthor = $CommitAuthor.Trim() }
    }
    if ([string]::IsNullOrWhiteSpace($CommitMsg)) {
        $CommitMsg = (git -c safe.directory=* -c core.quotepath=false -c i18n.logOutputEncoding=utf-8 log -1 --pretty=format:"%s" 2>$null)
        if ($CommitMsg) { $CommitMsg = $CommitMsg.Trim() }
    }

    if (([string]::IsNullOrWhiteSpace($CommitHash) -or [string]::IsNullOrWhiteSpace($CommitAuthor) -or [string]::IsNullOrWhiteSpace($CommitMsg)) -and $Cfg -and $Cfg.ConnectedRepoFullName -and $Cfg.GitHubAccessToken) {
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $ApiUrl = "https://api.github.com/repos/$($Cfg.ConnectedRepoFullName)/commits/$([uri]::EscapeDataString($BranchName))"
            $GhResp = Invoke-RestMethod -Uri $ApiUrl -Headers @{ Authorization = "Bearer $($Cfg.GitHubAccessToken)"; "User-Agent" = "BuildServerKit" } -ErrorAction Stop
            if ([string]::IsNullOrWhiteSpace($CommitHash) -and $GhResp.sha) {
                $CommitHash = $GhResp.sha.Substring(0, [Math]::Min(7, $GhResp.sha.Length))
            }
            if ([string]::IsNullOrWhiteSpace($CommitAuthor)) {
                $AName  = $GhResp.commit.author.name
                $ALogin = $GhResp.author.login
                if ($AName -and $ALogin -and ($AName -ne $ALogin)) { $CommitAuthor = "$AName (@$ALogin)" }
                elseif ($ALogin) { $CommitAuthor = $ALogin }
                elseif ($AName) { $CommitAuthor = $AName }
            }
            if ([string]::IsNullOrWhiteSpace($CommitMsg) -and $GhResp.commit.message) {
                $CommitMsg = ($GhResp.commit.message -split "`r?`n")[0].Trim()
            }
        } catch {}
    }
}

if ([string]::IsNullOrWhiteSpace($CommitHash))   { $CommitHash = "latest" }
if ([string]::IsNullOrWhiteSpace($CommitAuthor)) { $CommitAuthor = if ($Cfg -and $Cfg.GitHubUser) { $Cfg.GitHubUser } else { $env:USERNAME } }
if ([string]::IsNullOrWhiteSpace($CommitMsg))    { $CommitMsg = "(커밋 메시지 없음)" }
$TimeStamp = Get-Date -Format "yyyy-MM-dd_HHmmss"

# ==============================================================================
# 3. 이번 빌드의 전수 로그 아카이브 폴더 생성
# ==============================================================================
$BuildId       = "${TimeStamp}_${BuildMode}_${SafeBranch}_${CommitHash}"
$LogArchiveDir = "$ArchiveRoot\Logs\$BuildId"
New-Item -ItemType Directory -Force -Path $LogArchiveDir | Out-Null

@"
Project Name  : $ProjectName
VCS Mode      : $VcsMode
Build ID      : $BuildId
Build Mode    : $BuildMode
Client Config : $ClientConfig
Branch        : $BranchName
Version Ref   : $CommitHash
Commit Author : $CommitAuthor
Commit Message: $CommitMsg
Start Time    : $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
"@ | Out-File -FilePath "$LogArchiveDir\Build_Info.txt" -Encoding utf8

# ==============================================================================
# 4. 에셋 연결 (Git 단독 모드일 때만 .gitignore 제외 폴더 심볼릭 링크 연결)
# ==============================================================================
if ($VcsMode -ne "PerforceHybrid") {
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
} else {
    Write-Host "[PerforceHybrid] 대용량 에셋은 로컬 Perforce 워크스페이스에서 직접 동기화되므로 .gitignore 정션 연결을 건너뜁니다." -ForegroundColor DarkCyan
}

# 이전 빌드의 Saved/Logs 정리
if (Test-Path "$ProjectDir\Saved\Logs") {
    Remove-Item "$ProjectDir\Saved\Logs\*" -Recurse -Force -ErrorAction SilentlyContinue
}

# ==============================================================================
# 5. 빌드 모드별 RunUAT.bat 인자 구성
# ==============================================================================
$UATLogFile = "$LogArchiveDir\Full_UAT_Console.log"
$PackageOutDir = $null

if ($BuildMode -eq "QuickVerify") {
    $UATArgs = @(
        "BuildCookRun",
        "-project=`"$UProjectFile`"",
        "-noP4",
        "-platform=Win64",
        "-clientconfig=$ClientConfig",
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
        "-clientconfig=$ClientConfig",
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
"" | Out-File -FilePath $UATLogFile -Encoding utf8 -NoNewline
& $RunUAT @UATArgs 2>&1 | ForEach-Object {
    Write-Host $_
    $_ | Out-File -FilePath $UATLogFile -Encoding utf8 -Append
}
$ExitCode = $LASTEXITCODE
$Elapsed = (Get-Date) - $StartTime
$Duration = "{0:D2}분 {1:D2}초" -f [int]$Elapsed.TotalMinutes, $Elapsed.Seconds

# 패키징 성공 시: 게임 옵션 런처 동봉 + 오래된 패키징 빌드 자동 보관 개수 정리
if ($BuildMode -eq "FullPackage" -and $ExitCode -eq 0 -and $PackageOutDir -and (Test-Path $PackageOutDir)) {
    $MgrExe = Join-Path $ScriptDir "UE_BuildManager.exe"
    if (-not (Test-Path $MgrExe)) { $MgrExe = "C:\BuildSystem\Scripts\UE_BuildManager.exe" }
    if (Test-Path $MgrExe) {
        $DefPreset = if ($Cfg -and $Cfg.DefaultQualityPreset) { $Cfg.DefaultQualityPreset } else { "Epic" }
        $DefRes    = if ($Cfg -and $Cfg.DefaultResolution)    { $Cfg.DefaultResolution }    else { "1920x1080" }
        $DefWin    = if ($Cfg -and $Cfg.DefaultWindowMode)    { $Cfg.DefaultWindowMode }    else { "WindowedFullscreen" }
        $DefFps    = if ($Cfg -and ($null -ne $Cfg.DefaultFrameRateLimit)) { [int]$Cfg.DefaultFrameRateLimit } else { 0 }
        $DefVSync  = if ($Cfg -and ($null -ne $Cfg.DefaultVSync)) { [bool]$Cfg.DefaultVSync } else { $false }
        $GenLnch   = if ($Cfg -and ($null -ne $Cfg.GenerateLauncherOnPackage)) { [bool]$Cfg.GenerateLauncherOnPackage } else { $true }
        if ($GenLnch) {
            & $MgrExe --make-launcher $PackageOutDir $ProjectName $DefPreset $DefRes $DefWin $DefFps $DefVSync | Out-Null
        }
    }

    # 패키징 빌드 보관 개수 제한 적용 (성공한 빌드 직후에만 오래된 순으로 안전 삭제)
    if ($EnablePackageRetention -and $MaxRetainedPackages -ge 1) {
        $PackagesRoot = Join-Path $ArchiveRoot "Packages"
        if (Test-Path $PackagesRoot) {
            $AllPkgs = @(Get-ChildItem -Path $PackagesRoot -Directory -ErrorAction SilentlyContinue |
                Sort-Object -Property @{ Expression = { $_.CreationTimeUtc }; Descending = $true }, @{ Expression = { $_.Name }; Descending = $true })

            if ($AllPkgs.Count -gt $MaxRetainedPackages) {
                $ToRemove = $AllPkgs | Select-Object -Skip $MaxRetainedPackages
                Write-Host "`n[보관 정책] 패키지 최대 ${MaxRetainedPackages}개 유지 — 오래된 빌드 $($ToRemove.Count)개 정리 중..." -ForegroundColor Yellow
                foreach ($OldDir in $ToRemove) {
                    if ($OldDir.FullName -ne $PackageOutDir) {
                        try {
                            Remove-Item -Path $OldDir.FullName -Recurse -Force -ErrorAction Stop
                            Write-Host "  [삭제 완료] $($OldDir.Name)" -ForegroundColor DarkYellow
                        } catch {
                            Write-Warning "  [삭제 실패] $($OldDir.Name): $($_.Exception.Message)"
                        }
                    }
                }
            }
        }
    }
}

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
# 8. Slack & Discord 리포트 및 에러 발생 시 로그 즉시 전송 호출
# ==============================================================================
$AutoSlack   = if ($Cfg -and ($null -ne $Cfg.AutoSendSlack))   { [bool]$Cfg.AutoSendSlack }   else { $true }
$AutoDiscord = if ($Cfg -and ($null -ne $Cfg.AutoSendDiscord)) { [bool]$Cfg.AutoSendDiscord } else { $true }

if ($AutoSlack) {
    $SlackScript = Join-Path $ScriptDir "Send-SlackReport.ps1"
    if (-not (Test-Path $SlackScript)) { $SlackScript = "C:\BuildSystem\Scripts\Send-SlackReport.ps1" }
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
}

if ($AutoDiscord) {
    $DiscordScript = Join-Path $ScriptDir "Send-DiscordReport.ps1"
    if (-not (Test-Path $DiscordScript)) { $DiscordScript = "C:\BuildSystem\Scripts\Send-DiscordReport.ps1" }
    if (Test-Path $DiscordScript) {
        & $DiscordScript `
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
}

exit $ExitCode
