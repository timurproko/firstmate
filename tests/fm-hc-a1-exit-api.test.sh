#!/usr/bin/env bash
# A1 graceful exit through its public integration API on the hc backend. A fake
# `hc get` supplies the terminal's native identity labels and a fake `a1`
# answers the recorded requests; nothing contacts Core, a real A1, or types keys.
set -eu
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export FM_HOME="$TMP/home"
mkdir -p "$FM_HOME/state" "$TMP/bin"
. "$ROOT/bin/fm-backend.sh"
fm_backend_source hc

NOW_MS=$(( $(date +%s) * 1000 ))
AT=$NOW_MS; APP=a1; STATE=live
SID=11111111-1111-4111-8111-111111111111; RID=22222222-2222-4222-8222-222222222222
TASK=fm-t1; TAG=$(fm_backend_hometag)
fm_backend_hc_get() {
  jq -n --arg task "$TASK" --arg home "$TAG" --arg app "$APP" --arg at "$AT" --arg sid "$SID" --arg rid "$RID" --arg state "$STATE" '
    {state:$state,pid:42,labels:{"firstmate.task":$task,"firstmate.home":$home,"a1.session":$sid,"a1.runtime":$rid,"a1.at":$at},status:{app:$app,state:"done"}}'
}
target() {  # <expected> <why>
  local got rc=0
  got=$(fm_backend_hc_a1_target default:t1 fm-t1) || rc=$?
  [ "$got" = "$1" ] || { printf 'FAIL: %s: wanted [%s] got [%s]\n' "$2" "$1" "$got"; exit 1; }
  case "$1" in *$'\t'*) [ "$rc" = 0 ] ;; *) [ "$rc" != 0 ] ;; esac || { printf 'FAIL: %s: wrong status %s\n' "$2" "$rc"; exit 1; }
}
target "$(printf '%s\t%s' "$SID" "$RID")" 'fresh native identity resolves the exact session and runtime'
AT=$(( NOW_MS - 200000 )); target identity-stale 'a heartbeat older than the 90 s contract is not addressable'; AT=$NOW_MS
AT=$(( NOW_MS + 60000 )); target identity-stale 'a future heartbeat beyond clock tolerance is not addressable'; AT=$NOW_MS
APP=pi; target not-a1 'stock Pi is not an A1 target'; APP=a1
TASK=fm-other; target foreign-terminal "another task's terminal is never addressed"; TASK=fm-t1
TAG=foreign; target foreign-terminal "another home's terminal is never addressed"; TAG=$(fm_backend_hometag)
SID=not-a-uuid; target identity-missing 'a partial identity fails closed'; SID=11111111-1111-4111-8111-111111111111
STATE=finished; target not-live 'a finished terminal has no live session'; STATE=live

# The fake a1 records every request and answers the scripted mode per operation.
cat > "$TMP/bin/a1" <<'A1'
#!/usr/bin/env bash
set -eu
D=${A1_FIXTURE:?}
[ "$1" = api ] || { echo 'not api' >&2; exit 2; }
printf '%s\n' "$2" >> "$D/requests"
type=$(jq -r .type <<<"$2"); id=$(jq -r .id <<<"$2"); sid=$(jq -r .target.sessionId <<<"$2"); rid=$(jq -r .target.runtimeId <<<"$2")
mode=$(cat "$D/mode-${type#session.}" 2>/dev/null || echo alive)
reply() { jq -cn --arg id "$id" --arg type "$type" --arg sid "$sid" --arg rid "$rid" --argjson data "$1" '{version:1,id:$id,type:"response",command:$type,success:true,data:({target:{scope:"session",sessionId:$sid,runtimeId:$rid}} + $data)}'; }
refuse() { jq -cn --arg id "$id" --arg type "$type" --arg code "$1" '{version:1,id:$id,type:"response",command:$type,success:false,error:{code:$code,message:"x"}}'; exit 1; }
case "$type:$mode" in
  session.lifecycle:alive) reply '{"lifecycle":"ready","exitAdmissible":true,"blockers":[]}' ;;
  session.lifecycle:dead) refuse session-unavailable ;;
  session.lifecycle:limit) refuse control-limit ;;
  session.lifecycle:after-exit) if [ -e "$D/exited" ]; then refuse session-unavailable; else reply '{"lifecycle":"ready","exitAdmissible":true,"blockers":[]}'; fi ;;
  session.exit:admitted) : > "$D/exited"; reply '{"status":"admitted","lifecycle":"stopping"}' ;;
  session.exit:admitted-stubborn) reply '{"status":"admitted","lifecycle":"stopping"}' ;;
  session.exit:not-admitted) reply '{"status":"queued","lifecycle":"ready"}' ;;
  session.exit:refused-*) refuse "${mode#refused-}" ;;
  session.exit:expired) refuse request-expired ;;
  session.exit:other-id) jq -cn '{version:1,id:"someone-else",type:"response",command:"session.exit",success:true,data:{status:"admitted"}}' ;;
  session.exit:garbage) echo 'not json' ;;
  *) exit 3 ;;
