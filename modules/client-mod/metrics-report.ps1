# metrics-report.ps1 - Reporter latency Tailscale -> Dashboard HTTPS (Feature L).
#
# Moi $Interval giay:
#   - doc MAC card chinh
#   - `tailscale ping` TAT CA peer -> RTT + path (direct/DERP)
#   - POST ket qua den $DashboardUrl/api/metrics/report voi X-Metrics-Secret header
#
# Cau hinh: tao file 'metrics-config.ps1' canh script de override (dot-sourced):
#   $DashboardUrl    = 'https://dashboard.hangocthanh.io.vn'
#   $MetricsSecret   = 'your-shared-secret'
#   $Interval        = 60
#   $PingTimeout     = '3s'
#   $LogFile         = ''        # de trong = khong ghi file log
#
# Chay thu:    powershell -File metrics-report.ps1 -SelfTest
# Chay thuong: powershell -File metrics-report.ps1
#              (start-tailscale.bat goi tu dong)
param([switch]$SelfTest)

$ProgressPreference = 'SilentlyContinue'

$base = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- Cau hinh mac dinh -------------------------------------------------------
$DashboardUrl  = 'https://dashboard.hangocthanh.io.vn'
$MetricsSecret = ''
$Interval      = 60
$PingCount     = 2
$PingTimeout   = '3s'
$LogFile       = ''   # vi du: Join-Path $base 'logs\metrics.log'
# ------------------------------------------------------------------------------

$cfgFile = Join-Path $base 'metrics-config.ps1'
if (Test-Path $cfgFile) { . $cfgFile }

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') $msg"
    Write-Host $line
    if ($LogFile) {
        try {
            $dir = Split-Path $LogFile
            if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
        } catch {}
    }
}

function Parse-Ping([string]$out) {
    $line = ($out -split "`n" | Where-Object { $_ -match 'pong from' } | Select-Object -Last 1)
    if (-not $line) { return @{ ok = $false; rtt = $null; path = '' } }
    $rtt = $null
    if ($line -match 'in\s+([\d.]+)ms') { $rtt = [double]$Matches[1] }
    $path = 'direct'
    if ($line -match 'via\s+DERP\(([^)]+)\)') { $path = 'derp:' + $Matches[1] }
    return @{ ok = $true; rtt = $rtt; path = $path }
}

function Get-PrimaryMac {
    try {
        $idx = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
            Sort-Object RouteMetric | Select-Object -First 1).InterfaceIndex
        $a = Get-NetAdapter -InterfaceIndex $idx -ErrorAction Stop
        if ($a -and $a.MacAddress) { return $a.MacAddress }
    } catch {}
    $a = Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
        Where-Object { $_.Status -eq 'Up' -and $_.MacAddress } |
        Sort-Object ifIndex | Select-Object -First 1
    if ($a) { return $a.MacAddress }
    return ''
}

if ($SelfTest) {
    $a = Parse-Ping "pong from votam (100.64.0.3) via 1.2.3.4:41641 in 12ms"
    $b = Parse-Ping "pong from votam (100.64.0.3) via DERP(myderp) in 45.5ms"
    $c = Parse-Ping "no pong; timed out"
    if (-not $a.ok -or $a.path -ne 'direct' -or [double]$a.rtt -ne 12)        { throw "SELFTEST direct FAIL" }
    if (-not $b.ok -or $b.path -ne 'derp:myderp' -or [double]$b.rtt -ne 45.5) { throw "SELFTEST derp FAIL" }
    if ($c.ok) { throw "SELFTEST timeout FAIL" }
    Write-Host "SELFTEST OK"
    exit 0
}

# Chi chay 1 ban (mutex)
$mutex = New-Object System.Threading.Mutex($false, 'Global\TailscaleMetricsReporter')
if (-not $mutex.WaitOne(0)) { exit 0 }

# tailscale.exe: uu tien canh script (ban portable), neu khong thi PATH
$ts = Join-Path $base 'tailscale.exe'
if (-not (Test-Path $ts)) { $ts = 'tailscale.exe' }

function Send-Report([string]$body) {
    $url  = "$DashboardUrl/api/metrics/report"
    $tmp  = Join-Path $env:TEMP ("tsmetrics_{0}.json" -f $PID)
    [System.IO.File]::WriteAllText($tmp, $body, (New-Object System.Text.UTF8Encoding($false)))
    try {
        $curlArgs = @('-s', '-m', '20', '-X', 'POST', $url,
            '-H', 'Content-Type: application/json')
        if ($MetricsSecret) { $curlArgs += @('-H', "X-Metrics-Secret: $MetricsSecret") }
        $curlArgs += @('--data-binary', "@$tmp")

        # Thu lan 1
        $out = & curl.exe @curlArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
            # Retry 1 lan sau 5 giay
            Start-Sleep -Seconds 5
            $out = & curl.exe @curlArgs 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Log "WARN: POST that bai sau 2 lan thu. curl exit=$LASTEXITCODE"
            }
        }
    } catch {
        Write-Log "ERR: Send-Report ngoai le: $_"
    } finally {
        Remove-Item $tmp -ErrorAction SilentlyContinue
    }
}

Write-Log "metrics-report start. URL=$DashboardUrl interval=${Interval}s"

while ($true) {
    try {
        $st = (& $ts status --json 2>$null | Out-String | ConvertFrom-Json)
        if ($st -and $st.Self -and $st.Peer) {
            $selfHost = $st.Self.HostName
            $selfIp   = ($st.Self.TailscaleIPs | Where-Object { $_ -notmatch ':' } | Select-Object -First 1)
            $mac      = Get-PrimaryMac
            $samples  = @()
            foreach ($p in $st.Peer.PSObject.Properties.Value) {
                $dstIp = ($p.TailscaleIPs | Where-Object { $_ -notmatch ':' } | Select-Object -First 1)
                if (-not $dstIp) { continue }
                $pingOut   = (& $ts ping -c $PingCount --timeout $PingTimeout $dstIp 2>$null) | Out-String
                $r         = Parse-Ping $pingOut
                $pongCount = ([regex]::Matches($pingOut, 'pong from')).Count
                $lossPct   = if ($PingCount -gt 0) { [int][Math]::Round((1.0 - [double]$pongCount / $PingCount) * 100) } else { $null }
                $samples += [pscustomobject]@{
                    dst      = $p.HostName
                    dst_ip   = $dstIp
                    rtt_ms   = $r.rtt
                    path     = $r.path
                    ok       = $r.ok
                    loss_pct = $lossPct
                }
            }
            if ($samples.Count -gt 0) {
                $body = @{
                    hostname = $selfHost
                    ipv4     = $selfIp
                    mac      = $mac
                    samples  = @($samples)
                } | ConvertTo-Json -Depth 6
                Send-Report $body
                $ok = ($samples | Where-Object { $_.ok }).Count
                Write-Log "report: $ok/$($samples.Count) peer OK (host=$selfHost)"
            }
        }
    } catch {
        Write-Log "ERR vong lap chinh: $_"
    }
    Start-Sleep -Seconds $Interval
}
