#!/usr/bin/env bash
# Session Cleanup Tool — @clack/prompts-style TUI in pure bash
# Version: 1.1.2
# Usage: claw-clean [-a agent] [-h]
#
# Features:
#   • Smooth cursor movement — only updates changed lines, no full redraw
#   • Orphaned session detection — sessions in sessions.json with no file
#   • Auto-detected trash command — trash, trash-put, gio trash
#   • Trajectory companions cleaned alongside selected sessions

set -euo pipefail

AGENT_ID="main"

# ── Detect trash command early ─────────────────────────────────────
TRASH_CMD=()
for cmd in trash trash-put "gio trash"; do
  if [[ "$cmd" == *" "* ]]; then
    local first="${cmd%% *}" rest="${cmd#* }"
    if command -v "$first" &>/dev/null; then
      TRASH_CMD=("$first" "$rest")
      break
    fi
  elif command -v "$cmd" &>/dev/null; then
    TRASH_CMD=("$cmd")
    break
  fi
done

# ── Argument parsing ──────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|--agent)
      [[ -n "${2:-}" ]] || { echo "Error: --agent requires a value" >&2; exit 1; }
      AGENT_ID="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Session Cleanup Tool

Usage: claw-clean [-a agent] [-h]

Flags:
  -a, --agent <id>   Target agent (default: main)
  -h, --help         Show this help

Interactive controls:
  ↑ / ↓     Navigate options
  Space     Toggle selection
  Enter     Execute selected items (with confirmation)
  q         Quit without doing anything
  Ctrl+C    Interrupt and quit
EOF
      exit 0
      ;;
    *) echo "Error: Unknown flag: $1. Use -h for help." >&2; exit 1 ;;
  esac
done

