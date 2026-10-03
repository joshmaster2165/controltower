# ct-auth: signs this computer in, and prints short-lived tokens for Claude Code, Claude Desktop and Codex to
# use with Control Tower. Installed by your IT team; part of Control Tower Enterprise (Elastic License 2.0).
#
#   ct-auth login  --client claude-code    sign in (opens the browser)
#   ct-auth token  --client claude-code    print an access token (signs in first if needed and allowed)
#   ct-auth header --client claude-code    print {"Authorization": "Bearer ..."} for MCP clients
#   ct-auth status --client claude-code    who this computer is signed in as
#   ct-auth logout --client claude-code    sign out here (and end the sign-in where it was made)
#
# Two ways to sign in, set by IT in the config file:
#   - with Control Tower: you approve the sign-in in Control Tower's console;
#   - with your identity provider (idp_issuer= and idp_client_id=): you sign in to Okta, Entra ID... directly,
#     and Control Tower checks its tokens. No Control Tower account needed.
# Options: --url <Control Tower address> (or CT_URL, or url= in the config file), --no-browser.
# On Windows tokens are encrypted for you alone (DPAPI) under %LOCALAPPDATA%\ControlTower.
$ErrorActionPreference = 'Stop'
$CtAuthVersion = 2
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
if (@('claude-code', 'claude-desktop', 'codex', 'copilot', 'other') -notcontains $client) { Die '--client is claude-code, claude-desktop, codex, copilot or other' }

$onWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
# Settings: the environment first, then the config file IT installed (apps run helpers with a bare environment).
$conf = $null
$confs = @($env:CT_AUTH_CONF)
if ($onWindows) { $confs += (Join-Path $env:ProgramData 'ControlTower\ct-auth.conf') } else { $confs += '/etc/controltower/ct-auth.conf' }
foreach ($f in $confs) { if ($f -and (Test-Path -LiteralPath $f)) { $conf = $f; break } }
function Setting([string]$key) {
  if (-not $conf) { return '' }
  $line = Get-Content -LiteralPath $conf | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
  if ($line) { return ($line -replace "^\s*$key\s*=\s*", '').Trim() } else { return '' }
}
if (-not $url) { $url = Setting 'url' }
if (-not $url) { Die 'no Control Tower address: pass --url, set CT_URL, or ask IT to install the configuration' }
$url = $url.TrimEnd('/')
$hostName = ($url -replace '^[A-Za-z]+://', '') -replace '/.*$', ''
$idpIssuer = if ($env:CT_IDP_ISSUER) { $env:CT_IDP_ISSUER } else { Setting 'idp_issuer' }
$idpClientId = if ($env:CT_IDP_CLIENT_ID) { $env:CT_IDP_CLIENT_ID } else { Setting 'idp_client_id' }
$idpScope = if ($env:CT_IDP_SCOPE) { $env:CT_IDP_SCOPE } else { Setting 'idp_scope' }
$idpToken = if ($env:CT_IDP_TOKEN) { $env:CT_IDP_TOKEN } else { Setting 'idp_token' }
if (-not $idpScope) { $idpScope = 'openid email profile offline_access' }
if (-not $idpToken) { $idpToken = 'id_token' }
$idp = [bool]$idpIssuer
if ($idp) {
  if (-not $idpClientId) { Die "idp_issuer is set but idp_client_id isn't: ask IT to fix the configuration" }
  $idpIssuer = $idpIssuer.TrimEnd('/')
}
$names = @{ 'claude-code' = 'Claude Code'; 'claude-desktop' = 'Claude Desktop'; 'codex' = 'Codex'; 'copilot' = 'GitHub Copilot CLI'; 'other' = 'this computer' }
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

