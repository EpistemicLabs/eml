#!/usr/bin/env bash
#
# isolation-gate.sh — empirical Claude Code config-isolation gate (MVP-PLAN ch. 5/7)
#
# Two directions for a `claude` session with isolated CLAUDE_CONFIG_DIR + --strict-mcp-config:
#   (1) "nothing out" — real ~/.claude / ~/.claude.json not written (filesystem)
#   (2) "nothing in" — user MCP (eml_*) + foreign CLAUDE.md/instructions not loaded
#
# Direction 2 needs the model to actually run -> inject a token (setup-token) via
# TOKEN_FILE (/tmp/eml-gate-token) or CLAUDE_CODE_OAUTH_TOKEN. Without it, only the
# config-init + MCP + filesystem checks run (the model probe is skipped).
#
# Canaries: throwaway CLAUDE.md files are planted in the isolated config dir, the
# workspace, and an ancestor dir — the model reports which it can see. The user's
# REAL files are never touched (read/hash only). bash 3.2 compatible.
# Covers isolation layers (1) CLAUDE_CONFIG_DIR + (2) --strict-mcp-config.
# Layer (3) OS-sandbox NOT covered (sandbox.enabled absent in this CLI version).
#
# Optional: PERSONA_NAME=<name> also probes for the name of your EML agent persona
# (as set up in your user-global CLAUDE.md) leaking into the isolated session.
set -u

MARKER="EMLGATE-$(date +%s)-$$"
BASE="/tmp/eml-gate-${MARKER}"
ISO="${BASE}/config"
WS="${BASE}/ws"
REAL="${HOME}/.claude"
REALJSON="${HOME}/.claude.json"
PARENT_PROJ="$(pwd | sed 's#/#-#g')"
WSNAME="$(printf '%s' "$WS" | sed 's#/#-#g')"
PERSONA_NAME="${PERSONA_NAME:-}"

mkdir -p "$ISO" "$WS" "${BASE}/backup"

