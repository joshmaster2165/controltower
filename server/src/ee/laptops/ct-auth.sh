#!/bin/sh
# ct-auth: signs this computer in, and prints short-lived tokens for Claude Code, Claude Desktop and Codex to
# use with Control Tower. Installed by your IT team; part of Control Tower Enterprise (Elastic License 2.0).
#
#   ct-auth login  --client claude-code    sign in (opens the browser)
#   ct-auth token  --client claude-code    print an access token (signs in first if needed and allowed)
#   ct-auth header --client claude-code    print {"Authorization": "Bearer …"} for MCP clients
#   ct-auth status --client claude-code    who this computer is signed in as
#   ct-auth logout --client claude-code    sign out here (and end the sign-in where it was made)
#
# Two ways to sign in, set by IT in the config file:
#   - with Control Tower: you approve the sign-in in Control Tower's console;
#   - with your identity provider (idp_issuer= and idp_client_id=): you sign in to Okta, Entra ID… directly,
#     and Control Tower checks its tokens. No Control Tower account needed.
# Options: --url <Control Tower address> (or CT_URL, or url= in the config file), --no-browser.
# Tokens are kept in the macOS keychain, or (elsewhere) in a file only you can read.
set -u
CT_AUTH_VERSION=2

say() { printf '%s\n' "$*" >&2; }
die() { say "ct-auth: $*"; exit 1; }

cmd=""
client="other"
url="${CT_URL:-}"
browser=1
while [ $# -gt 0 ]; do
  case "$1" in
    login|token|header|status|logout|version) cmd="$1" ;;
    --client) [ $# -ge 2 ] || die "--client needs a value"; client="$2"; shift ;;
    --client=*) client="${1#--client=}" ;;
    --url) [ $# -ge 2 ] || die "--url needs a value"; url="$2"; shift ;;
    --url=*) url="${1#--url=}" ;;
    --no-browser) browser=0 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done
[ -n "$cmd" ] || cmd="token"
[ "$cmd" = "version" ] && { printf 'ct-auth %s\n' "$CT_AUTH_VERSION"; exit 0; }
case "$client" in claude-code|claude-desktop|codex|other) ;; *) die "--client is claude-code, claude-desktop, codex or other" ;; esac

# Settings: the environment first, then the config file your IT team installed (apps run helpers with a bare
# environment, so a rollout relies on the file).
conf=""
for f in "${CT_AUTH_CONF:-}" "/Library/Application Support/ControlTower/ct-auth.conf" /etc/controltower/ct-auth.conf; do
  [ -n "$f" ] && [ -r "$f" ] && { conf="$f"; break; }
