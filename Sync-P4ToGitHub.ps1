<#
.SYNOPSIS
    Perforce(P4) -> GitHub 자동 코드 & 에셋 변경 요약 미러링 스크립트 (워터마크 순차 처리)
.DESCRIPTION
    - 마지막 미러링 CL(last_mirrored_cl.txt) 이후의 신규 Submitted CL을 오래된 순으로 처리합니다.
    - 코드 전용 P4 워크스페이스(ws-mirror-code)로 소스/설정 파일만 동기화하고,
      아티스트의 에셋 Submit도 .p4-sync/asset_changelog.md에 1줄 요약으로 기록하여
      원작성자 GitHub 잔디와 자동 쿠킹 검증(QuickVerify)을 누락 없이 연결합니다.
#>
param(
    [string]$ConfigPath = "",
    [string]$P4Port = "",
    [string]$P4User = "",
    [string]$P4Stream = "",
    [string]$P4MirrorClient = "",
    [string]$P4MirrorDir = "",
    [string]$GitBranch = "",
    [string]$AssetLogRelPath = "",
    [int]$StartFromCL = 0,
    [int]$MaxBatch = 50,
    [switch]$InitWatermark,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:P4CHARSET = "utf8"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1. 설정 파일 로드
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $Candidate1 = Join-Path $ScriptDir "build_manager_config.json"
    $Candidate2 = "C:\BuildSystem\Scripts\build_manager_config.json"
    if (Test-Path $Candidate1) { $ConfigPath = $Candidate1 }
    elseif (Test-Path $Candidate2) { $ConfigPath = $Candidate2 }
}

$Cfg = $null
if ($ConfigPath -and (Test-Path $ConfigPath)) {
    try {
        $Cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Warning "설정 파일 파싱 실패 ($ConfigPath): $($_.Exception.Message)"
    }
}

if ([string]::IsNullOrWhiteSpace($P4Port))          { $P4Port          = if ($Cfg -and $Cfg.P4Port) { $Cfg.P4Port } else { "localhost:1666" } }
if ([string]::IsNullOrWhiteSpace($P4User))          { $P4User          = if ($Cfg -and $Cfg.P4User) { $Cfg.P4User } else { "p4bot" } }
if ([string]::IsNullOrWhiteSpace($P4Stream))        { $P4Stream        = if ($Cfg -and $Cfg.P4Stream) { $Cfg.P4Stream } else { "//MyProject/main" } }
if ([string]::IsNullOrWhiteSpace($P4MirrorClient))  { $P4MirrorClient  = if ($Cfg -and $Cfg.P4MirrorClient) { $Cfg.P4MirrorClient } else { "ws-mirror-code" } }
if ([string]::IsNullOrWhiteSpace($P4MirrorDir))     { $P4MirrorDir     = if ($Cfg -and $Cfg.P4MirrorDir) { $Cfg.P4MirrorDir } else { "C:\BuildSystem\P4MirrorRepo" } }
if ([string]::IsNullOrWhiteSpace($GitBranch))       { $GitBranch       = if ($Cfg -and $Cfg.LastBranch) { $Cfg.LastBranch } else { "main" } }
if ([string]::IsNullOrWhiteSpace($AssetLogRelPath)) { $AssetLogRelPath = if ($Cfg -and $Cfg.P4MirrorAssetLogPath) { $Cfg.P4MirrorAssetLogPath } else { ".p4-sync/asset_changelog.md" } }

$P4StreamClean = $P4Stream.TrimEnd('/')

# 필수 도구 점검
if (-not (Get-Command p4 -ErrorAction SilentlyContinue)) {
    Write-Error "Perforce CLI(p4.exe)를 찾을 수 없습니다. PATH 환경변수를 확인하세요."
    exit 1
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git CLI(git.exe)를 찾을 수 없습니다. PATH 환경변수를 확인하세요."
    exit 1
}
if (-not (Test-Path (Join-Path $P4MirrorDir ".git"))) {
    Write-Error "Git 미러 저장소를 찾을 수 없습니다: $P4MirrorDir (.git 폴더 없음)"
    exit 1
}

# 2. 중복 실행 방지 락
$StateDir = Join-Path $ScriptDir ".p4_state"
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
$LockFile      = Join-Path $StateDir "mirror.lock"
$WatermarkFile = Join-Path $StateDir "last_mirrored_cl.txt"

