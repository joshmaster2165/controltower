# ct-auth: signs this computer in to Control Tower, and prints short-lived tokens for Claude Code, Claude Desktop
# and Codex. Installed by your IT team; part of Control Tower Enterprise (Elastic License 2.0).
#
#   ct-auth login  --client claude-code    sign in (opens the browser; approve it in Control Tower)
#   ct-auth token  --client claude-code    print an access token (signs in first if needed and allowed)
#   ct-auth header --client claude-code    print {"Authorization": "Bearer ..."} for MCP clients
#   ct-auth status --client claude-code    who this computer is signed in as
#   ct-auth logout --client claude-code    sign out here, and end the sign-in in Control Tower
#
# Options: --url <Control Tower address> (or CT_URL, or url= in the config file), --no-browser.
# On Windows the refresh token is encrypted for you alone (DPAPI) under %LOCALAPPDATA%\ControlTower.
$ErrorActionPreference = 'Stop'
$CtAuthVersion = 1
$ProgressPreference = 'SilentlyContinue'

function Say([string]$m) { [Console]::Error.WriteLine($m) }
function Die([string]$m) { Say "ct-auth: $m"; exit 1 }

$cmd = ''; $client = 'other'; $url = $env:CT_URL; $browser = $true
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  switch -Regex ($a) {
    '^(login|token|header|status|logout|version)$' { $cmd = $a; continue }
    '^--client$' { $i++; $client = [string]$args[$i]; continue }
    '^--client=' { $client = $a.Substring(9); continue }
    '^--url$' { $i++; $url = [string]$args[$i]; continue }
    '^--url=' { $url = $a.Substring(6); continue }
    '^--no-browser$' { $browser = $false; continue }
    default { Die "unknown argument: $a" }
  }
}
if (-not $cmd) { $cmd = 'token' }
if ($cmd -eq 'version') { "ct-auth $CtAuthVersion"; exit 0 }
if (@('claude-code', 'claude-desktop', 'codex', 'other') -notcontains $client) { Die '--client is claude-code, claude-desktop, codex or other' }

$onWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
if (-not $url) {
  $confs = @($env:CT_AUTH_CONF)
  if ($onWindows) { $confs += (Join-Path $env:ProgramData 'ControlTower\ct-auth.conf') } else { $confs += '/etc/controltower/ct-auth.conf' }
  foreach ($f in $confs) {
    if ($f -and (Test-Path -LiteralPath $f)) {
      $line = Get-Content -LiteralPath $f | Where-Object { $_ -match '^\s*url\s*=' } | Select-Object -First 1
      if ($line) { $url = ($line -replace '^\s*url\s*=\s*', '').Trim(); break }
    }
  }
}
if (-not $url) { Die 'no Control Tower address: pass --url, set CT_URL, or ask IT to install the configuration' }
$url = $url.TrimEnd('/')
$hostName = ($url -replace '^[A-Za-z]+://', '') -replace '/.*$', ''
$names = @{ 'claude-code' = 'Claude Code'; 'claude-desktop' = 'Claude Desktop'; 'codex' = 'Codex'; 'other' = 'this computer' }
$name = $names[$client]

# ---- where tokens are kept ----
if ($env:CT_AUTH_DIR) { $dir = $env:CT_AUTH_DIR }
elseif ($onWindows) { $dir = Join-Path $env:LOCALAPPDATA 'ControlTower' }
else { $dir = Join-Path $HOME '.config/controltower' }
$file = ("$hostName-$client" -replace '[^A-Za-z0-9._-]', '_')
function StorePath([string]$n) { Join-Path $dir "$file.$n" }
function StoreGet([string]$n) {
  $p = StorePath $n
  if (-not (Test-Path -LiteralPath $p)) { return '' }
  $raw = (Get-Content -LiteralPath $p -Raw).Trim()
  if ($onWindows -and $env:CT_AUTH_STORE -ne 'file') {
    Add-Type -AssemblyName System.Security
    try { return [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($raw), $null, 'CurrentUser')) } catch { return '' }
  }
  return $raw
}
function StoreSet([string]$n, [string]$v) {
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $p = StorePath $n
  if ($onWindows -and $env:CT_AUTH_STORE -ne 'file') {
    Add-Type -AssemblyName System.Security
    $v = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v), $null, 'CurrentUser'))
  }
  Set-Content -LiteralPath $p -Value $v -NoNewline -Encoding ASCII
  if (-not $onWindows) { & chmod 600 $p }
}
function StoreDel([string]$n) { Remove-Item -LiteralPath (StorePath $n) -Force -ErrorAction SilentlyContinue }