pass=0; fail=0
say(){ printf '%s\n' "$*"; }
ok(){   pass=$((pass+1)); printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad(){  fail=$((fail+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }
info(){ printf '  ....  %s\n' "$*"; }
hashfile(){ [ -f "$1" ] && shasum -a 256 "$1" | awk '{print $1}' || echo "ABSENT"; }

say "== EML isolation gate =================================================="
say "marker      : $MARKER"
say "config dir  : $ISO"
say "workspace   : $WS"
say "claude ver  : $(claude --version 2>&1)"
say

# ---- Tier A baseline: static user config must stay byte-identical ---------
A1="$REAL/settings.json"; A2="$REAL/settings.local.json"; A3="$REAL/CLAUDE.md"
A1B="$(hashfile "$A1")"; A2B="$(hashfile "$A2")"; A3B="$(hashfile "$A3")"
for f in "$A1" "$A2" "$A3"; do [ -f "$f" ] && cp "$f" "${BASE}/backup/"; done
find "$REAL" -type f 2>/dev/null | sort > "${BASE}/before.list"
JSON_BEFORE="$(hashfile "$REALJSON")"

# ---- injected launch files + canaries ------------------------------------
MCPCFG="${BASE}/mcp.json";        printf '{"mcpServers":{}}' > "$MCPCFG"
SETTINGS="${BASE}/settings.json"; printf '{}' > "$SETTINGS"
# throwaway CLAUDE.md canaries (real ~/.claude is never written)
printf '# gate\nCANARY_OURDIR_%s\n'   "$MARKER" > "$ISO/CLAUDE.md"     # isolated user-global
printf '# gate\nCANARY_PROJECT_%s\n'  "$MARKER" > "$WS/CLAUDE.md"      # project (cwd)
printf '# gate\nCANARY_ANCESTOR_%s\n' "$MARKER" > "$BASE/CLAUDE.md"    # ancestor of cwd

# ---- token injection (never printed) -------------------------------------
TOKEN_FILE="${TOKEN_FILE:-/tmp/eml-gate-token}"
TOK="${CLAUDE_CODE_OAUTH_TOKEN:-}"
[ -z "$TOK" ] && [ -f "$TOKEN_FILE" ] && TOK="$(tr -d '[:space:]' < "$TOKEN_FILE")"
if [ -n "$TOK" ]; then say ">> token: injected (${#TOK} chars, value hidden)"; else say ">> token: none — model probe will be skipped"; fi

# ---- run isolated session (full tool-using turn, from the clean workspace)-
PROMPT="You are inside an isolation test. Do these in order, then stop.
1. Use the Bash tool to run exactly: echo ${MARKER} > bashcanary.txt
2. Report ONLY what is truly present in your instructions/system context right now.
Output EXACTLY one final line, nothing after it:
RESULT persona=<HAS|NO> eml=<HAS|NO> ourdir=<HAS|NO> project=<HAS|NO> ancestor=<HAS|NO>
- persona: HAS if your context mentions ${PERSONA_NAME:+'${PERSONA_NAME}' or }'Engram', else NO
- eml:    HAS if any tool available to you has a name starting with eml_, else NO
- ourdir: HAS if the token CANARY_OURDIR_${MARKER} is in your instructions, else NO
- project:HAS if the token CANARY_PROJECT_${MARKER} is in your instructions, else NO
- ancestor:HAS if the token CANARY_ANCESTOR_${MARKER} is in your instructions, else NO"

say ">> launching isolated claude -p from \$WS ..."
( cd "$WS" && CLAUDE_CONFIG_DIR="$ISO" CLAUDE_CODE_OAUTH_TOKEN="$TOK" \
    claude -p "$PROMPT" \
      --mcp-config "$MCPCFG" --strict-mcp-config \
      --settings "$SETTINGS" --setting-sources user,project \
      --dangerously-skip-permissions \
      >"${BASE}/out.txt" 2>"${BASE}/err.txt" )
RC=$?
unset TOK
OUTSNIP="$(tail -1 "${BASE}/out.txt" 2>/dev/null)"
say ">> exit=$RC  out(last)=\"${OUTSNIP}\""
AUTHED=1; grep -qi 'not logged in\|/login' "${BASE}/out.txt" 2>/dev/null && AUTHED=0
say

find "$REAL" -type f 2>/dev/null | sort > "${BASE}/after.list"
JSON_AFTER="$(hashfile "$REALJSON")"

# ======================================================================
say "== Direction 1 — nothing out (real ~/.claude untouched) ================"
tierA_ok=1
[ "$A1B" = "$(hashfile "$A1")" ] || { bad "MODIFIED: ~/.claude/settings.json"; tierA_ok=0; }
[ "$A2B" = "$(hashfile "$A2")" ] || { bad "MODIFIED: ~/.claude/settings.local.json"; tierA_ok=0; }
[ "$A3B" = "$(hashfile "$A3")" ] || { bad "MODIFIED: ~/.claude/CLAUDE.md"; tierA_ok=0; }
[ "$tierA_ok" = 1 ] && ok "Tier A: static user config byte-identical (settings/settings.local/CLAUDE.md)"

HITS="$(grep -rlF -e "$MARKER" -e "$WS" -e "$WSNAME" "$REAL" "$REALJSON" \
          --exclude-dir="$PARENT_PROJ" 2>/dev/null)"
if [ -z "$HITS" ]; then ok "Tier B: no isolated-session fingerprint in real ~/.claude / ~/.claude.json"
else bad "Tier B: fingerprint leaked into real config:"; printf '        %s\n' $HITS; fi

if [ -d "$REAL/projects/$WSNAME" ]; then bad "leaked project dir in real ~/.claude/projects/$WSNAME"
else ok "Tier B: no /tmp-workspace project dir under real ~/.claude/projects"; fi

if grep -qF -e "$MARKER" -e "$WS" -e "$WSNAME" "$REALJSON" 2>/dev/null; then
  bad "~/.claude.json contains isolated-session fingerprint"
else [ "$JSON_BEFORE" = "$JSON_AFTER" ] && info "~/.claude.json unchanged" || info "~/.claude.json changed by parent app, no isolated fingerprint (ok)"; fi

say
say "== Positive control — writes redirected into the isolated dir ==========="
ISO_FILES="$(find "$ISO" -type f 2>/dev/null | wc -l | tr -d ' ')"
[ "$ISO_FILES" -gt 0 ] && ok "isolated config dir populated ($ISO_FILES files) — wrote to redirect, not to ~" \
                       || bad "isolated config dir EMPTY — session did not initialise"

say
say "== Direction 2 — nothing in (foreign MCP + instructions not loaded) ===="
# (a) MCP — deterministic, no auth needed
ISO_MCP="$(CLAUDE_CONFIG_DIR="$ISO" claude mcp list 2>&1)"
if printf '%s' "$ISO_MCP" | grep -qi 'eml_brain'; then bad "eml_brain MCP visible in isolated session"
else ok "MCP: isolated 'mcp list' shows no eml_brain server (CLAUDE_CONFIG_DIR isolated it)"; fi

# (b) instructions/CLAUDE.md — needs the authed model self-report
if [ "$AUTHED" = 0 ]; then
  info "model probe SKIPPED — isolated session reported 'not logged in' (no/failed token)"
  info "  -> instruction-loading (CLAUDE.md/persona/eml) could NOT be verified this run"
else
  R="$(grep -Eo 'RESULT persona=(HAS|NO) eml=(HAS|NO) ourdir=(HAS|NO) project=(HAS|NO) ancestor=(HAS|NO)' "${BASE}/out.txt" | tail -1)"
  say "  model self-report: ${R:-<none parsed — see ${BASE}/out.txt>}"
  get(){ printf '%s' "$R" | grep -o "$1=[A-Z]*" | cut -d= -f2; }
  M="$(get persona)"; E="$(get eml)"; OD="$(get ourdir)"; PR="$(get project)"; AN="$(get ancestor)"
  # positive control first: is the report trustworthy?
  if [ "$OD" = "HAS" ]; then ok "positive control: isolated session DOES load our config-dir CLAUDE.md (report is trustworthy)"
  elif [ "$OD" = "NO" ]; then info "positive control weak: our canary not reported — self-report may be unreliable (see out.txt)"
  else info "positive control inconclusive (no parse)"; fi
  # the actual leak checks
  case "$M" in NO) ok "no persona/Engram instructions leaked into isolated session";; HAS) bad "persona/Engram instructions LEAKED into isolated session";; *) info "persona inconclusive";; esac
  case "$E" in NO) ok "no eml_* tools in isolated session";; HAS) bad "eml_* tools LEAKED into isolated session";; *) info "eml inconclusive";; esac
  # informational: expected-loaded + documented limitation
  [ "$PR" = "HAS" ] && info "project CLAUDE.md loaded (expected — it is the workspace repo)" || info "project CLAUDE.md not reported (PR=$PR)"
  [ "$AN" = "HAS" ] && info "ancestor CLAUDE.md loaded — confirms the documented limitation (place workspace on a CLAUDE.md-free ancestor path)" || info "ancestor CLAUDE.md not loaded (AN=$AN)"
  # re-assert real ~ untouched AFTER a fully-running tool-using session
  [ "$A1B" = "$(hashfile "$A1")" ] && [ "$A2B" = "$(hashfile "$A2")" ] && [ "$A3B" = "$(hashfile "$A3")" ] \
    && ok "post-full-session: static user config still byte-identical" || bad "post-full-session: static user config changed"
fi
grep -qi 'eml_brain' "$REALJSON" 2>/dev/null && info "control: eml_brain IS registered in real ~/.claude.json"

# shred injected token (best-effort)
if [ -f "$TOKEN_FILE" ]; then
  command -v shred >/dev/null 2>&1 && shred -u "$TOKEN_FILE" 2>/dev/null || rm -f "$TOKEN_FILE"
  info "token file $TOKEN_FILE removed"
fi

say
say "== SUMMARY ============================================================="
say "PASS: $pass   FAIL: $fail   (authed model probe: $([ "$AUTHED" = 1 ] && echo yes || echo no))"
say "artifacts: $BASE"
say "SCOPE: CLAUDE_CONFIG_DIR + --strict-mcp-config. NOT covered: OS-sandbox"
say "       (flag absent in $(claude --version 2>&1 | awk '{print $1}')) and macOS-keychain writes."
[ "$fail" -eq 0 ] && exit 0 || exit 1
