# claw-clean

Interactive session cleanup tool for [OpenClaw](https://openclaw.org).

## Features

- **TUI menu** with arrow-key navigation (inspired by `@clack/prompts`)
- **Selectable sessions** — each session listed with full UUID + identifier
- **Orphaned session detection** — finds sessions in `sessions.json` with missing files (highlighted in yellow)
- **Smooth cursor** — only updates changed lines, no full redraw
- **Space to toggle**, Enter to execute
- **Auto-detected trash command** — works with `trash`, `trash-put`, or `gio trash`
- **Cleans trajectory companions** alongside selected sessions
- **Stale data cleanup** — `.deleted`, `.bak-*`, `archive/`
- **Cleans `sessions.json`** — removes deleted and orphaned session references
- **Color-coded status** — OPEN (red), active (green), orphaned (yellow), inactive (default)

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
claw-clean                # interactive menu
claw-clean -a dashboard   # target another agent
claw-clean -h             # help
```

### Interactive Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate sessions |
| `Space` | Toggle selection (○ ↔ ●) |
| `Enter` | Execute selected items |
| `q` / `Ctrl+C` | Quit without doing anything |

### What It Cleans

**Regular sessions:**
- The `.jsonl` session file
- Its `.trajectory.jsonl` companion
- Its `.trajectory-path.json` companion
- Entry removed from `sessions.json`

**Orphaned sessions** (in `sessions.json` but file missing):
- Entry removed from `sessions.json` only (no file to trash)

**Stale data:**
- `.deleted.*` files + their trajectory companions
- `.bak-*` backup files
- `archive/` folder

## Requirements

- `bash` (4.0+)
- One of: `trash` (trash-cli), `trash-put`, or `gio trash`
- `jq` (optional, for `sessions.json` cleanup)

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
