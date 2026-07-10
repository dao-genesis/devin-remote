#!/bin/bash
# dao-exec v4.1 · 大道至简 · 太上 下知有之
# Mailbox Pattern sender · gh CLI or curl
#
# Usage:
#   DAO_TOKEN=ghp_xxx dao-exec.sh -a 179 hostname
#   DAO_TOKEN=ghp_xxx dao-exec.sh -a 141 -t screenshot
#   DAO_TOKEN=ghp_xxx dao-exec.sh --agents

set -u
REPO="${DAO_REPO:-dao-devin/devin-remote}"
TOKEN="${DAO_TOKEN:-}"
TIMEOUT="${DAO_TIMEOUT:-120}"
API="https://api.github.com/repos/$REPO"
AGENT=""
CMD_TYPE="shell"
LIST_AGENTS=""
PAYLOAD_CMD=""

# ════════════════════════════════════════════════════════════
# §1 · Auth + API
# ════════════════════════════════════════════════════════════
auth_header() {
  if [ -n "$TOKEN" ]; then
    echo "Authorization: token $TOKEN"
  elif command -v gh &>/dev/null; then
    local t; t="$(gh auth token 2>/dev/null || true)"
    [ -n "$t" ] && echo "Authorization: token $t"
  fi
}

dao_api() {
  local method="$1" path="$2" body="${3:-}"
  local auth; auth="$(auth_header)"
  local hdr=(-H "Accept: application/vnd.github.v3+json")
  [ -n "$auth" ] && hdr+=(-H "$auth")
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$API$path" "${hdr[@]}" \
      -H "Content-Type: application/json; charset=utf-8" -d "$body"
  else
    curl -sS -X "$method" "$API$path" "${hdr[@]}"
  fi
}

b64()   { printf '%s' "$1" | base64 -w0; }
unb64() { printf '%s' "$1" | base64 -d 2>/dev/null; }

# ════════════════════════════════════════════════════════════
# §2 · Parse args
# ════════════════════════════════════════════════════════════
while [ $# -gt 0 ]; do
  case "$1" in
    -a|--agent)  shift; AGENT="$1"; shift ;;
    -t|--type)   shift; CMD_TYPE="$1"; shift ;;
    --agents)    LIST_AGENTS=1; shift ;;
    --timeout)   shift; TIMEOUT="$1"; shift ;;
    *)           PAYLOAD_CMD="$PAYLOAD_CMD $1"; shift ;;
  esac
done
PAYLOAD_CMD="${PAYLOAD_CMD# }"

# ════════════════════════════════════════════════════════════
# §3 · List agents (scan mailbox issues via labels)
# ════════════════════════════════════════════════════════════
if [ -n "$LIST_AGENTS" ]; then
  echo "[dao] scanning mailbox issues..."
  dao_api GET "/issues?labels=dao-mailbox&state=open&per_page=100" | python3 -c "
import json,sys
try:
  for i in json.load(sys.stdin):
    t = i.get('title','')
    if t.startswith('mailbox-'):
      print(f'  {t[8:]}  (mailbox #{i[\"number\"]})')
except: pass
" 2>/dev/null
  exit 0
fi

# ════════════════════════════════════════════════════════════
# §4 · Resolve alias + find mailbox via labels
# ════════════════════════════════════════════════════════════
case "$AGENT" in
  141|desktop) AGENT="DESKTOP-MASTER" ;;
  179|laptop)  AGENT="ZHOUMAC" ;;
esac

TARGET="${AGENT:?usage: dao-exec.sh -a <agent> <command>}"
MAILBOX=0

# Use labels query: 1 API call finds all mailbox issues
MAILBOX="$(dao_api GET "/issues?labels=dao-mailbox&state=open&per_page=100" | python3 -c "
import json,sys
try:
  for i in json.load(sys.stdin):
    if i.get('title','') == 'mailbox-$TARGET':
      print(i['number'])
      break
except: print('0')
" 2>/dev/null)"

if [ "$MAILBOX" -eq 0 ]; then
  BODY="{\"title\":\"mailbox-$TARGET\",\"body\":\"dao mailbox v4 — $TARGET\",\"labels\":[\"dao-mailbox\"]}"
  MAILBOX="$(dao_api POST "/issues" "$BODY" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('number','0'))
except: print('0')
" 2>/dev/null)"
fi

if [ "$MAILBOX" -eq 0 ]; then
  echo "[dao] failed to find/create mailbox for $TARGET" >&2; exit 1
fi
echo "[dao] mailbox: #$MAILBOX"

# ════════════════════════════════════════════════════════════
# §5 · Send command + wait for result
# ════════════════════════════════════════════════════════════
ESC_CMD="$(printf '%s' "$PAYLOAD_CMD" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')"
CMD_JSON="{\"type\":\"$CMD_TYPE\",\"payload\":{\"command\":$ESC_CMD}}"
CMD_B64="$(b64 "$CMD_JSON")"
BODY="{\"body\":\"dao-cmd:$CMD_B64\"}"

dao_api POST "/issues/$MAILBOX/comments" "$BODY" | python3 -c "
import json,sys
try: print('[dao] sent to $TARGET (comment', json.load(sys.stdin).get('id','?'), ')')
except: print('[dao] sent to $TARGET')
" 2>/dev/null

DEADLINE=$(( $(date +%s) + TIMEOUT ))
while [ $(date +%s) -lt $DEADLINE ]; do
  sleep 3
  RESULT="$(dao_api GET "/issues/$MAILBOX/comments?per_page=10&sort=created&direction=desc" | python3 -c "
import json,sys,base64
try:
  for c in json.load(sys.stdin):
    body = c.get('body','')
    if body.startswith('dao-result:'):
      b64data = body[len('dao-result:'):]
      print(base64.b64decode(b64data).decode('utf-8'))
      break
except: pass
" 2>/dev/null)"

  if [ -n "$RESULT" ]; then
    printf '%s' "$RESULT" | python3 -c "
import json,sys
try:
  r = json.load(sys.stdin)
  if r.get('stdout'): print(r['stdout'])
  if r.get('stderr'): print(r['stderr'], file=sys.stderr)
  ms = r.get('execution_time_ms','?')
  ec = r.get('exit_code',0)
  tag = 'OK' if ec == 0 else 'FAILED'
  print(f'[dao] {tag} ({ms}ms)')
except Exception as e: print(f'[dao] parse error: {e}', file=sys.stderr)
" 2>/dev/null
    exit 0
  fi
done
echo "[dao] timeout ($TIMEOUT s)" >&2; exit 1