# ── Validate requirements ───────────────────────────────────────────
[[ ${#TRASH_CMD[@]} -gt 0 ]] || { echo "Error: No trash command found. Install trash-cli: pip install trash-cli" >&2; exit 1; }

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
SESSION_DIR="$STATE_DIR/agents/$AGENT_ID/sessions"
ARCHIVE_DIR="$SESSION_DIR/archive"

[[ -d "$SESSION_DIR" ]] || { echo "Error: No session directory: $SESSION_DIR" >&2; exit 1; }

# ── Colors ────────────────────────────────────────────────────────
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  _B=$(printf '\033[1m');  _D=$(printf '\033[2m');  _N=$(printf '\033[0m')
  _R=$(printf '\033[31m'); _G=$(printf '\033[32m'); _Y=$(printf '\033[33m')
  _C=$(printf '\033[36m')
else
  _B=''; _D=''; _N=''; _R=''; _G=''; _Y=''; _C=''
fi

# ── Helpers ───────────────────────────────────────────────────────
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

sess_key() {
  local id=$1
  if [[ -f "$SESSION_DIR/sessions.json" ]] && command -v jq &>/dev/null; then
    jq -r --arg sid "$id" 'to_entries[] | select(.value.sessionId == $sid) | .key' "$SESSION_DIR/sessions.json" 2>/dev/null | head -1
  else
    echo ""
  fi
}

sess_file_exists() {
  local id=$1
  [[ -f "$SESSION_DIR/${id}.jsonl" ]]
}

list_sessions() {
  shopt -s nullglob
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
  shopt -u nullglob
}

# ── Data gathering ────────────────────────────────────────────────
declare -a SESS_FILES=()
declare -a SESS_IDS=()
declare -a SESS_KEYS=()
declare -a SESS_SIZES=()
declare -a SESS_AGES=()
declare -a SESS_STATUS=()
declare -a SESS_SELECTED=()

declare -a ORPHAN_IDS=()
declare -a ORPHAN_KEYS=()
declare -a ORPHAN_SELECTED=()

# Line position tracking — exact line number of each item in render_menu
declare -a ITEM_LINE=()
MENU_BASE_UP=0

gather_data() {
  S_COUNT=0 S_SIZE=0 OPEN_C=0 ACTIVE_C=0
  STALE_COUNT=0 STALE_SIZE=0
  ORPHAN_COUNT=0

  SESS_FILES=(); SESS_IDS=(); SESS_KEYS=(); SESS_SIZES=()
  SESS_AGES=(); SESS_STATUS=(); SESS_SELECTED=()

  ORPHAN_IDS=(); ORPHAN_KEYS=(); ORPHAN_SELECTED=()
  ITEM_LINE=()

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

  # Find orphaned sessions
  if [[ -f "$SESSION_DIR/sessions.json" ]] && command -v jq &>/dev/null; then
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      [[ "$id" != "null" ]] || continue
      if ! sess_file_exists "$id"; then
        local key=$(sess_key "$id")
        ORPHAN_IDS+=("$id")
        ORPHAN_KEYS+=("$key")
        ORPHAN_SELECTED+=("false")
        ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
      fi
    done < <(jq -r 'to_entries[] | select(.value.sessionId != null) | .value.sessionId' "$SESSION_DIR/sessions.json" 2>/dev/null)
  fi

  # Stale data counting
  for f in "$SESSION_DIR"/*.deleted.*; do
    [[ -f "$f" ]] || continue
    local sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)
    STALE_SIZE=$((STALE_SIZE + sz)); STALE_COUNT=$((STALE_COUNT + 1))

    local bn=$(basename "$f")
    local baseid="${bn%%.jsonl.deleted.*}"

    local tjf="$SESSION_DIR/${baseid}.trajectory.jsonl"
    if [[ -f "$tjf" ]]; then
      local tsz=$(stat -c %s "$tjf" 2>/dev/null || stat -f %z "$tjf" 2>/dev/null)
      STALE_SIZE=$((STALE_SIZE + tsz))
    fi

    local tpjf="$SESSION_DIR/${baseid}.trajectory-path.json"
    if [[ -f "$tpjf" ]]; then
      local psz=$(stat -c %s "$tpjf" 2>/dev/null || stat -f %z "$tpjf" 2>/dev/null)
      STALE_SIZE=$((STALE_SIZE + psz))
    fi
  done

  for f in "$SESSION_DIR"/*.bak*; do
    [[ -f "$f" ]] || continue
    local sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)
    STALE_SIZE=$((STALE_SIZE + sz)); STALE_COUNT=$((STALE_COUNT + 1))
  done

  if [[ -d "$ARCHIVE_DIR" ]]; then
    shopt -s nullglob
    for f in "$ARCHIVE_DIR"/*; do
      [[ -f "$f" ]] || continue
      local sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)
      STALE_SIZE=$((STALE_SIZE + sz)); STALE_COUNT=$((STALE_COUNT + 1))
    done
    shopt -u nullglob
  fi

  # Build ITEM_LINE mapping: item index -> line offset from first item
  # render_menu layout:
  #   line 0: blank
  #   line 1: "? Select..."
  #   line 2: blank
  #   line 3..3+S_COUNT-1: sessions
  #   [if orphans:]
  #     line 3+S_COUNT: blank
  #     line 3+S_COUNT+1: "? Orphaned..."
  #     line 3+S_COUNT+2: blank
  #     line 3+S_COUNT+3 .. +3+ORPHAN_COUNT-1: orphans
  #   line after orphans/sessions: blank
  #   next: stale option
  #   next: blank
  #   next: hint (cursor sits here)
  
  local line=0
  for ((i=0; i<S_COUNT; i++)); do
    ITEM_LINE[$i]=$line
    line=$((line + 1))
  done
  
  if [[ $ORPHAN_COUNT -gt 0 ]]; then
    line=$((line + 3))  # blank + header + blank
    for ((i=0; i<ORPHAN_COUNT; i++)); do
      local idx=$((S_COUNT + i))
      ITEM_LINE[$idx]=$line
      line=$((line + 1))
    done
  fi
  
  # Stale option
  local stale_idx=$((S_COUNT + ORPHAN_COUNT))
  line=$((line + 1))  # blank before stale
  ITEM_LINE[$stale_idx]=$line
  
  # Lines from first item to cursor (after hint line)
  # After stale: blank + hint = 2 more lines
  # Add 1 extra because cursor sits on hint line, and we need to move from cursor to first item
  MENU_BASE_UP=$((line + 3))
}

# ── TUI helpers ───────────────────────────────────────────────────
hide_cursor() { printf '\033[?25l'; }
show_cursor() { printf '\033[?25h'; }

move_to_item() {
  local idx=$1
  local offset=${ITEM_LINE[$idx]}
  printf '\033[%dA\r' "$((MENU_BASE_UP - offset))"
}

move_to_bottom_from() {
  local idx=$1
  local offset=${ITEM_LINE[$idx]}
  printf '\033[%dB' "$((MENU_BASE_UP - offset))"
}

update_item_symbol() {
  local idx=$1
  local prefix=$2

  move_to_item "$idx"

  if [[ $idx -lt $S_COUNT ]]; then
    local symbol="○"
    [[ "${SESS_SELECTED[$idx]}" == "true" ]] && symbol="●"
    printf "%s%s " "$prefix" "$symbol"
  elif [[ $idx -lt $((S_COUNT + ORPHAN_COUNT)) ]]; then
    local oidx=$((idx - S_COUNT))
    local symbol="○"
    [[ "${ORPHAN_SELECTED[$oidx]}" == "true" ]] && symbol="●"
    printf "%s%s " "$prefix" "$symbol"
  else
    local symbol="○"
    [[ "$sel_stale" == true ]] && symbol="●"
    printf "%s%s " "$prefix" "$symbol"
  fi

  move_to_bottom_from "$idx"
}

print_header() {
  printf "\n"
  printf "%sSession Cleanup%s — Agent: %s%s%s\n" "$_B" "$_N" "$_C" "$AGENT_ID" "$_N"
  printf "\n"
  printf "  Sessions: %s%d%s (%s%d active%s, %s%d open%s)  %s\n" \
    "$_B" "$S_COUNT" "$_N" "$_G" "$ACTIVE_C" "$_N" "$_R" "$OPEN_C" "$_N" "$(fmt $S_SIZE)"
  [[ $ORPHAN_COUNT -gt 0 ]] && printf "  %sOrphaned: %d%s (in sessions.json but no file)\n" "$_Y" "$ORPHAN_COUNT" "$_N"
  printf "\n"
}

cursor=0
sel_stale=false

render_menu() {
  printf "\n"
  printf "%s? Select sessions / cleanup actions:%s\n" "$_B" "$_N"
  printf "\n"

  for ((i=0; i<S_COUNT; i++)); do
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

    printf "%s%s %s " "$prefix" "$symbol" "$id"
    [[ -n "$key" ]] && printf "%s%s%s " "$_D" "$key" "$_N"
    printf "%s%s%s (%sd, %s%s%s)\n" "$_D" "$(fmt $sz)" "$_N" "$ag" "$st_color" "$st" "$_N"
  done

  if [[ $ORPHAN_COUNT -gt 0 ]]; then
    printf "\n"
    printf "%s? Orphaned sessions (in sessions.json, file missing):%s\n" "$_Y" "$_N"
    printf "\n"
    for ((i=0; i<ORPHAN_COUNT; i++)); do
      local idx=$((S_COUNT + i))
      local id="${ORPHAN_IDS[$i]}"
      local key="${ORPHAN_KEYS[$i]}"
      local sel="${ORPHAN_SELECTED[$i]}"

      local prefix="  "
      [[ $cursor -eq $idx ]] && prefix="${_C}>${_N} "

      local symbol="○"
      [[ "$sel" == "true" ]] && symbol="●"

      printf "%s%s %s%s%s " "$prefix" "$symbol" "$_Y" "$id" "$_N"
      [[ -n "$key" ]] && printf "%s%s%s " "$_D" "$key" "$_N"
      printf "%s(orphaned)%s\n" "$_D" "$_N"
    done
  fi

  local stale_idx=$((S_COUNT + ORPHAN_COUNT))
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

  printf "\n"
  printf "%s%s Clean stale data (.deleted, backups, archive) %s\n" \
    "$prefix" "$symbol" "$hint"

  printf "\n"
  printf "  %s↑↓ navigate  Space toggle  Enter execute  q quit%s\n" "$_D" "$_N"
}

read_key() {
  local key
  IFS= read -rs -n1 key
  if [[ "$key" == $'\x1b' ]]; then
    local rest=""
    for _ in {1..3}; do
      if IFS= read -rs -t 0.02 -n1 next 2>/dev/null; then
        rest+="$next"
        [[ ${#rest} -eq 2 ]] && break
      fi
    done
    key="$key$rest"
  fi
  printf '%s' "$key"
}

trash_file() {
  local f="$1"
  "${TRASH_CMD[@]}" "$f"
}

execute_selected() {
  local did_something=false
  local total_trashed=0
  local total_size=0
  local has_open=false

  # Check if any OPEN sessions selected
  for ((i=0; i<S_COUNT; i++)); do
    [[ "${SESS_SELECTED[$i]}" == "true" ]] || continue
    [[ "${SESS_STATUS[$i]}" == "OPEN" ]] && has_open=true
  done

  # Confirmation prompt
  local selected_count=0
  for ((i=0; i<S_COUNT; i++)); do
    [[ "${SESS_SELECTED[$i]}" == "true" ]] && selected_count=$((selected_count + 1))
  done
  for ((i=0; i<ORPHAN_COUNT; i++)); do
    [[ "${ORPHAN_SELECTED[$i]}" == "true" ]] && selected_count=$((selected_count + 1))
  done
  [[ "$sel_stale" == true ]] && selected_count=$((selected_count + 1))

  if [[ $selected_count -eq 0 ]]; then
    printf "\n%sNothing selected.%s\n" "$_Y" "$_N"
    return
  fi

  printf "\n%s%d item(s) selected for cleanup.%s" "$_B" "$selected_count" "$_N"
  [[ "$has_open" == true ]] && printf " %s(WARNING: open sessions selected)%s" "$_R" "$_N"
  printf "\n%sProceed? [y/N]:%s " "$_D" "$_N"
  show_cursor
  local confirm
  read -r confirm
  hide_cursor
  [[ "$confirm" == [yY]* ]] || { printf "%sCancelled.%s\n" "$_Y" "$_N"; return; }

  for ((i=0; i<S_COUNT; i++)); do
    [[ "${SESS_SELECTED[$i]}" == "true" ]] || continue

    local f="${SESS_FILES[$i]}"
    local id="${SESS_IDS[$i]}"
    local sz="${SESS_SIZES[$i]}"

    printf "\n%sTrashing session %s%s%s (%s)%s\n" "$_B" "$_C" "$id" "$_N" "$(fmt $sz)" "$_N"

    trash_file "$f"
    total_trashed=$((total_trashed + 1))
    total_size=$((total_size + sz))

    local tjf="$SESSION_DIR/${id}.trajectory.jsonl"
    if [[ -f "$tjf" ]]; then
      local tsz=$(stat -c %s "$tjf" 2>/dev/null || stat -f %z "$tjf" 2>/dev/null)
      trash_file "$tjf"
      total_size=$((total_size + tsz))
    fi

    local tpjf="$SESSION_DIR/${id}.trajectory-path.json"
    if [[ -f "$tpjf" ]]; then
      local psz=$(stat -c %s "$tpjf" 2>/dev/null || stat -f %z "$tpjf" 2>/dev/null)
      trash_file "$tpjf"
      total_size=$((total_size + psz))
    fi

    if [[ -f "$SESSION_DIR/sessions.json" ]] && command -v jq &>/dev/null; then
      local tmpjson=$(mktemp)
      jq --arg sid "$id" 'with_entries(select(.value.sessionId != $sid))' \
        "$SESSION_DIR/sessions.json" > "$tmpjson" 2>/dev/null && mv "$tmpjson" "$SESSION_DIR/sessions.json"
    fi

    did_something=true
  done

  for ((i=0; i<ORPHAN_COUNT; i++)); do
    [[ "${ORPHAN_SELECTED[$i]}" == "true" ]] || continue

    local id="${ORPHAN_IDS[$i]}"
    printf "\n%sRemoving orphaned session %s%s%s from sessions.json%s\n" "$_B" "$_Y" "$id" "$_N" "$_N"

    if [[ -f "$SESSION_DIR/sessions.json" ]] && command -v jq &>/dev/null; then
      local tmpjson=$(mktemp)
      jq --arg sid "$id" 'with_entries(select(.value.sessionId != $sid))' \
        "$SESSION_DIR/sessions.json" > "$tmpjson" 2>/dev/null && mv "$tmpjson" "$SESSION_DIR/sessions.json"
      total_trashed=$((total_trashed + 1))
      did_something=true
    fi
  done

  if [[ "$sel_stale" == true ]]; then
    if [[ $STALE_COUNT -gt 0 ]]; then
      printf "\n%sCleaning stale data%s — %d items, %s\n" "$_B" "$_N" "$STALE_COUNT" "$(fmt $STALE_SIZE)"

      shopt -s nullglob
      for f in "$SESSION_DIR"/*.deleted.*; do
        [[ -f "$f" ]] || continue
        trash_file "$f"
        total_trashed=$((total_trashed + 1))

        local bn=$(basename "$f")
        local baseid="${bn%%.jsonl.deleted.*}"

        local tjf="$SESSION_DIR/${baseid}.trajectory.jsonl"
        if [[ -f "$tjf" ]]; then
          trash_file "$tjf"
          total_trashed=$((total_trashed + 1))
        fi

        local tpjf="$SESSION_DIR/${baseid}.trajectory-path.json"
        if [[ -f "$tpjf" ]]; then
          trash_file "$tpjf"
          total_trashed=$((total_trashed + 1))
        fi
      done
      shopt -u nullglob

      shopt -s nullglob
      for f in "$SESSION_DIR"/*.bak*; do
        [[ -f "$f" ]] || continue
        trash_file "$f"
        total_trashed=$((total_trashed + 1))
      done
      shopt -u nullglob

      if [[ -d "$ARCHIVE_DIR" ]]; then
        "${TRASH_CMD[@]}" "$ARCHIVE_DIR"
      fi

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
gather_data

TOTAL_ITEMS=$((S_COUNT + ORPHAN_COUNT + 1))

trap 'show_cursor' EXIT INT TERM
hide_cursor

print_header
render_menu

while true; do
  key=$(read_key)

  case "$key" in
    $'\x1b[A')
      if [[ $cursor -gt 0 ]]; then
        old_cursor=$cursor
        cursor=$((cursor - 1))
        update_item_symbol "$old_cursor" "  "
        update_item_symbol "$cursor" "${_C}>${_N} "
      fi
      ;;
    $'\x1b[B')
      if [[ $cursor -lt $((TOTAL_ITEMS - 1)) ]]; then
        old_cursor=$cursor
        cursor=$((cursor + 1))
        update_item_symbol "$old_cursor" "  "
        update_item_symbol "$cursor" "${_C}>${_N} "
      fi
      ;;
    ' '|$'\x20')
      if [[ $cursor -lt $S_COUNT ]]; then
        if [[ "${SESS_SELECTED[$cursor]}" == "true" ]]; then
          SESS_SELECTED[$cursor]="false"
        else
          SESS_SELECTED[$cursor]="true"
        fi
        update_item_symbol "$cursor" "${_C}>${_N} "
      elif [[ $cursor -lt $((S_COUNT + ORPHAN_COUNT)) ]]; then
        oidx=$((cursor - S_COUNT))
        if [[ "${ORPHAN_SELECTED[$oidx]}" == "true" ]]; then
          ORPHAN_SELECTED[$oidx]="false"
        else
          ORPHAN_SELECTED[$oidx]="true"
        fi
        update_item_symbol "$cursor" "${_C}>${_N} "
      else
        [[ "$sel_stale" == true ]] && sel_stale=false || sel_stale=true
        update_item_symbol "$cursor" "${_C}>${_N} "
      fi
      ;;
    ''|$'\x0a'|$'\x0d')
      printf '\n\n'
      execute_selected
      exit 0
      ;;
    'q'|'Q'|$'\x03')
      exit 0
      ;;
    *)
      continue
      ;;
  esac
done