# ---- talking to Control Tower ----
function Post([string]$path, [hashtable]$form) {
  $headers = @{ 'accept' = 'application/json'; 'user-agent' = "ct-auth/$CtAuthVersion" }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$url$path" -Body $form -Headers $headers -TimeoutSec 20
    return @{ status = [int]$r.StatusCode; body = ($r.Content | ConvertFrom-Json) }
  } catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    $body = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { try { $body = $_.ErrorDetails.Message | ConvertFrom-Json } catch { } }
    return @{ status = $status; body = $body }
  }
}
function Now { [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

function SaveTokens($b) {
  if (-not $b.access_token) { return $false }
  StoreSet 'access' ("$($b.access_token)." + ((Now) + [int]$b.expires_in))
  if ($b.refresh_token) { StoreSet 'refresh' $b.refresh_token }
  if ($b.person) { StoreSet 'info' "$($b.person)|$($b.key_name)" }
  return $true
}

function InteractiveOk {
  if ($env:CT_AUTH_NONINTERACTIVE -eq '1') { return $false }
  $c = $env:CLAUDE_HELPER_CONTEXT
  return (-not $c) -or $c -eq 'interactive' -or $c -eq 'setup-test'
}

function Login {
  $r = Post '/device/code' @{ client = $client; device_name = [Environment]::MachineName }
  if ($r.status -ne 200) { Die "Control Tower ($url) refused to start a sign-in: $($r.body.error_description) [$($r.status)]" }
  $b = $r.body
  $vu = if ($b.verification_uri_complete) { $b.verification_uri_complete } else { $b.verification_uri }
  $interval = if ($b.interval) { [int]$b.interval } else { 5 }
  $life = if ($b.expires_in) { [int]$b.expires_in } else { 600 }
  if ($env:CT_AUTH_WAIT -and [int]$env:CT_AUTH_WAIT -lt $life) { $life = [int]$env:CT_AUTH_WAIT }
  Say ''
  Say "Sign in to Control Tower for ${name}:"
  Say "  open  $vu"
  Say "  and check the code  $($b.user_code)"
  Say ''
  if ($env:CT_AUTH_OPEN) { Start-Process -FilePath $env:CT_AUTH_OPEN -ArgumentList $vu | Out-Null }
  elseif ($browser -and $onWindows) { try { Start-Process $vu | Out-Null } catch { } }
  elseif ($browser) { try { Start-Process 'xdg-open' -ArgumentList $vu | Out-Null } catch { } }
  $until = (Now) + $life
  while ((Now) -lt $until) {
    Start-Sleep -Seconds $interval
    $t = Post '/device/token' @{ grant_type = 'urn:ietf:params:oauth:grant-type:device_code'; device_code = $b.device_code; client_id = 'ct-auth' }
    if ($t.status -eq 200) {
      if (-not (SaveTokens $t.body)) { Die "Control Tower's answer had no token" }
      Say "Signed in as $($t.body.person). Calls from $name are made as the key $($t.body.key_name)."
      return
    }
    $e = if ($t.body) { $t.body.error } else { '' }
    if ($e -eq 'authorization_pending') { continue }
    if ($e -eq 'slow_down') { $interval += 5; continue }
    if (-not $e) { if ($t.status -ne 0) { Die "Control Tower answered $($t.status)" } else { continue } }
    Die $t.body.error_description
  }
  Die "the sign-in wasn't approved in time; run ct-auth login --client $client to try again"
}

function Token {
  $cached = StoreGet 'access'
  if ($cached) {
    $exp = [int]$cached.Substring($cached.LastIndexOf('.') + 1); $at = $cached.Substring(0, $cached.LastIndexOf('.'))
    if ($exp - (Now) -gt 300) { return $at }
  }
  $rt = StoreGet 'refresh'
  if ($rt) {
    $r = Post '/device/token' @{ grant_type = 'refresh_token'; refresh_token = $rt; client_id = 'ct-auth' }
    if ($r.status -eq 200 -and (SaveTokens $r.body)) { return $r.body.access_token }
    $e = if ($r.body) { $r.body.error } else { '' }
    if ($e -eq 'invalid_grant') { Say "ct-auth: $($r.body.error_description)"; StoreDel 'refresh'; StoreDel 'access' }
    elseif ($e -eq 'access_denied' -or $e -eq 'unavailable') { Die $r.body.error_description }
    else {
      if ($cached -and [int]$cached.Substring($cached.LastIndexOf('.') + 1) -gt (Now)) { return $cached.Substring(0, $cached.LastIndexOf('.')) }
      Die "Control Tower ($url) can't be reached [$($r.status)]"
    }
  }
  if (-not (InteractiveOk)) { Die "not signed in to Control Tower for ${name}: run  ct-auth login --client $client" }
  Login
  $cached = StoreGet 'access'
  return $cached.Substring(0, $cached.LastIndexOf('.'))
}

switch ($cmd) {
  'login' { Login }
  'token' { Token }
  'header' {
    if (-not $env:CT_AUTH_NONINTERACTIVE) { $env:CT_AUTH_NONINTERACTIVE = '1' }
    $t = Token
    '{"Authorization": "Bearer ' + $t + '"}'
  }
  'status' {
    if (-not (StoreGet 'refresh')) { Say "Not signed in to $url for $name."; exit 1 }
    $info = StoreGet 'info'
    $who = $info.Split('|')[0]; $key = $info.Substring($info.IndexOf('|') + 1)
    Say "Signed in to $url as $who. Calls from $name are made as the key $key."
  }
  'logout' {
    $rt = StoreGet 'refresh'
    if ($rt) { Post '/device/revoke' @{ token = $rt } | Out-Null }
    StoreDel 'refresh'; StoreDel 'access'; StoreDel 'info'
    Say "Signed out of $url for $name."
  }
}
