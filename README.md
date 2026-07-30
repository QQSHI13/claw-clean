# claw-clean

Interactive cleanup tool for [OpenClaw](https://openclaw.ai).

## Features

- **@clack/prompts TUI** — clean, robust menus with proper wrapping and cursor handling
- **New OpenClaw layout aware** — detects `agents/<agent>/agent/openclaw-agent.sqlite` and reads session counts from it (Node >=22)
- **Legacy session cleanup** — still cleans `agents/<agent>/sessions/` JSONL files, trajectory companions, and `sessions.json`
- **Legacy import archive cleanup** — removes `session-sqlite-import-archive/` folders left after SQLite migration
- **DB backup / temp cleanup** — removes `*.bak-*`, `*.sqlite-import.*.bak`, `*.tmp`, and reindex lock files
- **Stale data cleanup** — `.deleted`, `.bak-*`, `.reset-*`, `archive/`
- **Selectable sessions** — each session listed with full UUID + identifier
- **Space to toggle**, Enter to execute
- **Auto-detected trash command** — works with `trash`, `trash-put`, or `gio trash`
- **Color-coded status** — OPEN (red), active (green), orphaned (yellow), inactive (default)
- **Dry-run mode** — preview what would be deleted without touching anything

## Installation

```bash
npm install -g claw-clean
```

Or use directly:

```bash
npx claw-clean
```

## Usage

```bash
claw-clean                           # interactive menu (choose agent first)
claw-clean --agent <agent-id>        # skip the agent menu
claw-clean --dry-run                 # preview only; no files changed
claw-clean --doctor                  # check environment and dependencies
claw-clean -h                        # help
```

### Interactive Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate options |
| `Space` | Toggle selection |
| `Enter` | Submit selection |
| `Ctrl+C` | Cancel and quit |

After cleaning an agent, the tool loops back to the agent menu. Choose **Done** to exit.

### Audit log

Every deletion is appended to the audit log with an ISO timestamp:

- Default: `$XDG_STATE_HOME/claw-clean/log` (falls back to `~/.local/state/claw-clean/log`)

### Safety

- Failed trash operations are retried once before reporting an error.
- Run `claw-clean --dry-run` to see exactly what would be deleted.
- Run `claw-clean --doctor` to verify Node.js, trash command, and directory permissions.
- SQLite sessions are shown for visibility but are **not** deleted by this tool; use `openclaw sessions cleanup` for safe SQLite session pruning.

### What It Cleans

**Agent database (read-only display):**
- `agents/<agent>/agent/openclaw-agent.sqlite` size and session count
- Session details are loaded from the `session_nodes` table when `node:sqlite` is available

**Regular legacy sessions:**
- The `.jsonl` session file
- Its `.trajectory.jsonl` companion
- Its `.trajectory-path.json` companion
- Entry removed from `sessions.json`

**Orphaned sessions** (in `sessions.json` but file missing):
- Entry removed from `sessions.json` only (no file to trash)

**Stale data:**
- `.deleted.*` files + their trajectory companions
- `.bak-*` backup files
- `.reset.*` reset snapshot files
- `archive/` folder

**Legacy import archives:**
- Entire `session-sqlite-import-archive/` folder for an agent

**DB backups & temp files:**
- `openclaw-agent.sqlite.bak-*`
- `*.sqlite-import.*.bak`
- `*.tmp`
- `openclaw-agent.sqlite.reindex-lock.sqlite`

**Whole agent:**
- Delete the entire `agents/<agent>/` directory

## Requirements

- Node.js `>=18.0.0`
- One of: `trash` (trash-cli), `trash-put`, or `gio trash`
- Optional: Node.js `>=22.0.0` for SQLite session inspection via `node:sqlite`

## License

GPL-3.0

## Star History

<a href="https://www.star-history.com/?repos=QQSHI13%2Fclaw-clean&type=date&legend=top-left">
 <picture>
 <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=QQSHI13/claw-clean&type=date&theme=dark&legend=top-left" />
 <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=QQSHI13/claw-clean&type=date&legend=top-left" />
 <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=QQSHI13/claw-clean&type=date&legend=top-left" />
 </picture>
</a>