# ---- talking to Control Tower, or the identity provider ----
function Post([string]$to, [hashtable]$form) {
  $headers = @{ 'accept' = 'application/json'; 'user-agent' = "ct-auth/$CtAuthVersion" }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $to -Body $form -Headers $headers -TimeoutSec 20
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
function JwtClaims([string]$t) {
  $parts = $t.Split('.')
  if ($parts.Count -lt 2) { return $null }
  $p = $parts[1].Replace('-', '+').Replace('_', '/')
  switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } }
  try { return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json) } catch { return $null }
}

if ($idp) {
  $where = "your identity provider ($idpIssuer)"
  $oauthClient = $idpClientId
} else {
  $where = "Control Tower ($url)"
  $oauthClient = 'ct-auth'
}
# Where to sign in: Control Tower's endpoints, or the identity provider's (from its discovery document).
function Endpoints {
  if (-not $idp) { return @{ device = "$url/device/code"; token = "$url/device/token"; revoke = "$url/device/revoke" } }
  try { $d = (Invoke-WebRequest -UseBasicParsing -Uri "$idpIssuer/.well-known/openid-configuration" -Headers @{ 'accept' = 'application/json' } -TimeoutSec 20).Content | ConvertFrom-Json }
  catch { Die "$where can't be reached, or has no OpenID configuration ($($_.Exception.Message))" }
  return @{ device = $d.device_authorization_endpoint; token = $d.token_endpoint; revoke = $d.revocation_endpoint }
}

function SaveTokens($b) {
  $at = if ($idp) { $b.$idpToken } else { $b.access_token }
  if (-not $at) { return $false }
  $life = if ($b.expires_in) { [int]$b.expires_in } else { 300 }
  $exp = (Now) + $life
  $claims = $null
  if ($idp) { $claims = JwtClaims $at }
  if ($claims -and $claims.exp -and [int]$claims.exp -lt $exp) { $exp = [int]$claims.exp }
  StoreSet 'access' "$at.$exp"
  if ($b.refresh_token) { StoreSet 'refresh' $b.refresh_token }
  if ($idp) {
    $who = if ($claims.email) { $claims.email } elseif ($claims.preferred_username) { $claims.preferred_username } else { $claims.sub }
    if ($who) { StoreSet 'info' "$who|" }
  } elseif ($b.person) { StoreSet 'info' "$($b.person)|$($b.key_name)" }
  return $true
}

function InteractiveOk {
  if ($env:CT_AUTH_NONINTERACTIVE -eq '1') { return $false }
  $c = $env:CLAUDE_HELPER_CONTEXT
  return (-not $c) -or $c -eq 'interactive' -or $c -eq 'setup-test'
}