done
setting() { # name
  [ -n "$conf" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$conf" | head -n 1 | tr -d '\r'
}
[ -n "$url" ] || url=$(setting url)
[ -n "$url" ] || die "no Control Tower address: pass --url, set CT_URL, or ask IT to install the configuration"
url=$(printf '%s' "$url" | sed 's#/*$##')
host=$(printf '%s' "$url" | sed 's#^[A-Za-z]*://##; s#/.*##')
idp_issuer="${CT_IDP_ISSUER:-$(setting idp_issuer)}"
idp_client_id="${CT_IDP_CLIENT_ID:-$(setting idp_client_id)}"
idp_scope="${CT_IDP_SCOPE:-$(setting idp_scope)}"
idp_token="${CT_IDP_TOKEN:-$(setting idp_token)}"
[ -n "$idp_scope" ] || idp_scope="openid email profile offline_access"
[ -n "$idp_token" ] || idp_token="id_token"
mode="controltower"
if [ -n "$idp_issuer" ]; then
  mode="idp"
  [ -n "$idp_client_id" ] || die "idp_issuer is set but idp_client_id isn't: ask IT to fix the configuration"
  idp_issuer=$(printf '%s' "$idp_issuer" | sed 's#/*$##')
fi

# ---- where tokens are kept ----
service="Control Tower ($host)"
store="file"
if [ "${CT_AUTH_STORE:-}" != "file" ] && [ "$(uname -s)" = "Darwin" ] && command -v security >/dev/null 2>&1; then store="keychain"; fi
dir="${CT_AUTH_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/controltower}"
fname=$(printf '%s-%s' "$host" "$client" | tr -c 'A-Za-z0-9._-' '_')

store_get() { # name
  if [ "$store" = "keychain" ]; then
    security find-generic-password -s "$service" -a "$client.$1" -w 2>/dev/null || true
  else
    [ -r "$dir/$fname.$1" ] && cat "$dir/$fname.$1" || true
  fi
}
store_set() { # name value (values never contain double quotes, so the keychain command line stays simple)
  if [ "$store" = "keychain" ]; then
    # Through security's own prompt, so the value isn't on a command line other processes can see.
    printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$service" "$client.$1" "$2" | security -i >/dev/null 2>&1 || die "could not save to the keychain"
  else
    (umask 077 && mkdir -p "$dir" && printf '%s' "$2" >"$dir/$fname.$1") || die "could not write $dir"
  fi
}
store_del() { # name
  if [ "$store" = "keychain" ]; then
    security delete-generic-password -s "$service" -a "$client.$1" >/dev/null 2>&1 || true
  else
    rm -f "$dir/$fname.$1"
  fi
}

# ---- talking to Control Tower, or the identity provider ----
command -v curl >/dev/null 2>&1 || die "curl is needed"
# Values from JSON answers (flat string and number values; escaped slashes undone).
jstr() { printf '%s' "$1" | sed 's#\\/#/#g' | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }
jnum() { printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" | head -n 1; }
post() { # url, then name=value pairs; prints the body, then the status on the last line
  to="$1"; shift
  n=$#
  while [ "$n" -gt 0 ]; do set -- "$@" --data-urlencode "$1"; shift; n=$((n - 1)); done
  curl -sS --max-time 20 -X POST -H 'accept: application/json' -H "user-agent: ct-auth/$CT_AUTH_VERSION" "$@" -w '\n%{http_code}' "$to" 2>/dev/null || printf '\n000'
}
now() { date +%s; }
# A JWT's claims (its middle part), for its end time and who it names.
jwt_claims() {
  p=$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')
  case $(( ${#p} % 4 )) in 2) p="$p==" ;; 3) p="$p=" ;; esac
  printf '%s' "$p" | base64 -d 2>/dev/null || printf '%s' "$p" | base64 -D 2>/dev/null || true
}

name_of() {
  case "$client" in claude-code) echo "Claude Code" ;; claude-desktop) echo "Claude Desktop" ;; codex) echo "Codex" ;; *) echo "this computer" ;; esac
}

# Where to sign in: Control Tower's endpoints, or the identity provider's (from its discovery document).
if [ "$mode" = "idp" ]; then
  where="your identity provider ($idp_issuer)"
  oauth_client="$idp_client_id"
  endpoints() {
    disc=$(curl -sS --max-time 20 -H 'accept: application/json' "$idp_issuer/.well-known/openid-configuration" 2>/dev/null || true)
    device_ep=$(jstr "$disc" device_authorization_endpoint)
    token_ep=$(jstr "$disc" token_endpoint)
    revoke_ep=$(jstr "$disc" revocation_endpoint)
    [ -n "$token_ep" ] || die "$where can't be reached, or has no OpenID configuration"
  }
else
  where="Control Tower ($url)"
  oauth_client="ct-auth"
  endpoints() { device_ep="$url/device/code"; token_ep="$url/device/token"; revoke_ep="$url/device/revoke"; }
fi

save_tokens() { # body
  if [ "$mode" = "idp" ]; then at=$(jstr "$1" "$idp_token"); else at=$(jstr "$1" access_token); fi
  [ -n "$at" ] || return 1
  life=$(jnum "$1" expires_in); [ -n "$life" ] || life=300
  exp=$(( $(now) + life ))
  claims=""; [ "$mode" = "idp" ] && claims=$(jwt_claims "$at")
  jexp=$(jnum "$claims" exp)
  [ -n "$jexp" ] && [ "$jexp" -lt "$exp" ] && exp="$jexp"
  store_set access "$at.$exp"
  rt=$(jstr "$1" refresh_token)
  [ -n "$rt" ] && store_set refresh "$rt"
  if [ "$mode" = "idp" ]; then
    who=$(jstr "$claims" email); [ -n "$who" ] || who=$(jstr "$claims" preferred_username); [ -n "$who" ] || who=$(jstr "$claims" sub)
    [ -n "$who" ] && store_set info "$who|"
  else
    who=$(jstr "$1" person); key=$(jstr "$1" key_name)
    [ -n "$who" ] && store_set info "$who|$key"
  fi
  return 0
}

# May this run open a browser and wait? Not when an app says nobody is there (Claude Desktop's helper contexts).
interactive_ok() {
  [ "${CT_AUTH_NONINTERACTIVE:-}" = "1" ] && return 1
  case "${CLAUDE_HELPER_CONTEXT:-interactive}" in interactive|setup-test) return 0 ;; *) return 1 ;; esac
}

