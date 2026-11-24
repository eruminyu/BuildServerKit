<#
.SYNOPSIS
    빌드 결과 요약 Embed 및 실패 시 원본 로그(.log/.zip) Discord Webhook 자동 전송 스크립트
#>
param(
    [string]$ProjectName = "UEProject",
    [int]$ExitCode = 0,
    [string]$BuildMode = "QuickVerify",
    [string]$BranchName = "main",
    [string]$CommitHash = "latest",
    [string]$CommitAuthor = "unknown",
    [string]$CommitMsg = "",
    [string]$Duration = "00분 00초",
    [string]$LogArchiveDir = "",
    [string]$UATLogFile = "",
    [string]$WebhookUrl = "",
    [switch]$TestMode
)

$ErrorActionPreference = "Continue"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$DiscordWebhookUrl = if (-not [string]::IsNullOrWhiteSpace($WebhookUrl)) { $WebhookUrl } else { $env:DISCORD_WEBHOOK_URL }
$TailscaleIP       = $env:TAILSCALE_IP
$AutoSendDiscord   = $true

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ScriptDir "build_manager_config.json"
if (-not (Test-Path $ConfigPath)) {
    $ConfigPath = "C:\BuildSystem\Scripts\build_manager_config.json"
}

if (Test-Path $ConfigPath) {
    try {
        $Cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($DiscordWebhookUrl) -and $Cfg.DiscordWebhookUrl) { $DiscordWebhookUrl = $Cfg.DiscordWebhookUrl }
        if ([string]::IsNullOrWhiteSpace($TailscaleIP) -and $Cfg.TailscaleIP) { $TailscaleIP = $Cfg.TailscaleIP }
        if ($null -ne $Cfg.AutoSendDiscord) { $AutoSendDiscord = [bool]$Cfg.AutoSendDiscord }
    } catch {}
}

if (-not $TestMode -and -not $AutoSendDiscord) {
    exit 0
}
if ([string]::IsNullOrWhiteSpace($DiscordWebhookUrl)) {
    if ($TestMode) {
        Write-Error "DISCORD_WEBHOOK_URL이 설정되지 않았습니다."
        exit 1
    }
    exit 0
}

if ([string]::IsNullOrWhiteSpace($TailscaleIP)) {
    try {
        $UdpSocket = New-Object System.Net.Sockets.Socket([System.Net.Sockets.AddressFamily]::InterNetwork, [System.Net.Sockets.SocketType]::Dgram, 0)
        $UdpSocket.Connect("8.8.8.8", 65530)
        $DetectedIp = ([System.Net.IPEndPoint]$UdpSocket.LocalEndPoint).Address.ToString()
        $UdpSocket.Close()
        if ($DetectedIp -and -not $DetectedIp.StartsWith("127.") -and -not $DetectedIp.StartsWith("169.254.")) {
            $TailscaleIP = $DetectedIp
        }
    } catch {}
}
if ([string]::IsNullOrWhiteSpace($TailscaleIP)) { $TailscaleIP = $env:COMPUTERNAME }

function Send-DiscordMultipart {
    param(
        [string]$Url,
        [string]$PayloadJson,
        [string]$AttachmentPath = "",
        [string]$AttachmentName = ""
    )
    $Client = New-Object System.Net.Http.HttpClient
    $Client.Timeout = [TimeSpan]::FromSeconds(60)
    try {
        if (-not [string]::IsNullOrWhiteSpace($AttachmentPath) -and (Test-Path $AttachmentPath)) {
            $Form = New-Object System.Net.Http.MultipartFormDataContent
            $JsonContent = New-Object System.Net.Http.StringContent($PayloadJson, [System.Text.Encoding]::UTF8, "application/json")
            $Form.Add($JsonContent, "payload_json")

            $FileBytes = [System.IO.File]::ReadAllBytes($AttachmentPath)
            $ByteContent = New-Object System.Net.Http.ByteArrayContent($FileBytes, 0, $FileBytes.Length)
            $ByteContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse("application/octet-stream")
            $SafeFileName = if ([string]::IsNullOrWhiteSpace($AttachmentName)) { [System.IO.Path]::GetFileName($AttachmentPath) } else { $AttachmentName }
            $Form.Add($ByteContent, "files[0]", $SafeFileName)

            $Resp = $Client.PostAsync($Url, $Form).GetAwaiter().GetResult()
        } else {
            $JsonContent = New-Object System.Net.Http.StringContent($PayloadJson, [System.Text.Encoding]::UTF8, "application/json")
            $Resp = $Client.PostAsync($Url, $JsonContent).GetAwaiter().GetResult()
        }

        if (-not $Resp.IsSuccessStatusCode) {
            $ErrBody = $Resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            Write-Warning "Discord Webhook 전송 실패 (HTTP $([int]$Resp.StatusCode)): $ErrBody"
            return $false
        }
        return $true
    } finally {
        $Client.Dispose()
    }
}

