param(
    [string]$ProjectName = "UEProject",
    [int]$ExitCode,
    [string]$BuildMode,
    [string]$BranchName,
    [string]$CommitHash,
    [string]$CommitAuthor,
    [string]$CommitMsg,
    [string]$Duration,
    [string]$LogArchiveDir,
    [string]$UATLogFile
)

$ErrorActionPreference = "Continue"

$SlackBotToken  = $env:SLACK_BOT_TOKEN
$SlackChannelId = $env:SLACK_CHANNEL_ID
$TailscaleIP    = $env:TAILSCALE_IP

# 환경변수가 없으면 설정 파일(build_manager_config.json)에서 읽기 시도
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ScriptDir "build_manager_config.json"
if (Test-Path $ConfigPath) {
    try {
        $Cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($SlackBotToken) -and $Cfg.SlackBotToken) { $SlackBotToken = $Cfg.SlackBotToken }
        if ([string]::IsNullOrWhiteSpace($SlackChannelId) -and $Cfg.SlackChannelId) { $SlackChannelId = $Cfg.SlackChannelId }
        if ([string]::IsNullOrWhiteSpace($TailscaleIP) -and $Cfg.TailscaleIP) { $TailscaleIP = $Cfg.TailscaleIP }
    } catch {}
}

if ([string]::IsNullOrWhiteSpace($TailscaleIP)) { $TailscaleIP = "전용PC_IP" }

if ([string]::IsNullOrWhiteSpace($SlackBotToken) -or [string]::IsNullOrWhiteSpace($SlackChannelId)) {
    Write-Warning "SLACK_BOT_TOKEN 또는 SLACK_CHANNEL_ID가 설정되지 않아 Slack 전송을 건너뜁니다."
    exit 0
}

$ModeLabel = if ($BuildMode -eq "QuickVerify") { "⚡ 빠른 컴파일·쿠킹 검증" } else { "📦 전체 패키징 빌드" }
$SharedLogPath = $LogArchiveDir -replace '^[A-Za-z]:\\BuildArchive', "\\$TailscaleIP\BuildArchive"

# ==============================================================================
# 1. 성공 시 알림 전송
# ==============================================================================
if ($ExitCode -eq 0) {
    $SuccessText = "✅ *[$ProjectName 성공]* $ModeLabel 완료`n• *브랜치/커밋:* `$BranchName` (`$CommitHash`) by *$CommitAuthor*`n• *커밋 메시지:* $CommitMsg`n• *소요 시간:* $Duration`n• *로그/결과물 공유폴더:* `$SharedLogPath`"
    $Body = @{ channel = $SlackChannelId; text = $SuccessText } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "https://slack.com/api/chat.postMessage" -Method Post `
        -Headers @{ Authorization = "Bearer $SlackBotToken"; "Content-Type" = "application/json; charset=utf-8" } `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($Body)) | Out-Null
    exit 0
}

# ==============================================================================
# 2. 실패(Error) 발생 시: 에러 발생 당시 핵심 로그 추출
# ==============================================================================
$ErrorPattern = "error C\d+:|\bfatal error\b|Error:|Ensure condition failed|AutomationTool exiting with ExitCode"
$ExtractedErrors = Select-String -Path $UATLogFile -Pattern $ErrorPattern -Context 1, 2 -ErrorAction SilentlyContinue |
    Select-Object -Last 25 |
    ForEach-Object { $_.Line.Trim() }

$ErrorSummaryFile = "$LogArchiveDir\Error_Summary.log"
$ExtractedErrors | Out-File -FilePath $ErrorSummaryFile -Encoding utf8

$ErrorSnippet = ($ExtractedErrors -join "`n")
if ($ErrorSnippet.Length -gt 2500) {
    $ErrorSnippet = $ErrorSnippet.Substring($ErrorSnippet.Length - 2500)
}
if ([string]::IsNullOrWhiteSpace($ErrorSnippet) -and (Test-Path $UATLogFile)) {
    $ErrorSnippet = (Get-Content $UATLogFile -Tail 30) -join "`n"
}

$FailMessage = @"
🚨 *[$ProjectName 빌드/패키징 실패]* ($ModeLabel)
• *브랜치 / 커밋:* `$BranchName` (`$CommitHash`)
• *작성자:* *$CommitAuthor*
• *커밋 메시지:* $CommitMsg
• *소요 시간:* $Duration (ExitCode: $ExitCode)
• *전체 로그 공유폴더:* `$SharedLogPath`

*🔍 [에러 발생 당시 핵심 로그 발췌]*
``````
$ErrorSnippet
``````
"@

$MsgBody = @{ channel = $SlackChannelId; text = $FailMessage } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "https://slack.com/api/chat.postMessage" -Method Post `
    -Headers @{ Authorization = "Bearer $SlackBotToken"; "Content-Type" = "application/json; charset=utf-8" } `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($MsgBody)) | Out-Null

# ==============================================================================
# 3. 에러 발생 당시 원본 로그 파일을 Slack 채팅방에 첨부파일로 직접 업로드
# ==============================================================================
if (Test-Path $UATLogFile) {
    $FileBytes = [System.IO.File]::ReadAllBytes($UATLogFile)
    $FileName  = "ErrorLog_${ProjectName}_${BranchName}_${CommitHash}.log"

    $UploadUrlResp = Invoke-RestMethod -Uri "https://slack.com/api/files.getUploadURLExternal?filename=$FileName&length=$($FileBytes.Length)" `
        -Method Get -Headers @{ Authorization = "Bearer $SlackBotToken" }

    if ($UploadUrlResp.ok) {
        Invoke-RestMethod -Uri $UploadUrlResp.upload_url -Method Post -Body $FileBytes -ContentType "application/octet-stream" | Out-Null
        $CompleteBody = @{
            files           = @(@{ id = $UploadUrlResp.file_id; title = "원본 전체 빌드 로그 ($FileName)" })
            channel_id      = $SlackChannelId
            initial_comment = "📎 *작업 PC에서 바로 열람 가능한 에러 발생 당시 전체 원본 로그 파일입니다.*"
        } | ConvertTo-Json -Depth 4 -Compress

        Invoke-RestMethod -Uri "https://slack.com/api/files.completeUploadExternal" -Method Post `
            -Headers @{ Authorization = "Bearer $SlackBotToken"; "Content-Type" = "application/json; charset=utf-8" } `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($CompleteBody)) | Out-Null
    }
}