login() {
  endpoints
  if [ "$mode" = "idp" ]; then
    [ -n "$device_ep" ] || die "$where doesn't offer device sign-in: turn on the device authorization grant for app $idp_client_id"
    r=$(post "$device_ep" "client_id=$idp_client_id" "scope=$idp_scope")
  else
    r=$(post "$device_ep" "client=$client" "device_name=$(hostname 2>/dev/null || echo computer)")
  fi
  code=$(printf '%s' "$r" | tail -n 1); body=$(printf '%s' "$r" | sed '$d')
  [ "$code" = "200" ] || die "$where refused to start a sign-in: $(jstr "$body" error_description)$(jstr "$body" error)${code:+ [$code]}"
  dc=$(jstr "$body" device_code); uc=$(jstr "$body" user_code)
  vu=$(jstr "$body" verification_uri_complete); [ -n "$vu" ] || vu=$(jstr "$body" verification_uri); [ -n "$vu" ] || vu=$(jstr "$body" verification_url)
  interval=$(jnum "$body" interval); [ -n "$interval" ] || interval=5
  life=$(jnum "$body" expires_in); [ -n "$life" ] || life=600
  [ -n "${CT_AUTH_WAIT:-}" ] && [ "$CT_AUTH_WAIT" -lt "$life" ] && life="$CT_AUTH_WAIT"
  say ""
  if [ "$mode" = "idp" ]; then say "Sign in with your work account for $(name_of):"; else say "Sign in to Control Tower for $(name_of):"; fi
  say "  open  $vu"
  say "  and enter or check the code  $uc"
  say ""
  if [ -n "${CT_AUTH_OPEN:-}" ]; then "$CT_AUTH_OPEN" "$vu" >/dev/null 2>&1 &
  elif [ "$browser" = "1" ]; then
    if [ "$(uname -s)" = "Darwin" ]; then open "$vu" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$vu" >/dev/null 2>&1 &
    fi
  fi
  until=$(( $(now) + life ))
  while [ "$(now)" -lt "$until" ]; do
    sleep "$interval"
    r=$(post "$token_ep" "grant_type=urn:ietf:params:oauth:grant-type:device_code" "device_code=$dc" "client_id=$oauth_client")
    code=$(printf '%s' "$r" | tail -n 1); body=$(printf '%s' "$r" | sed '$d')
    if [ "$code" = "200" ]; then
      save_tokens "$body" || die "$where's answer had no $( [ "$mode" = idp ] && echo "$idp_token" || echo token)"
      info=$(store_get info)
      if [ "$mode" = "idp" ]; then say "Signed in as ${info%%|*}. $(name_of) now uses Control Tower ($url)."
      else say "Signed in as $(jstr "$body" person). Calls from $(name_of) are made as the key $(jstr "$body" key_name)."; fi
      return 0
    fi
    case "$(jstr "$body" error)" in
      authorization_pending) ;;
      slow_down) interval=$(( interval + 5 )) ;;
      "") [ "$code" = "000" ] || die "$where answered $code" ;;
      *) die "$(jstr "$body" error_description) ($(jstr "$body" error))" ;;
    esac
  done
  die "the sign-in wasn't completed in time; run ct-auth login --client $client to try again"
}