# 테스트 메시지 모드
if ($TestMode) {
    $TestPayload = @{
        username = "BuildServerKit"
        embeds   = @(@{
            title       = "✅ BuildServerKit Discord Webhook 연동 테스트 성공!"
            description = "전용 빌드 노트북($env:COMPUTERNAME / ``$TailscaleIP``)에서 정상적으로 연결되었습니다."
            color       = 3066993
            timestamp   = (Get-Date).ToUniversalTime().ToString("o")
        })
    } | ConvertTo-Json -Depth 6 -Compress

    $Ok = Send-DiscordMultipart -Url $DiscordWebhookUrl -PayloadJson $TestPayload
    exit $(if ($Ok) { 0 } else { 1 })
}

$ModeLabel     = if ($BuildMode -eq "QuickVerify") { "빠른 컴파일·쿠킹 검증" } else { "전체 패키징 빌드" }
$RefLabel      = if ($CommitHash -match '^CL(\d+)$') { "CL #$($Matches[1])" } else { $CommitHash }
$SharedLogPath = if ($LogArchiveDir) { $LogArchiveDir -replace '^[A-Za-z]:\\BuildArchive', "\\$TailscaleIP\BuildArchive" } else { "(경로 없음)" }
$ShortMsg      = if ($CommitMsg.Length -gt 240) { $CommitMsg.Substring(0, 237) + "..." } else { $CommitMsg }

# 1. 성공 알림
if ($ExitCode -eq 0) {
    $Payload = @{
        username = "BuildServerKit"
        embeds   = @(@{
            title     = "✅ [$ProjectName] 빌드 성공 ($ModeLabel)"
            color     = 2278750
            fields    = @(
                @{ name = "브랜치 / 버전"; value = "``$BranchName`` · ``$RefLabel``"; inline = $true }
                @{ name = "작성자";        value = "$CommitAuthor"; inline = $true }
                @{ name = "소요 시간";     value = "$Duration"; inline = $true }
                @{ name = "변경 내용";     value = "$ShortMsg"; inline = $false }
                @{ name = "공유 폴더";     value = "``$SharedLogPath``"; inline = $false }
            )
            timestamp = (Get-Date).ToUniversalTime().ToString("o")
        })
    } | ConvertTo-Json -Depth 6 -Compress

    Send-DiscordMultipart -Url $DiscordWebhookUrl -PayloadJson $Payload | Out-Null
    exit 0
}

# 2. 실패 알림 + 핵심 에러 발췌 + 로그 파일 첨부
$ErrorPattern = "error C\d+:|\bfatal error\b|Error:|Ensure condition failed|Unable to find plugin|Result: Failed|UnrealBuildTool failed|AutomationTool exiting with ExitCode"
$ExtractedErrors = @()
if ($UATLogFile -and (Test-Path $UATLogFile)) {
    $ExtractedErrors = @(Select-String -Path $UATLogFile -Pattern $ErrorPattern -Context 1, 2 -ErrorAction SilentlyContinue |
        Select-Object -Last 25 |
        ForEach-Object { $_.Line.Trim() })
}

