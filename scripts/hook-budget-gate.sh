#!/usr/bin/env bash
#
# hook-budget-gate.sh — does Claude Code give EACH SessionStart hook command its
# own output limit?
#
# The EML boot (`hook session-start`) and the project block (`hook project-block`)
# are two SessionStart commands of up to 10,000 characters each
# (mcp-server BOOT_BUDGET_CHARS, PROJECT_BLOCK_BUDGET_CHARS). That only works when
# the limit holds per hook output, not per event. This gate checks it against
# the installed Claude Code:
#
#   run 1  two SessionStart hooks, ~9,000 chars each → both must arrive uncut
#   run 2  one SessionStart hook,  ~11,000 chars     → must NOT arrive whole
#          (the control: the limit exists, so run 1 shows it is per hook)
#   run 3  one SessionStart hook of exactly 10,000 chars, the last one the
#          newline our hooks print after the output (budget 9,999) → must
#          arrive uncut. Run 4 (10,001 chars) only reports where the edge is.
#
# "Arrives uncut" = the model repeats the hook's end marker, and the transcript
# shows no <persisted-output> for the run (Claude Code's form for an output it
# wrote to a file, with only a 2 KB preview in the context). The transcript's
# raw "stdout" field holds the whole output either way, so it is not the test.
#
# Needs a logged-in Claude Code: CLAUDE_CONFIG_DIR pointing at a config with a
# login, or CLAUDE_CODE_OAUTH_TOKEN (setup-token). CLAUDE_BIN overrides `claude`.
# Runs in a throwaway dir; the config dir only gains the run's transcripts.
set -u

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
MARKER="HBG$(date +%s)$$"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/eml-hook-gate.XXXXXX")"
WS="$BASE/ws"
mkdir -p "$WS"

pass=0; fail=0
ok(){  pass=$((pass+1)); printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad(){ fail=$((fail+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }

# A hook that prints <chars> characters: a start line, filler, an end marker,
# and with $3 = nl a trailing newline (counted in <chars>), as our hooks print.
hook_script() { # $1 name, $2 chars, [$3 nl]
  local f="$BASE/hook-$1.js" tail=""
  [ "${3:-}" = nl ] && tail='\n'
  cat > "$f" <<EOF
const end = '${MARKER}-$1-END'
const start = '${MARKER}-$1-START\n'
const tail = '$tail'
const filler = 'x'.repeat($2 - start.length - end.length - tail.length - 1).replace(/(.{99})./g, '\$1\n')
process.stdout.write(start + filler + '\n' + end + tail)
EOF
  printf 'node %s' "$f"
}

settings() { # hook commands …
  local hooks="" sep=""
  for cmd in "$@"; do hooks="$hooks$sep{\"hooks\":[{\"type\":\"command\",\"command\":\"$cmd\"}]}"; sep=","; done
  printf '{"hooks":{"SessionStart":[%s]}}' "$hooks"
}

PROMPT="List every line in your context that ends with -END and starts with ${MARKER}. Print only those lines, one per line, nothing else. If there are none, print NONE."

run() { # $1 label, $2 settings file → prints the model's answer; sets SID
  ( cd "$WS" && "$CLAUDE_BIN" -p "$PROMPT" --settings "$2" --output-format json --disallowedTools Read Bash Grep Glob Task 2>"$BASE/$1.err" ) > "$BASE/$1.json"
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(r.session_id ?? ""); console.log(r.result ?? "")' "$BASE/$1.json" 2>/dev/null
}

transcript_has() { # $1 session id, $2 text — anywhere in the run's transcript
  local t
  t="$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -name "$1.jsonl" 2>/dev/null | head -1)"
  [ -n "$t" ] && grep -q -- "$2" "$t"
}

echo "== hook budget gate ($("$CLAUDE_BIN" --version 2>&1)) — marker $MARKER"

# run 1: two hooks of 9,000 chars
S1="$BASE/settings-two.json"; settings "$(hook_script A 9000)" "$(hook_script B 9000)" > "$S1"
OUT1="$(run two "$S1")"; SID1="$(printf '%s\n' "$OUT1" | head -1)"; ANS1="$(printf '%s\n' "$OUT1" | tail -n +2)"
[ -n "$SID1" ] || { echo "claude -p failed: $(head -5 "$BASE/two.err")"; exit 2; }
for h in A B; do
  if transcript_has "$SID1" "${MARKER}-$h-START" && ! transcript_has "$SID1" "persisted-output" \
    && printf '%s' "$ANS1" | grep -q "${MARKER}-$h-END"; then
    ok "two hooks: hook $h (9,000 chars) arrived uncut"
  else
    bad "two hooks: hook $h (9,000 chars) did not arrive uncut"
  fi
done

# run 2: one hook of 11,000 chars (control)
S2="$BASE/settings-one.json"; settings "$(hook_script C 11000)" > "$S2"
OUT2="$(run one "$S2")"; SID2="$(printf '%s\n' "$OUT2" | head -1)"; ANS2="$(printf '%s\n' "$OUT2" | tail -n +2)"
if ! transcript_has "$SID2" "${MARKER}-C-START"; then
  bad "control: the 11,000-char hook did not run at all"
elif printf '%s' "$ANS2" | grep -q "${MARKER}-C-END" || ! transcript_has "$SID2" "persisted-output"; then
  bad "control: an 11,000-char hook arrived whole — the limit is not where we think"
else
  ok "control: an 11,000-char hook was cut to a preview (the limit exists)"
fi

# run 3: one hook of exactly 10,000 chars incl. the trailing newline (our budget edge)
S3="$BASE/settings-edge.json"; settings "$(hook_script D 10000 nl)" > "$S3"
OUT3="$(run edge "$S3")"; SID3="$(printf '%s\n' "$OUT3" | head -1)"; ANS3="$(printf '%s\n' "$OUT3" | tail -n +2)"
if transcript_has "$SID3" "${MARKER}-D-START" && ! transcript_has "$SID3" "persisted-output" \
  && printf '%s' "$ANS3" | grep -q "${MARKER}-D-END"; then
  ok "edge: a 10,000-char hook (9,999 + newline) arrived uncut"
else
  bad "edge: a 10,000-char hook (9,999 + newline) did not arrive uncut"
fi

# run 4: 10,001 chars — information only: where exactly the limit cuts
S4="$BASE/settings-over.json"; settings "$(hook_script E 10001 nl)" > "$S4"
OUT4="$(run over "$S4")"; SID4="$(printf '%s\n' "$OUT4" | head -1)"
if transcript_has "$SID4" "persisted-output"; then
  echo "  ....  info: 10,001 chars is cut (the limit is exactly 10,000)"
else
  echo "  ....  info: 10,001 chars still arrives whole (the cut is above 10,001)"
fi

echo "== $pass passed, $fail failed (work dir $BASE)"
[ "$fail" -eq 0 ]
