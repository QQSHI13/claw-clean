#!/usr/bin/env bash
# Session Cleanup Tool — @clack/prompts-style TUI in pure bash
# Usage: clean-sessions.sh [-a agent] [-h]
#
# Features:
#   • Smooth cursor movement — only updates changed lines, no full redraw
#   • Each session is selectable with full ID + identifier displayed
#   • "Clean stale data" option for .deleted, .bak-*, and archive/
#   • Trajectory companions are cleaned alongside selected sessions

set -euo pipefail

AGENT_ID="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--agent)
      [[ -n "${2:-}" ]] || { echo "Error: --agent requires a value" >&2; exit 1; }
      AGENT_ID="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Session Cleanup Tool

Usage: clean-sessions.sh [-a agent] [-h]

Flags:
  -a, --agent <id>   Target agent (default: main)
  -h, --help         Show this help

Interactive controls:
  ↑ / ↓     Navigate options
  Space     Toggle selection
  Enter     Execute selected items
  q / Ctrl+C  Quit without doing anything

The menu shows each session (with ID + identifier) + a stale-data option.
Select what you want to clean, then press Enter.
EOF
      exit 0
      ;;
    *) echo "Error: Unknown flag: $1. Use -h for help." >&2; exit 1 ;;
  esac
done

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
SESSION_DIR="$STATE_DIR/agents/$AGENT_ID/sessions"
ARCHIVE_DIR="$SESSION_DIR/archive"

# ── Colors ──────────────────────────────────────────────────────────
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  _B=$(printf '\033[1m');  _D=$(printf '\033[2m');  _N=$(printf '\033[0m')
  _R=$(printf '\033[31m'); _G=$(printf '\033[32m'); _Y=$(printf '\033[33m')
  _C=$(printf '\033[36m')
else
  _B=''; _D=''; _N=''; _R=''; _G=''; _Y=''; _C=''
fi

# ── Helpers ─────────────────────────────────────────────────────────
die() { printf "%sError:%s %s\n" "$_R" "$_N" "$1" >&2; exit 1; }
info() { printf "%s→%s %s\n" "$_G" "$_N" "$1"; }
warn() { printf "%s⚠%s %s\n" "$_Y" "$_N" "$1"; }

fmt() {
  local b=$1
  if command -v numfmt &>/dev/null; then numfmt --to=iec-i --suffix=B "$b"
  else echo "${b}B"; fi
}

age_days() {
  local m=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)
  echo $(( ($(date +%s) - m) / 86400 ))
}

sess_status() {
  local id=$1 f="$SESSION_DIR/${id}.jsonl"
  local s="inactive"
  [[ -f "$SESSION_DIR/sessions.json" ]] && grep -q "\"$id\"" "$SESSION_DIR/sessions.json" 2>/dev/null && s="active"
  [[ -f "$f.lock" ]] && s="OPEN"
  echo "$s"
}

# Get session identifier (key) from sessions.json by sessionId
sess_key() {
  local id=$1
  if [[ -f "$SESSION_DIR/sessions.json" ]] && command -v jq &>/dev/null; then
    jq -r --arg sid "$id" 'to_entries[] | select(.value.sessionId == $sid) | .key' "$SESSION_DIR/sessions.json" 2>/dev/null | head -1
  else
    echo ""
  fi
}