esac
A1
chmod +x "$TMP/bin/a1"
export A1_FIXTURE="$TMP" FM_A1_BIN="$TMP/bin/a1"
mode() { printf '%s' "$2" > "$TMP/mode-$1"; }
requests() { [ -e "$TMP/requests" ] && wc -l < "$TMP/requests" | tr -d ' ' || echo 0; }
reset() { rm -f "$TMP/requests" "$TMP/exited"; mode lifecycle alive; mode exit admitted; }

reset; mode lifecycle alive
[ "$(fm_backend_hc_a1_agent_state "$SID" "$RID")" = alive ] || { echo 'FAIL: a successful lifecycle answer is alive'; exit 1; }
mode lifecycle dead
[ "$(fm_backend_hc_a1_agent_state "$SID" "$RID")" = dead ] || { echo 'FAIL: session-unavailable is A1 saying the runtime is gone'; exit 1; }
mode lifecycle limit
[ "$(fm_backend_hc_a1_agent_state "$SID" "$RID")" = unreadable ] || { echo 'FAIL: a transport or limit failure is never a stopped agent'; exit 1; }
got=$(FM_A1_BIN="$TMP/bin/absent" PATH="$TMP/empty:$(dirname "$(command -v jq)"):/usr/bin" fm_backend_hc_a1_agent_state "$SID" "$RID")
[ "$got" = unreadable ] || { printf 'FAIL: missing a1 must read unreadable (%s)\n' "$got"; exit 1; }

exit_case() {  # <mode> <expected-verdict> <why>
  reset; mode exit "$1"
  local got; got=$(fm_backend_hc_a1_exit "$SID" "$RID")
  [ "$got" = "$2" ] || { printf 'FAIL: %s: wanted [%s] got [%s]\n' "$3" "$2" "$got"; exit 1; }
  [ "$(requests)" = 1 ] || { printf 'FAIL: %s: expected exactly one request\n' "$3"; exit 1; }
}
exit_case admitted admitted 'an acknowledged admission for the exact target'
jq -e --arg sid "$SID" --arg rid "$RID" '
  .version == 1 and .type == "session.exit" and (.id | startswith("fm-"))
  and .target == {scope:"session",sessionId:$sid,runtimeId:$rid} and (keys | length) == 4' "$TMP/requests" >/dev/null \
  || { echo 'FAIL: request is not the documented protocol-1 session.exit shape'; exit 1; }
exit_case not-admitted $'unknown\tunacknowledged-admission' 'success without status=admitted is not trusted'
for code in session-busy editor-not-empty pending-input overlay-open session-stopping; do
  exit_case "refused-$code" "$(printf 'refused\t%s' "$code")" "A1's $code refusal is reported verbatim"
done
exit_case expired $'unknown\trequest-expired' 'an expired request is an unknown outcome'
exit_case other-id $'unknown\tuncorrelated-response' 'a reply for another request is not an acknowledgement'
exit_case garbage $'unknown\tmalformed-response' 'unparseable output is an unknown outcome'

# Fresh-shell control path: `exit` drives the API on an A1 target, never a key
# or slash prompt, and proves termination through A1's own lifecycle answer.
CLI="$TMP/cli"
mkdir -p "$CLI/bin" "$CLI/home/state" "$CLI/home/data" "$CLI/worktree"
cat > "$CLI/bin/hc" <<'SH'
#!/usr/bin/env bash
set -eu
D=${FM_HC_CLI_FIXTURE:?}
case "$1" in
  get) printf '%s\n' "$(< "$D/terminal.json")" ;;
  read) printf 'A1 ready\n' ;;
  keys) printf '%s\n' "${@: -1}" >> "$D/keys"; exit 1 ;;
  send) printf '%s\n' "${@: -1}" >> "$D/text"; exit 1 ;;
  *) exit 1 ;;
