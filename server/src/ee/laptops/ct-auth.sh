#!/bin/sh
# ct-auth: signs this computer in to Control Tower, and prints short-lived tokens for Claude Code, Claude Desktop
# and Codex. Installed by your IT team; part of Control Tower Enterprise (Elastic License 2.0).
#
#   ct-auth login  --client claude-code    sign in (opens the browser; approve it in Control Tower)
#   ct-auth token  --client claude-code    print an access token (signs in first if needed and allowed)
#   ct-auth header --client claude-code    print {"Authorization": "Bearer …"} for MCP clients
#   ct-auth status --client claude-code    who this computer is signed in as
#   ct-auth logout --client claude-code    sign out here, and end the sign-in in Control Tower
#
# Options: --url <Control Tower address> (or CT_URL, or url= in the config file), --no-browser.
# The refresh token is kept in the macOS keychain, or (elsewhere) in a file only you can read.
set -u
CT_AUTH_VERSION=1

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
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done
[ -n "$cmd" ] || cmd="token"
[ "$cmd" = "version" ] && { printf 'ct-auth %s\n' "$CT_AUTH_VERSION"; exit 0; }
case "$client" in claude-code|claude-desktop|codex|other) ;; *) die "--client is claude-code, claude-desktop, codex or other" ;; esac

# The address: --url, CT_URL, or the config file your IT team installed.
if [ -z "$url" ]; then
  for f in "${CT_AUTH_CONF:-}" "/Library/Application Support/ControlTower/ct-auth.conf" /etc/controltower/ct-auth.conf; do
    [ -n "$f" ] && [ -r "$f" ] || continue
    url=$(sed -n 's/^[[:space:]]*url[[:space:]]*=[[:space:]]*//p' "$f" | head -n 1 | tr -d '\r')
    [ -n "$url" ] && break
  done
fi
[ -n "$url" ] || die "no Control Tower address: pass --url, set CT_URL, or ask IT to install the configuration"
url=$(printf '%s' "$url" | sed 's#/*$##')
host=$(printf '%s' "$url" | sed 's#^[A-Za-z]*://##; s#/.*##')

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

# ---- talking to Control Tower ----
command -v curl >/dev/null 2>&1 || die "curl is needed"
# Values from Control Tower's JSON answers (flat objects, no quotes inside values).
jstr() { printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }
jnum() { printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" | head -n 1; }
post() { # path, then name=value pairs; prints the body, then the status on the last line
  p="$1"; shift
  n=$#
  while [ "$n" -gt 0 ]; do set -- "$@" --data-urlencode "$1"; shift; n=$((n - 1)); done
  curl -sS --max-time 20 -X POST -H 'accept: application/json' -H "user-agent: ct-auth/$CT_AUTH_VERSION" "$@" -w '\n%{http_code}' "$url$p" 2>/dev/null || printf '\n000'
}
now() { date +%s; }

name_of() {
  case "$client" in claude-code) echo "Claude Code" ;; claude-desktop) echo "Claude Desktop" ;; codex) echo "Codex" ;; *) echo "this computer" ;; esac
}

save_tokens() { # body
  at=$(jstr "$1" access_token)
  [ -n "$at" ] || return 1
  exp=$(( $(now) + $(jnum "$1" expires_in) ))
  store_set access "$at.$exp"
  rt=$(jstr "$1" refresh_token)
  [ -n "$rt" ] && store_set refresh "$rt"
  who=$(jstr "$1" person); key=$(jstr "$1" key_name)
  [ -n "$who" ] && store_set info "$who|$key"
  return 0
}

# May this run open a browser and wait? Not when an app says nobody is there (Claude Desktop's helper contexts).
interactive_ok() {
  [ "${CT_AUTH_NONINTERACTIVE:-}" = "1" ] && return 1
  case "${CLAUDE_HELPER_CONTEXT:-interactive}" in interactive|setup-test) return 0 ;; *) return 1 ;; esac
}

login() {
  r=$(post /device/code "client=$client" "device_name=$(hostname 2>/dev/null || echo computer)")
  code=$(printf '%s' "$r" | tail -n 1); body=$(printf '%s' "$r" | sed '$d')
  [ "$code" = "200" ] || die "Control Tower ($url) refused to start a sign-in: $(jstr "$body" error_description)${code:+ [$code]}"
  dc=$(jstr "$body" device_code); uc=$(jstr "$body" user_code)
  vu=$(jstr "$body" verification_uri_complete); [ -n "$vu" ] || vu=$(jstr "$body" verification_uri)
  interval=$(jnum "$body" interval); [ -n "$interval" ] || interval=5
  life=$(jnum "$body" expires_in); [ -n "$life" ] || life=600
  [ -n "${CT_AUTH_WAIT:-}" ] && [ "$CT_AUTH_WAIT" -lt "$life" ] && life="$CT_AUTH_WAIT"
  say ""
  say "Sign in to Control Tower for $(name_of):"
  say "  open  $vu"
  say "  and check the code  $uc"
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
    r=$(post /device/token "grant_type=urn:ietf:params:oauth:grant-type:device_code" "device_code=$dc" "client_id=ct-auth")
    code=$(printf '%s' "$r" | tail -n 1); body=$(printf '%s' "$r" | sed '$d')
    if [ "$code" = "200" ]; then
      save_tokens "$body" || die "Control Tower's answer had no token"
      say "Signed in as $(jstr "$body" person). Calls from $(name_of) are made as the key $(jstr "$body" key_name)."
      return 0
    fi
    case "$(jstr "$body" error)" in
      authorization_pending) ;;
      slow_down) interval=$(( interval + 5 )) ;;
      "") [ "$code" = "000" ] || die "Control Tower answered $code" ;;
      *) die "$(jstr "$body" error_description)" ;;
    esac
  done
  die "the sign-in wasn't approved in time; run ct-auth login --client $client to try again"
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
    r=$(post /device/token "grant_type=refresh_token" "refresh_token=$rt" "client_id=ct-auth")
    code=$(printf '%s' "$r" | tail -n 1); body=$(printf '%s' "$r" | sed '$d')
    if [ "$code" = "200" ] && save_tokens "$body"; then
      printf '%s\n' "$(jstr "$body" access_token)"
      return 0
    fi
    case "$(jstr "$body" error)" in
      invalid_grant) say "ct-auth: $(jstr "$body" error_description)"; store_del refresh; store_del access ;;
      access_denied|unavailable) die "$(jstr "$body" error_description)" ;;
      *)
        # Control Tower can't be reached: a token that hasn't expired yet still works.
        if [ -n "$cached" ] && [ "${cached##*.}" -gt "$(now)" ]; then printf '%s\n' "${cached%.*}"; return 0; fi
        die "Control Tower ($url) can't be reached [$code]"
        ;;
    esac
  fi
  interactive_ok || die "not signed in to Control Tower for $(name_of): run  ct-auth login --client $client"
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
    if [ -z "$(store_get refresh)" ]; then say "Not signed in to $url for $(name_of)."; exit 1; fi
    say "Signed in to $url as ${info%%|*}. Calls from $(name_of) are made as the key ${info#*|}."
    ;;
  logout)
    rt=$(store_get refresh)
    [ -n "$rt" ] && post /device/revoke "token=$rt" >/dev/null
    store_del refresh; store_del access; store_del info
    say "Signed out of $url for $(name_of)."
    ;;
esac