function Login {
  $ep = Endpoints
  if ($idp) {
    if (-not $ep.device) { Die "$where doesn't offer device sign-in: turn on the device authorization grant for app $idpClientId" }
    $r = Post $ep.device @{ client_id = $idpClientId; scope = $idpScope }
  } else {
    $r = Post $ep.device @{ client = $client; device_name = [Environment]::MachineName }
  }
  if ($r.status -ne 200) { Die "$where refused to start a sign-in: $($r.body.error_description) $($r.body.error) [$($r.status)]" }
  $b = $r.body
  $vu = if ($b.verification_uri_complete) { $b.verification_uri_complete } elseif ($b.verification_uri) { $b.verification_uri } else { $b.verification_url }
  $interval = if ($b.interval) { [int]$b.interval } else { 5 }
  $life = if ($b.expires_in) { [int]$b.expires_in } else { 600 }
  if ($env:CT_AUTH_WAIT -and [int]$env:CT_AUTH_WAIT -lt $life) { $life = [int]$env:CT_AUTH_WAIT }
  Say ''
  if ($idp) { Say "Sign in with your work account for ${name}:" } else { Say "Sign in to Control Tower for ${name}:" }
  Say "  open  $vu"
  Say "  and enter or check the code  $($b.user_code)"
  Say ''
  if ($env:CT_AUTH_OPEN) { Start-Process -FilePath $env:CT_AUTH_OPEN -ArgumentList $vu | Out-Null }
  elseif ($browser -and $onWindows) { try { Start-Process $vu | Out-Null } catch { } }
  elseif ($browser) { try { Start-Process 'xdg-open' -ArgumentList $vu | Out-Null } catch { } }
  $until = (Now) + $life
  while ((Now) -lt $until) {
    Start-Sleep -Seconds $interval
    $t = Post $ep.token @{ grant_type = 'urn:ietf:params:oauth:grant-type:device_code'; device_code = $b.device_code; client_id = $oauthClient }
    if ($t.status -eq 200) {
      if (-not (SaveTokens $t.body)) { Die "$where's answer had no token" }
      $info = StoreGet 'info'
      if ($idp) { Say "Signed in as $($info.Split('|')[0]). $name now uses Control Tower ($url)." }
      else { Say "Signed in as $($t.body.person). Calls from $name are made as the key $($t.body.key_name)." }
      return
    }
    $e = if ($t.body) { $t.body.error } else { '' }
    if ($e -eq 'authorization_pending') { continue }
    if ($e -eq 'slow_down') { $interval += 5; continue }
    if (-not $e) { if ($t.status -ne 0) { Die "$where answered $($t.status)" } else { continue } }
    Die "$($t.body.error_description) ($e)"
  }
  Die "the sign-in wasn't completed in time; run ct-auth login --client $client to try again"
}

function Token {
  $cached = StoreGet 'access'
  if ($cached) {
    $exp = [int]$cached.Substring($cached.LastIndexOf('.') + 1); $at = $cached.Substring(0, $cached.LastIndexOf('.'))
    if ($exp - (Now) -gt 300) { return $at }
  }
  $rt = StoreGet 'refresh'
  if ($rt) {
    $ep = Endpoints
    $form = @{ grant_type = 'refresh_token'; refresh_token = $rt; client_id = $oauthClient }
    if ($idp) { $form.scope = $idpScope }
    $r = Post $ep.token $form
    if ($r.status -eq 200 -and (SaveTokens $r.body)) { $c = StoreGet 'access'; return $c.Substring(0, $c.LastIndexOf('.')) }
    $e = if ($r.body) { $r.body.error } else { '' }
    if ($e -eq 'invalid_grant') { Say "ct-auth: $($r.body.error_description)"; StoreDel 'refresh'; StoreDel 'access' }
    elseif ($e -eq 'access_denied' -or $e -eq 'unavailable') { Die $r.body.error_description }
    else {
      if ($cached -and [int]$cached.Substring($cached.LastIndexOf('.') + 1) -gt (Now)) { return $cached.Substring(0, $cached.LastIndexOf('.')) }
      Die "$where can't be reached [$($r.status)]"
    }
  }
  if (-not (InteractiveOk)) { Die "not signed in for ${name}: run  ct-auth login --client $client" }
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
    if (-not (StoreGet 'refresh') -and -not (StoreGet 'access')) { Say "Not signed in to $url for $name."; exit 1 }
    $info = StoreGet 'info'
    $who = $info.Split('|')[0]; $key = $info.Substring($info.IndexOf('|') + 1)
    if ($idp) { Say "Signed in with $idpIssuer as $who. Calls from $name go through Control Tower ($url)." }
    else { Say "Signed in to $url as $who. Calls from $name are made as the key $key." }
  }
  'logout' {
    $rt = StoreGet 'refresh'
    if ($rt) {
      $ep = Endpoints
      if ($idp) { if ($ep.revoke) { Post $ep.revoke @{ token = $rt; token_type_hint = 'refresh_token'; client_id = $idpClientId } | Out-Null } }
      else { Post $ep.revoke @{ token = $rt } | Out-Null }
    }
    StoreDel 'refresh'; StoreDel 'access'; StoreDel 'info'
    Say "Signed out for $name."
  }
}
