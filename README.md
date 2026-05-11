# claw-clean

Interactive session cleanup tool for [OpenClaw](https://openclaw.org).

## Features

- **TUI menu** with arrow-key navigation (inspired by `@clack/prompts`)
- **Selectable sessions** — each session listed with full UUID + identifier
- **Smooth cursor** — only updates changed lines, no full redraw
- **Space to toggle**, Enter to execute
- **Cleans trajectory companions** alongside selected sessions
- **Stale data cleanup** — `.deleted`, `.bak-*`, `archive/`
- **Cleans `sessions.json`** — removes deleted session references
- **Color-coded status** — OPEN (red), active (green), inactive (default)

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

When you select a session and press Enter:
- The `.jsonl` session file
- Its `.trajectory.jsonl` companion
- Its `.trajectory-path.json` companion
- Entry removed from `sessions.json`

When you select "Clean stale data":
- `.deleted.*` files + their trajectory companions
- `.bak-*` backup files
- `archive/` folder

## Requirements

- `bash` (4.0+)
- `trash-cli` (`pip install trash-cli`)
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