esac
SH
cp "$TMP/bin/a1" "$CLI/bin/a1"
chmod +x "$CLI/bin/"*
CLI_HOME="$CLI/home"
CLI_TAG=$(FM_HOME="$CLI_HOME" bash -c '. "$1/bin/fm-backend.sh"; fm_backend_source hc; fm_backend_hometag' _ "$ROOT")
terminal_json() {  # [with-identity]
  if [ "${1:-yes}" = yes ]; then
    jq -n --arg home "$CLI_TAG" --arg at "$NOW_MS" --arg sid "$SID" --arg rid "$RID" '{state:"live",pid:42,labels:{"firstmate.task":"fm-t1","firstmate.home":$home,"a1.session":$sid,"a1.runtime":$rid,"a1.at":$at},status:{app:"a1",state:"done"}}'
  else
    jq -n --arg home "$CLI_TAG" '{state:"live",pid:42,labels:{"firstmate.task":"fm-t1","firstmate.home":$home},status:{app:"a1",state:"done"}}'
  fi > "$CLI/terminal.json"
}
prepare_cli() {  # <lifecycle-mode> <exit-mode>
  printf 'window=default:t1\nendpoint_task_id=t1\nworktree=%s\nproject=%s\nharness=pi\nkind=ship\nbackend=hc\nhc_session=default\nhc_terminal=t1\n' "$CLI/worktree" "$CLI/worktree" > "$CLI_HOME/state/t1.meta"
  printf '%s' "$1" > "$CLI/mode-lifecycle"; printf '%s' "$2" > "$CLI/mode-exit"
  rm -f "$CLI/requests" "$CLI/exited" "$CLI/keys" "$CLI/text"
  terminal_json yes
}
run_cli() {
  env PATH="$CLI/bin:$PATH" FM_HOME="$CLI_HOME" FM_HC_BIN="$CLI/bin/hc" FM_HC_CLI_FIXTURE="$CLI" A1_FIXTURE="$CLI" FM_A1_BIN="$CLI/bin/a1" \
    FM_CONTROL_POLL=0.1 FM_CONTROL_EXIT_WAIT=1 FM_STATE_OVERRIDE="$CLI_HOME/state" \
    bash "$ROOT/bin/fm-control.sh" t1 exit
}
cli_requests() { grep -c "\"type\":\"$1\"" "$CLI/requests" 2>/dev/null || true; }
prepare_cli after-exit admitted
if ! actual=$(run_cli 2>&1); then printf 'FAIL: fresh-shell API exit: %s\n' "$actual"; exit 1; fi
case "$actual" in *'stopped t1 harness=pi backend=hc'*) ;; *) printf 'FAIL: wrong exit result: %s\n' "$actual"; exit 1 ;; esac
[ "$(cli_requests session.exit)" = 1 ] && [ ! -e "$CLI/keys" ] && [ ! -e "$CLI/text" ] \
  || { echo 'FAIL: exactly one exit request and zero keys or slash prompts were expected'; exit 1; }
prepare_cli dead admitted
actual=$(run_cli 2>&1) || { printf 'FAIL: already-stopped must succeed: %s\n' "$actual"; exit 1; }
case "$actual" in *already-stopped*) ;; *) printf 'FAIL: dead A1 should read already-stopped: %s\n' "$actual"; exit 1 ;; esac
[ "$(cli_requests session.exit)" = 0 ] || { echo 'FAIL: a dead A1 must not be asked to exit'; exit 1; }
prepare_cli alive refused-editor-not-empty
if actual=$(run_cli 2>&1); then echo 'FAIL: a refused exit was declared stopped'; exit 1; fi
case "$actual" in *'A1 refused to stop task t1: editor-not-empty'*) ;; *) printf 'FAIL: refusal not surfaced: %s\n' "$actual"; exit 1 ;; esac
[ ! -e "$CLI/keys" ] && [ ! -e "$CLI/text" ] || { echo 'FAIL: a refusal must not fall back to typing'; exit 1; }
prepare_cli alive admitted-stubborn
if actual=$(run_cli 2>&1); then echo 'FAIL: live stubborn agent declared stopped'; exit 1; fi
case "$actual" in *'agent-state=alive exit=unconfirmed'*) ;; *) printf 'FAIL: wrong timeout result: %s\n' "$actual"; exit 1 ;; esac
[ "$(cli_requests session.exit)" = 1 ] || { echo 'FAIL: an unconfirmed exit must not be re-requested'; exit 1; }
prepare_cli limit admitted
if actual=$(run_cli 2>&1); then echo 'FAIL: an unreadable A1 was exited'; exit 1; fi
case "$actual" in *'cannot be reached through its API (lifecycle=unreadable)'*) ;; *) printf 'FAIL: unreadable not surfaced: %s\n' "$actual"; exit 1 ;; esac
[ "$(cli_requests session.exit)" = 0 ] || { echo 'FAIL: an unreadable A1 must not be asked to exit'; exit 1; }
prepare_cli alive admitted; terminal_json no
if actual=$(run_cli 2>&1); then echo 'FAIL: an A1 without native identity was exited'; exit 1; fi
case "$actual" in *'native session identity is identity-missing'*) ;; *) printf 'FAIL: missing identity not surfaced: %s\n' "$actual"; exit 1 ;; esac
[ ! -e "$CLI/requests" ] && [ ! -e "$CLI/keys" ] && [ ! -e "$CLI/text" ] || { echo 'FAIL: unaddressable A1 must receive nothing'; exit 1; }
printf 'ok - A1 exit through the public API: exact-target requests, lifecycle-proven liveness, verbatim refusals, unknown/unavailable outcomes, no keys or prompts, unconfirmed exits not re-requested, unaddressable A1 refused\n'