list_sessions() {
  for f in "$SESSION_DIR"/*.jsonl; do
    [[ -f "$f" ]] || continue
    [[ "$f" == *.trajectory.jsonl ]] && continue
    [[ "$f" == *.bak* ]] && continue
    local bn=$(basename "$f")
    [[ "$bn" == .* ]] && continue
    [[ "$bn" == *.checkpoint.* ]] && continue
    [[ "$bn" == *.deleted.* ]] && continue
    echo "$f"
  done
}

# ── Data gathering ─────────────────────────────────────────────────
declare -a SESS_FILES=()
declare -a SESS_IDS=()
declare -a SESS_KEYS=()
declare -a SESS_SIZES=()
declare -a SESS_AGES=()
declare -a SESS_STATUS=()
declare -a SESS_SELECTED=()

gather_data() {
  S_COUNT=0 S_SIZE=0 OPEN_C=0 ACTIVE_C=0
  STALE_COUNT=0 STALE_SIZE=0

  SESS_FILES=()
  SESS_IDS=()
  SESS_KEYS=()
  SESS_SIZES=()
  SESS_AGES=()
  SESS_STATUS=()
  SESS_SELECTED=()

  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    local sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)
    local id=$(basename "$f" .jsonl)
    local st=$(sess_status "$id")
    local ag=$(age_days "$f")
    local key=$(sess_key "$id")

    SESS_FILES+=("$f")
    SESS_IDS+=("$id")
    SESS_KEYS+=("$key")
    SESS_SIZES+=("$sz")
    SESS_AGES+=("$ag")
    SESS_STATUS+=("$st")
    SESS_SELECTED+=("false")

    S_SIZE=$((S_SIZE + sz)); S_COUNT=$((S_COUNT + 1))
    [[ "$st" == "OPEN" ]] && OPEN_C=$((OPEN_C + 1))
    [[ "$st" == "active" ]] && ACTIVE_C=$((ACTIVE_C + 1))
  done < <(list_sessions)

  # .deleted files + their companions
  for f in "$SESSION_DIR"/*.deleted.*; do
    [[ -f "$f" ]] || continue
    local sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)
    STALE_SIZE=$((STALE_SIZE + sz)); STALE_COUNT=$((STALE_COUNT + 1))

    local bn=$(basename "$f")
    local baseid="${bn%%.jsonl.deleted.*}"

    local tjf="$SESSION_DIR/${baseid}.trajectory.jsonl"
    if [[ -f "$tjf" ]]; then
      local tsz=$(stat -c %s "$tjf" 2>/dev/null || stat -f %z "$tjf" 2>/dev/null)
      STALE_SIZE=$((STALE_SIZE + tsz)); STALE_COUNT=$((STALE_COUNT + 1))
    fi

    local tpjf="$SESSION_DIR/${baseid}.trajectory-path.json"
    if [[ -f "$tpjf" ]]; then
      local psz=$(stat -c %s "$tpjf" 2>/dev/null || stat -f %z "$tpjf" 2>/dev/null)
      STALE_SIZE=$((STALE_SIZE + psz)); STALE_COUNT=$((STALE_COUNT + 1))
    fi
  done

  # Backup files
  for f in "$SESSION_DIR"/*.bak*; do
    [[ -f "$f" ]] || continue
    local sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)
    STALE_SIZE=$((STALE_SIZE + sz)); STALE_COUNT=$((STALE_COUNT + 1))
  done

  # Archive folder
  if [[ -d "$ARCHIVE_DIR" ]]; then
    for f in "$ARCHIVE_DIR"/*; do
      [[ -f "$f" ]] || continue
      local sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)
      STALE_SIZE=$((STALE_SIZE + sz)); STALE_COUNT=$((STALE_COUNT + 1))
    done
  fi
}

# ── TUI helpers ───────────────────────────────────────────────────
hide_cursor() { printf '\033[?25l'; }
show_cursor() { printf '\033[?25h'; }

# Menu layout:
#   line 0: blank
#   line 1: ? Select...
#   line 2: blank
#   line 3..3+S_COUNT-1: session items
#   line 3+S_COUNT: stale option
#   line 3+S_COUNT+1: blank
#   line 3+S_COUNT+2: hint
#   line 3+S_COUNT+3: cursor here (after \n of hint)
#
# From cursor to first item (line 3): up by S_COUNT + 3 lines

MENU_BASE_UP=0  # set after gather_data

move_to_item() {
  local idx=$1
  printf '\033[%dA\r' "$((MENU_BASE_UP - idx))"
}

move_to_bottom_from() {
  local idx=$1
  printf '\033[%dB' "$((MENU_BASE_UP - idx))"
}

# Update just the prefix + symbol of a menu item (no full redraw)
update_item_symbol() {
  local idx=$1
  local prefix=$2   # "> " or "  "

  move_to_item "$idx"

  if [[ $idx -lt $S_COUNT ]]; then
    local symbol="○"
    [[ "${SESS_SELECTED[$idx]}" == "true" ]] && symbol="●"
    printf "%s%s " "$prefix" "$symbol"
  else
    local symbol="○"
    [[ "$sel_stale" == true ]] && symbol="●"
    printf "%s%s " "$prefix" "$symbol"
  fi

  move_to_bottom_from "$idx"
}

# ── Print header (static, never redrawn) ────────────────────────
print_header() {
  printf "\n"
  printf "%sSession Cleanup%s — Agent: %s%s%s\n" "$_B" "$_N" "$_C" "$AGENT_ID" "$_N"
  printf "\n"
  printf "  Sessions: %s%d%s (%s%d active%s, %s%d open%s)  %s\n" \
    "$_B" "$S_COUNT" "$_N" "$_G" "$ACTIVE_C" "$_N" "$_R" "$OPEN_C" "$_N" "$(fmt $S_SIZE)"
  printf "\n"
}

# ── Initial menu render (printed once) ────────────────────────────
cursor=0
sel_stale=false

render_menu() {
  printf "\n"
  printf "%s? Select sessions / cleanup actions:%s\n" "$_B" "$_N"
  printf "\n"

  # Session items
  for i in $(seq 0 $((S_COUNT - 1))); do
    local id="${SESS_IDS[$i]}"
    local key="${SESS_KEYS[$i]}"
    local sz="${SESS_SIZES[$i]}"
    local ag="${SESS_AGES[$i]}"
    local st="${SESS_STATUS[$i]}"
    local sel="${SESS_SELECTED[$i]}"

    local prefix="  "
    [[ $cursor -eq $i ]] && prefix="${_C}>${_N} "

    local symbol="○"
    [[ "$sel" == "true" ]] && symbol="●"

    local st_color=""
    [[ "$st" == "OPEN" ]] && st_color="$_R"
    [[ "$st" == "active" ]] && st_color="$_G"

    # Display: symbol + UUID + identifier (dimmed) + size + age + status
    local line=""
    line+="${prefix}"
    line+="${symbol} "
    line+="${id} "
    if [[ -n "$key" ]]; then
      line+="${_D}${key}${_N} "
    fi
    line+="${_D}$(fmt $sz)${_N} "
    line+="(${ag}d, ${st_color}${st}${_N})"
    printf "%s\n" "$line"
  done

  # Stale option
  local stale_idx=$S_COUNT
  local prefix="  "
  [[ $cursor -eq $stale_idx ]] && prefix="${_C}>${_N} "

  local symbol="○"
  [[ "$sel_stale" == true ]] && symbol="●"

  local hint=""
  if [[ $STALE_COUNT -gt 0 ]]; then
    hint="${_D}($(fmt $STALE_SIZE))${_N}"
  else
    hint="${_D}(none)${_N}"
  fi

  printf "%s%s Clean stale data (.deleted, backups, archive) %s\n" \
    "$prefix" "$symbol" "$hint"

  printf "\n"
  printf "  %s↑↓ navigate  Space toggle  Enter execute  q quit%s\n" "$_D" "$_N"
}

# ── Read key (with timeout to handle rapid keypresses) ─────────────
read_key() {
  local key

  # Read first byte
  IFS= read -rs -n1 key

  # If escape character, try to read the full escape sequence
  if [[ "$key" == $'\x1b' ]]; then
    local rest
    # Try to read up to 2 more bytes with short timeout (10ms).
    # If the user pressed another key mid-sequence, this prevents
    # blocking and interleaving.
    if IFS= read -rs -t 0.01 -n2 rest 2>/dev/null; then
      key="$key$rest"
    fi
  fi

  # Use printf (not echo) to avoid interpreting escape sequences
  printf '%s' "$key"
}

# ── Execute selected ──────────────────────────────────────────────
execute_selected() {
  local did_something=false
  local total_trashed=0
  local total_size=0

  # Trash selected sessions + their trajectory companions
  for i in $(seq 0 $((S_COUNT - 1))); do
    [[ "${SESS_SELECTED[$i]}" == "true" ]] || continue

    local f="${SESS_FILES[$i]}"
    local id="${SESS_IDS[$i]}"
    local sz="${SESS_SIZES[$i]}"

    printf "\n%sTrashing session %s%s%s (%s)%s\n" "$_B" "$_C" "$id" "$_N" "$(fmt $sz)" "$_N"
    command -v trash &>/dev/null || die "trash-cli not installed. pip install trash-cli"

    # Main session file
    trash "$f"
    total_trashed=$((total_trashed + 1))
    total_size=$((total_size + sz))

    # Trajectory file
    local tjf="$SESSION_DIR/${id}.trajectory.jsonl"
    if [[ -f "$tjf" ]]; then
      local tsz=$(stat -c %s "$tjf" 2>/dev/null || stat -f %z "$tjf" 2>/dev/null)
      trash "$tjf"
      total_size=$((total_size + tsz))
    fi

    # Trajectory-path file
    local tpjf="$SESSION_DIR/${id}.trajectory-path.json"
    if [[ -f "$tpjf" ]]; then
      local psz=$(stat -c %s "$tpjf" 2>/dev/null || stat -f %z "$tpjf" 2>/dev/null)
      trash "$tpjf"
      total_size=$((total_size + psz))
    fi

    # Remove from sessions.json
    if [[ -f "$SESSION_DIR/sessions.json" ]] && command -v jq &>/dev/null; then
      local tmpjson=$(mktemp)
      jq --arg sid "$id" 'with_entries(select(.value.sessionId != $sid))' \
        "$SESSION_DIR/sessions.json" > "$tmpjson" 2>/dev/null && mv "$tmpjson" "$SESSION_DIR/sessions.json"
    fi

    did_something=true
  done

  # Clean stale data
  if [[ "$sel_stale" == true ]]; then
    if [[ $STALE_COUNT -gt 0 ]]; then
      printf "\n%sCleaning stale data%s — %d items, %s\n" "$_B" "$_N" "$STALE_COUNT" "$(fmt $STALE_SIZE)"
      command -v trash &>/dev/null || die "trash-cli not installed. pip install trash-cli"

      # .deleted files + companions
      for f in "$SESSION_DIR"/*.deleted.*; do
        [[ -f "$f" ]] || continue
        trash "$f"
        total_trashed=$((total_trashed + 1))

        local bn=$(basename "$f")
        local baseid="${bn%%.jsonl.deleted.*}"

        local tjf="$SESSION_DIR/${baseid}.trajectory.jsonl"
        if [[ -f "$tjf" ]]; then
          trash "$tjf"
          total_trashed=$((total_trashed + 1))
        fi

        local tpjf="$SESSION_DIR/${baseid}.trajectory-path.json"
        if [[ -f "$tpjf" ]]; then
          trash "$tpjf"
          total_trashed=$((total_trashed + 1))
        fi
      done

      # Backup files
      for f in "$SESSION_DIR"/*.bak*; do
        [[ -f "$f" ]] || continue
        trash "$f"
        total_trashed=$((total_trashed + 1))
      done

      # Archive folder
      if [[ -d "$ARCHIVE_DIR" ]]; then
        trash "$ARCHIVE_DIR"
      fi

      # Clean sessions.json of deleted session references
      if [[ -f "$SESSION_DIR/sessions.json" ]] && command -v jq &>/dev/null; then
        local tmpjson=$(mktemp)
        local ids=()
        for f in "$SESSION_DIR"/*.deleted.*; do
          [[ -f "$f" ]] || continue
          local bn=$(basename "$f")
          local baseid="${bn%%.jsonl.deleted.*}"
          ids+=("$baseid")
        done

        if [[ ${#ids[@]} -gt 0 ]]; then
          local filter="with_entries(select([.value.sessionId] | inside(["
          local first=true
          for id in "${ids[@]}"; do
            [[ "$first" == true ]] || filter+=","
            filter+="\"$id\""
            first=false
          done
          filter+="]) | not))"

          jq "$filter" "$SESSION_DIR/sessions.json" > "$tmpjson" 2>/dev/null && mv "$tmpjson" "$SESSION_DIR/sessions.json"
        fi
      fi

      did_something=true
    else
      printf "\n%sNo stale data to clean.%s\n" "$_Y" "$_N"
    fi
  fi

  if [[ "$did_something" == true ]]; then
    printf "\n%sDone.%s Trashed %d items (%s total).\n" "$_G" "$_N" "$total_trashed" "$(fmt $total_size)"
  else
    printf "\n%sNothing selected.%s\n" "$_Y" "$_N"
  fi
}

# ── Main ──────────────────────────────────────────────────────────
[[ -d "$SESSION_DIR" ]] || die "No session directory: $SESSION_DIR"

gather_data
MENU_BASE_UP=$((S_COUNT + 3))

# Hide cursor, trap to restore
trap 'show_cursor' EXIT INT TERM
hide_cursor

# Print static header + table
print_header

# Initial menu render
render_menu

# Input loop — smooth updates, no full redraw
while true; do
  key=$(read_key)

  case "$key" in
    $'\x1b[A')  # Up
      if [[ $cursor -gt 0 ]]; then
        old_cursor=$cursor
        cursor=$((cursor - 1))
        update_item_symbol "$old_cursor" "  "
        update_item_symbol "$cursor" "> "
      fi
      ;;
    $'\x1b[B')  # Down
      total_items=$((S_COUNT + 1))
      if [[ $cursor -lt $((total_items - 1)) ]]; then
        old_cursor=$cursor
        cursor=$((cursor + 1))
        update_item_symbol "$old_cursor" "  "
        update_item_symbol "$cursor" "> "
      fi
      ;;
    ' '|$'\x20')  # Space
      if [[ $cursor -lt $S_COUNT ]]; then
        if [[ "${SESS_SELECTED[$cursor]}" == "true" ]]; then
          SESS_SELECTED[$cursor]="false"
        else
          SESS_SELECTED[$cursor]="true"
        fi
        update_item_symbol "$cursor" "> "
      else
        [[ "$sel_stale" == true ]] && sel_stale=false || sel_stale=true
        update_item_symbol "$cursor" "> "
      fi
      ;;
    ''|$'\x0a'|$'\x0d')  # Enter
      printf '\n\n'
      execute_selected
      exit 0
      ;;
    'q'|'Q'|$'\x03')  # q or Ctrl+C
      exit 0
      ;;
    *)
      continue
      ;;
  esac
done