# A current access token: the cached one, else a refreshed one, else (if allowed) a new sign-in.
token() {
  cached=$(store_get access)
  if [ -n "$cached" ]; then
    exp=${cached##*.}; at=${cached%.*}
    [ $(( exp - $(now) )) -gt 300 ] && { printf '%s\n' "$at"; return 0; }
  fi
  rt=$(store_get refresh)
  if [ -n "$rt" ]; then
    endpoints
    if [ "$mode" = "idp" ]; then r=$(post "$token_ep" "grant_type=refresh_token" "refresh_token=$rt" "client_id=$idp_client_id" "scope=$idp_scope")
    else r=$(post "$token_ep" "grant_type=refresh_token" "refresh_token=$rt" "client_id=ct-auth"); fi
    code=$(printf '%s' "$r" | tail -n 1); body=$(printf '%s' "$r" | sed '$d')
    if [ "$code" = "200" ] && save_tokens "$body"; then
      cached=$(store_get access)
      printf '%s\n' "${cached%.*}"
      return 0
    fi
    case "$(jstr "$body" error)" in
      invalid_grant) say "ct-auth: $(jstr "$body" error_description)"; store_del refresh; store_del access ;;
      access_denied|unavailable) die "$(jstr "$body" error_description)" ;;
      *)
        # The sign-in service can't be reached: a token that hasn't expired yet still works.
        if [ -n "$cached" ] && [ "${cached##*.}" -gt "$(now)" ]; then printf '%s\n' "${cached%.*}"; return 0; fi
        die "$where can't be reached [$code]"
        ;;
    esac
  fi
  interactive_ok || die "not signed in for $(name_of): run  ct-auth login --client $client"
  login >/dev/null || exit 1
  cached=$(store_get access)
  printf '%s\n' "${cached%.*}"
}

case "$cmd" in
  login) login ;;
  token) token ;;
  header)
    CT_AUTH_NONINTERACTIVE=${CT_AUTH_NONINTERACTIVE:-1}
    [ -t 2 ] && CT_AUTH_NONINTERACTIVE=0
    t=$(token) || exit 1
    printf '{"Authorization": "Bearer %s"}\n' "$t"
    ;;
  status)
    info=$(store_get info)
    if [ -z "$(store_get refresh)" ] && [ -z "$(store_get access)" ]; then say "Not signed in to $url for $(name_of)."; exit 1; fi
    if [ "$mode" = "idp" ]; then say "Signed in with $idp_issuer as ${info%%|*}. Calls from $(name_of) go through Control Tower ($url)."
    else say "Signed in to $url as ${info%%|*}. Calls from $(name_of) are made as the key ${info#*|}."; fi
    ;;
  logout)
    rt=$(store_get refresh)
    if [ -n "$rt" ]; then
      endpoints
      if [ "$mode" = "idp" ]; then [ -n "$revoke_ep" ] && post "$revoke_ep" "token=$rt" "token_type_hint=refresh_token" "client_id=$idp_client_id" >/dev/null
      else post "$revoke_ep" "token=$rt" >/dev/null; fi
    fi
    store_del refresh; store_del access; store_del info
    say "Signed out for $(name_of)."
    ;;
esac