$ErrorSummaryFile = if ($LogArchiveDir) { Join-Path $LogArchiveDir "Error_Summary.log" } else { "" }
if ($ErrorSummaryFile -and $ExtractedErrors.Count -gt 0 -and -not (Test-Path $ErrorSummaryFile)) {
    $ExtractedErrors | Out-File -FilePath $ErrorSummaryFile -Encoding utf8
}

$ErrorSnippet = ($ExtractedErrors -join "`n")
if ([string]::IsNullOrWhiteSpace($ErrorSnippet) -and $UATLogFile -and (Test-Path $UATLogFile)) {
    $ErrorSnippet = (Get-Content $UATLogFile -Tail 25 -Encoding UTF8) -join "`n"
}
if ($ErrorSnippet.Length -gt 1600) {
    $ErrorSnippet = $ErrorSnippet.Substring($ErrorSnippet.Length - 1600)
}
$ErrorSnippet = $ErrorSnippet -replace '```', "'''"

$FailPayload = @{
    username = "BuildServerKit"
    embeds   = @(@{
        title       = "❌ [$ProjectName] 빌드/패키징 실패 ($ModeLabel)"
        description = "**핵심 에러 발췌**`n``````text`n$ErrorSnippet`n``````"
        color       = 15548997
        fields      = @(
            @{ name = "브랜치 / 버전"; value = "``$BranchName`` · ``$RefLabel``"; inline = $true }
            @{ name = "작성자";        value = "$CommitAuthor"; inline = $true }
            @{ name = "소요 시간";     value = "$Duration (ExitCode: $ExitCode)"; inline = $true }
            @{ name = "변경 내용";     value = "$ShortMsg"; inline = $false }
            @{ name = "전체 로그 경로"; value = "``$SharedLogPath``"; inline = $false }
        )
        timestamp   = (Get-Date).ToUniversalTime().ToString("o")
    })
} | ConvertTo-Json -Depth 6 -Compress

# 첨부 파일 결정 (Discord 일반 서버 10MB 제한 대비 8MB 초과 시 자동 zip 압축)
$AttachPath = ""
$AttachName = ""
$TempZip    = ""
$MaxBytes   = 8 * 1024 * 1024

if ($UATLogFile -and (Test-Path $UATLogFile)) {
    $SafeBranch = $BranchName -replace '[\\/:*?"<>|]', '_'
    $LogSize = (Get-Item $UATLogFile).Length
    if ($LogSize -le $MaxBytes) {
        $AttachPath = $UATLogFile
        $AttachName = "ErrorLog_${ProjectName}_${SafeBranch}_${CommitHash}.log"
    } else {
        $TempZip = Join-Path $env:TEMP "ErrorLog_${ProjectName}_${CommitHash}_$(Get-Date -Format 'HHmmss').zip"
        try {
            Compress-Archive -Path $UATLogFile -DestinationPath $TempZip -CompressionLevel Optimal -Force
            if ((Get-Item $TempZip).Length -le $MaxBytes) {
                $AttachPath = $TempZip
                $AttachName = "ErrorLog_${ProjectName}_${SafeBranch}_${CommitHash}.zip"
            } elseif ($ErrorSummaryFile -and (Test-Path $ErrorSummaryFile)) {
                $AttachPath = $ErrorSummaryFile
                $AttachName = "ErrorSummary_${ProjectName}_${CommitHash}.log"
            }
        } catch {
            if ($ErrorSummaryFile -and (Test-Path $ErrorSummaryFile)) {
                $AttachPath = $ErrorSummaryFile
                $AttachName = "ErrorSummary_${ProjectName}_${CommitHash}.log"
            }
        }
    }
}

try {
    Send-DiscordMultipart -Url $DiscordWebhookUrl -PayloadJson $FailPayload -AttachmentPath $AttachPath -AttachmentName $AttachName | Out-Null
} finally {
    if ($TempZip -and (Test-Path $TempZip)) {
        Remove-Item $TempZip -Force -ErrorAction SilentlyContinue
    }
}