if (Test-Path $LockFile) {
    $OldPid = (Get-Content $LockFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($OldPid -match '^\d+$' -and (Get-Process -Id ([int]$OldPid) -ErrorAction SilentlyContinue)) {
        Write-Host "[P4Mirror] 이미 다른 미러링 프로세스(PID=$OldPid)가 실행 중이므로 이번 주기를 건너뜁니다." -ForegroundColor Yellow
        exit 0
    }
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}
Set-Content -Path $LockFile -Value $PID -Encoding Ascii

function Invoke-P4 {
    param([string[]]$P4Args)
    $FullArgs = @("-p", $P4Port, "-u", $P4User) + $P4Args
    $Out = & p4 @FullArgs 2>&1
    $Code = $LASTEXITCODE
    return [PSCustomObject]@{
        ExitCode = $Code
        Lines    = @($Out | ForEach-Object { $_.ToString() })
    }
}

# 작성자 이메일 매핑 테이블 로드 (author_map.json)
$AuthorMap = @{}
foreach ($MapCandidate in @((Join-Path $ScriptDir "author_map.json"), "C:\BuildSystem\Scripts\author_map.json")) {
    if (Test-Path $MapCandidate) {
        try {
            $MapObj = Get-Content $MapCandidate -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($Prop in $MapObj.PSObject.Properties) {
                if ($Prop.Name -notlike "_*") {
                    $AuthorMap[$Prop.Name.ToLower()] = $Prop.Value
                }
            }
            break
        } catch {}
    }
}

$AuthorCache = @{}
function Resolve-P4Author {
    param([string]$UserId)
    $Key = $UserId.ToLower()
    if ($AuthorCache.ContainsKey($Key)) { return $AuthorCache[$Key] }

    if ($AuthorMap.ContainsKey($Key)) {
        $Mapped = $AuthorMap[$Key]
        $Res = [PSCustomObject]@{
            Name  = if ($Mapped.name)  { $Mapped.name }  else { $UserId }
            Email = if ($Mapped.email) { $Mapped.email } else { "$UserId@users.noreply.github.com" }
        }
        $AuthorCache[$Key] = $Res
        return $Res
    }

    $Name  = $UserId
    $Email = "$UserId@users.noreply.github.com"
    $UserRes = Invoke-P4 @("-ztag", "user", "-o", $UserId)
    if ($UserRes.ExitCode -eq 0) {
        foreach ($Line in $UserRes.Lines) {
            if ($Line -match '^\.\.\.\s+FullName\s+(.+)$') { $Name  = $Matches[1].Trim() }
            if ($Line -match '^\.\.\.\s+Email\s+(.+)$')    { $Email = $Matches[1].Trim() }
        }
    }
    $Res = [PSCustomObject]@{ Name = $Name; Email = $Email }
    $AuthorCache[$Key] = $Res
    return $Res
}

function Get-P4ClientRoot {
    param([string]$ClientName)
    $Res = Invoke-P4 @("-ztag", "client", "-o", $ClientName)
    if ($Res.ExitCode -ne 0) { return "" }
    foreach ($Line in $Res.Lines) {
        if ($Line -match '^\.\.\.\s+Root\s+(.+)$') {
            return $Matches[1].Trim()
        }
    }
    return ""
}

function Parse-ZtagDescribe {
    param([int]$CL)
    $Res = Invoke-P4 @("-ztag", "describe", "-s", "$CL")
    if ($Res.ExitCode -ne 0) {
        throw "p4 describe -s $CL 실패: $($Res.Lines -join ' ')"
    }

    $User = ""
    $Epoch = 0L
    $DescLines = New-Object System.Collections.Generic.List[string]
    $InDesc = $false
    $DepotFiles = @{}
    $Actions = @{}

    foreach ($Line in $Res.Lines) {
        if ($Line -match '^\.\.\.\s+([A-Za-z0-9_]+)\s*(.*)$') {
            $InDesc = $false
            $Field = $Matches[1]
            $Val   = $Matches[2]
            if ($Field -eq "user") { $User = $Val.Trim() }
            elseif ($Field -eq "time") { [long]::TryParse($Val.Trim(), [ref]$Epoch) | Out-Null }
            elseif ($Field -eq "desc") {
                $InDesc = $true
                $DescLines.Add($Val)
            }
            elseif ($Field -match '^depotFile(\d+)$') { $DepotFiles[[int]$Matches[1]] = $Val.Trim() }
            elseif ($Field -match '^action(\d+)$')    { $Actions[[int]$Matches[1]]    = $Val.Trim() }
        } elseif ($InDesc) {
            $DescLines.Add($Line)
        }
    }

    $Files = New-Object System.Collections.Generic.List[PSCustomObject]
    foreach ($Idx in ($DepotFiles.Keys | Sort-Object)) {
        $Files.Add([PSCustomObject]@{
            DepotPath = $DepotFiles[$Idx]
            Action    = if ($Actions.ContainsKey($Idx)) { $Actions[$Idx] } else { "edit" }
        })
    }

    $FullDesc = ($DescLines -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($FullDesc)) { $FullDesc = "Perforce submit" }

    return [PSCustomObject]@{
        CL       = $CL
        User     = $User
        Epoch    = $Epoch
        Desc     = $FullDesc
        Files    = $Files
    }
}

try {
    Write-Host "=== [P4 -> GitHub 미러링 시작] Server=$P4Port, User=$P4User, Stream=$P4StreamClean ===" -ForegroundColor Cyan

    # 인증 / 연결 확인
    $InfoRes = Invoke-P4 @("info")
    if ($InfoRes.ExitCode -ne 0) {
        throw "Perforce 서버 연결 실패 ($P4Port): $($InfoRes.Lines -join ' ')"
    }

    # P4 미러 워크스페이스 루트 확인
    $ClientRoot = Get-P4ClientRoot -ClientName $P4MirrorClient
    if ([string]::IsNullOrWhiteSpace($ClientRoot)) {
        throw "Perforce 미러 워크스페이스($P4MirrorClient)의 Root를 찾을 수 없습니다."
    }
    $NormClientRoot = [System.IO.Path]::GetFullPath($ClientRoot).TrimEnd('\')
    $NormMirrorDir  = [System.IO.Path]::GetFullPath($P4MirrorDir).TrimEnd('\')
    $IsSameDir      = $NormClientRoot.Equals($NormMirrorDir, [System.StringComparison]::OrdinalIgnoreCase)

    # 3. 워터마크(마지막 미러링 CL) 로드
    $LastCL = 0
    if ($StartFromCL -gt 0) {
        $LastCL = $StartFromCL
    } elseif (Test-Path $WatermarkFile) {
        $RawWm = (Get-Content $WatermarkFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($RawWm -match '^\d+$') { $LastCL = [int]$RawWm }
    }

    if ($InitWatermark) {
        $HeadRes = Invoke-P4 @("-ztag", "changes", "-s", "submitted", "-m", "1", "$P4StreamClean/...")
        if ($HeadRes.ExitCode -ne 0) { throw "최신 CL 조회 실패: $($HeadRes.Lines -join ' ')" }
        $Latest = 0
        foreach ($L in $HeadRes.Lines) {
            if ($L -match '^\.\.\.\s+change\s+(\d+)$') { $Latest = [int]$Matches[1]; break }
        }
        Set-Content -Path $WatermarkFile -Value "$Latest" -Encoding Ascii
        Write-Host "[P4Mirror] 초기 워터마크를 현재 최신 CL #$Latest 로 설정했습니다." -ForegroundColor Green
        exit 0
    }

    # 4. 신규 Submitted CL 목록 조회
    $RangeSpec = if ($LastCL -gt 0) { "$P4StreamClean/...@>$LastCL,#head" } else { "$P4StreamClean/..." }
    $ChgRes = Invoke-P4 @("-ztag", "changes", "-s", "submitted", "-m", "$MaxBatch", $RangeSpec)
    if ($ChgRes.ExitCode -ne 0) {
        throw "p4 changes 조회 실패: $($ChgRes.Lines -join ' ')"
    }

    $PendingCLs = New-Object System.Collections.Generic.List[int]
    foreach ($Line in $ChgRes.Lines) {
        if ($Line -match '^\.\.\.\s+change\s+(\d+)$') {
            $Num = [int]$Matches[1]
            if ($Num -gt $LastCL) { $PendingCLs.Add($Num) }
        }
    }

    if ($PendingCLs.Count -eq 0) {
        Write-Host "[P4Mirror] 새로운 CL이 없습니다. (마지막 미러링: CL #$LastCL)" -ForegroundColor Gray
        exit 0
    }

    $OrderedCLs = $PendingCLs | Sort-Object
    Write-Host "[P4Mirror] 신규 CL $($OrderedCLs.Count)건 감지: $($OrderedCLs -join ', ')" -ForegroundColor Green

    # Git 원격 최신화 (웹에서 .github/workflows/build.yml 수정 시 충돌 방지)
    Set-Location $NormMirrorDir
    if (-not $DryRun) {
        if ($Cfg -and $Cfg.GitHubAccessToken -and $Cfg.GitRemoteUrl -and $Cfg.GitRemoteUrl.StartsWith("https://github.com/")) {
            $AuthUrl = $Cfg.GitRemoteUrl -replace '^https://github\.com/', "https://x-access-token:$($Cfg.GitHubAccessToken)@github.com/"
            & git -c safe.directory=* remote set-url origin $AuthUrl 2>$null
        }
        & git -c safe.directory=* fetch origin $GitBranch 2>$null
        $CurrBranch = (& git -c safe.directory=* rev-parse --abbrev-ref HEAD 2>$null).Trim()
        if ($CurrBranch -ne $GitBranch) {
            & git -c safe.directory=* checkout $GitBranch 2>$null
        }
        & git -c safe.directory=* pull --rebase --autostash origin $GitBranch 2>$null
    }

    $AssetExtRegex = '\.(uasset|umap|fbx|obj|png|jpg|jpeg|tga|psd|exr|hdr|wav|mp3|ogg|mp4|mov|blend|max|ma|mb|spp|uexp|ubulk)$'
    $CommittedCount = 0
    $HighestProcessedCL = $LastCL
    $AssetLogAbsPath = Join-Path $NormMirrorDir ($AssetLogRelPath -replace '/', '\')

    foreach ($CL in $OrderedCLs) {
        $Info = Parse-ZtagDescribe -CL $CL
        $Author = Resolve-P4Author -UserId $Info.User
        $SubmitTime = if ($Info.Epoch -gt 0) {
            [DateTimeOffset]::FromUnixTimeSeconds($Info.Epoch).ToLocalTime()
        } else {
            [DateTimeOffset]::Now
        }
        $TimeStr = $SubmitTime.ToString("yyyy-MM-dd HH:mm")
        $GitIsoDate = $SubmitTime.ToString("yyyy-MM-ddTHH:mm:sszzz")

        # 변경된 에셋 파일 추출
        $AssetChanges = New-Object System.Collections.Generic.List[PSCustomObject]
        foreach ($F in $Info.Files) {
            if (($F.DepotPath -imatch '/Content/') -or ($F.DepotPath -imatch $AssetExtRegex)) {
                $Leaf = [System.IO.Path]::GetFileName($F.DepotPath)
                $AssetChanges.Add([PSCustomObject]@{
                    Name   = $Leaf
                    Action = $F.Action
                    Path   = $F.DepotPath
                })
            }
        }

        $FirstDescLine = (($Info.Desc -split "`r?`n") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
        if ([string]::IsNullOrWhiteSpace($FirstDescLine)) { $FirstDescLine = "Perforce submit" }
        $FirstDescLine = $FirstDescLine.Trim()

        $AssetShortSummary = ""
        $AssetDetailLine   = ""
        if ($AssetChanges.Count -gt 0) {
            $TopNames = @($AssetChanges | Select-Object -First 3 | ForEach-Object { $_.Name })
            $ExtraCnt = $AssetChanges.Count - $TopNames.Count
            $AssetShortSummary = ($TopNames -join ", ")
            if ($ExtraCnt -gt 0) { $AssetShortSummary += " 외 ${ExtraCnt}건" }

            $ActionPairs = @($AssetChanges | Select-Object -First 5 | ForEach-Object { "$($_.Action): $($_.Name)" })
            $ExtraDetail = $AssetChanges.Count - $ActionPairs.Count
            $AssetDetailLine = "- [CL #$CL] $TimeStr | $($Info.User) | $($ActionPairs -join ', ')"
            if ($ExtraDetail -gt 0) { $AssetDetailLine += " 외 ${ExtraDetail}건" }
        }

        $CommitSubject = if ($AssetShortSummary) {
            "[CL #$CL] $FirstDescLine (에셋: $AssetShortSummary)"
        } else {
            "[CL #$CL] $FirstDescLine"
        }

        Write-Host "  -> 처리 중: $CommitSubject by $($Author.Name) <$($Author.Email)>" -ForegroundColor Cyan

        if ($DryRun) {
            if ($AssetDetailLine) { Write-Host "     [DryRun 에셋 로그] $AssetDetailLine" -ForegroundColor DarkGray }
            $HighestProcessedCL = $CL
            continue
        }

        # 코드 전용 워크스페이스 동기화
        $SyncRes = Invoke-P4 @("-c", $P4MirrorClient, "sync", "//...@$CL")
        if ($SyncRes.ExitCode -ne 0) {
            throw "p4 sync (CL #$CL) 실패: $($SyncRes.Lines -join ' ')"
        }

        # P4 미러 클라이언트 루트와 Git 저장소 경로가 다르면 보호 복사 (.git, .github, .p4-sync 보호)
        if (-not $IsSameDir) {
            & robocopy $NormClientRoot $NormMirrorDir /MIR /XD ".git" ".github" ".p4-sync" /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) {
                throw "robocopy 미러 복사 실패 (ExitCode=$LASTEXITCODE)"
            }
        }

        # 아티스트 에셋 변경 시 1줄 요약 기록 (잔디 + 쿠킹 검증 트리거)
        if ($AssetDetailLine) {
            $AssetLogDir = Split-Path -Parent $AssetLogAbsPath
            if (-not (Test-Path $AssetLogDir)) { New-Item -ItemType Directory -Force -Path $AssetLogDir | Out-Null }
            if (-not (Test-Path $AssetLogAbsPath)) {
                $Header = "# Perforce Asset Change Log (Auto-Mirrored)`n`n> 대용량 바이너리 에셋은 로컬 Perforce 서버에서 관리되며, 이 파일은 에셋 Submit 이력 추적 및 자동 쿠킹 검증 트리거용 1줄 요약 로그입니다.`n"
                [System.IO.File]::WriteAllText($AssetLogAbsPath, $Header, (New-Object System.Text.UTF8Encoding($false)))
            }
            [System.IO.File]::AppendAllText($AssetLogAbsPath, "$AssetDetailLine`n", (New-Object System.Text.UTF8Encoding($false)))
        }

        Set-Location $NormMirrorDir
        & git -c safe.directory=* -c core.quotepath=false add -A
        $StatusOut = & git -c safe.directory=* -c core.quotepath=false status --porcelain

        if (-not [string]::IsNullOrWhiteSpace(($StatusOut -join ""))) {
            $MsgBody = "$CommitSubject`n`n$($Info.Desc)`n`nPerforce-CL: $CL`nPerforce-User: $($Info.User)"
            $TmpMsgFile = Join-Path $StateDir "commit_msg_$CL.txt"
            [System.IO.File]::WriteAllText($TmpMsgFile, $MsgBody, (New-Object System.Text.UTF8Encoding($false)))

            $env:GIT_AUTHOR_NAME     = $Author.Name
            $env:GIT_AUTHOR_EMAIL    = $Author.Email
            $env:GIT_AUTHOR_DATE     = $GitIsoDate
            $env:GIT_COMMITTER_NAME  = $Author.Name
            $env:GIT_COMMITTER_EMAIL = $Author.Email
            $env:GIT_COMMITTER_DATE  = $GitIsoDate

            try {
                & git -c safe.directory=* -c core.quotepath=false commit -F $TmpMsgFile
                if ($LASTEXITCODE -ne 0) {
                    throw "git commit 실패 (CL #$CL)"
                }
                $CommittedCount++
            } finally {
                Remove-Item $TmpMsgFile -Force -ErrorAction SilentlyContinue
                Remove-Item Env:GIT_AUTHOR_NAME, Env:GIT_AUTHOR_EMAIL, Env:GIT_AUTHOR_DATE, Env:GIT_COMMITTER_NAME, Env:GIT_COMMITTER_EMAIL, Env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue
            }
        } else {
            Write-Host "     (변경된 코드/에셋 요약 없음 — 커밋 스킵)" -ForegroundColor DarkGray
        }

        $HighestProcessedCL = $CL
    }

    # 5. 배치 Push (밀린 CL을 묶어 1회 Push -> 잔디는 모두 보존, Actions는 최신 1회만 트리거)
    if (-not $DryRun) {
        if ($CommittedCount -gt 0) {
            Write-Host "[P4Mirror] 총 ${CommittedCount}개 커밋을 GitHub($GitBranch)로 Push 중..." -ForegroundColor Green
            & git -c safe.directory=* push origin $GitBranch
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "[P4Mirror] Push 충돌 감지 -> pull --rebase 후 재시도합니다..."
                & git -c safe.directory=* pull --rebase origin $GitBranch
                if ($LASTEXITCODE -ne 0) { throw "git pull --rebase 실패" }
                & git -c safe.directory=* push origin $GitBranch
                if ($LASTEXITCODE -ne 0) { throw "git push 재시도 실패" }
            }
        }
        # Push 성공 후에만 워터마크 갱신 (CL 유실 방지)
        Set-Content -Path $WatermarkFile -Value "$HighestProcessedCL" -Encoding Ascii
        Write-Host "✔ [P4Mirror] 완료! 최신 미러링 워터마크: CL #$HighestProcessedCL (신규 커밋: ${CommittedCount}건)" -ForegroundColor Green
    } else {
        Write-Host "✔ [P4Mirror DryRun] 완료! 대상 CL: $($OrderedCLs -join ', ')" -ForegroundColor Yellow
    }
}
finally {
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}
