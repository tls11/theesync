# theesync

Safe **one-way** category-based library sync for the **HiFi Walker H2** (Rockbox dual-boot, typically FAT32 at `/Volumes/H2`).

**Node.js (ESM) CLI** + minimal **Tauri 2** desktop UI. Correctness and safety over cleverness: Rockbox and protected volume-root entries are never deleted or modified.

## Category layout (important)

The volume root is **not** a flat artist list. Managed content lives under allowlisted category folders:

```text
/Volumes/H2/
  .rockbox/          # NEVER touch
  .rockbox 2/        # NEVER touch
  .rockbox 3/        # NEVER touch
  update.upt         # NEVER touch
  Music/             # managed category
    Tool/
      Lateralus (2001)/
        01 - Schism.flac
    Nirvana/
    …
  Books/             # managed category
    Author/
      title.epub
      book.m4a       # source may be .m4b; written as .m4a
      cover.jpg      # baseline JPEG ≤500px (converted on write)
  Screenshots/       # unknown root → ignored (not deleted)
```

Each sync **job** is one mapping:

```text
source library tree  →  one category directory (e.g. /Volumes/H2/Music)
```

- **CLI:** one job per invocation  
- **UI:** job list; run selected jobs in sequence  

### Books job: dest-only transforms

Source files are **never modified**. When writing into `Books/`:

| Source | On H2 |
|--------|--------|
| `*.m4b` | Written as `*.m4a`; embedded cover re-encoded to H2-friendly JPEG |
| `*.m4a` | Embedded cover re-encoded when progressive/oversized |
| `*.jpg` / `*.jpeg` | **Baseline** JPEG, longest edge ≤ **500px** |
| Path / title text | Unicode folded to ASCII (e.g. `’` → `'`) so Rockbox/FAT32 render cleanly |

Covers are rewritten when an audiobook is **added/updated**, or when its **sidecar image** changes (same-name `.jpg` / `cover.jpg` / `folder.jpg`). Unchanged audiobooks are not re-inspected by default.

**Thorough covers** (`--thorough-covers` / UI checkbox): optional repair mode that re-checks embedded art on mtime-stable audiobooks (slower).

Rockbox cannot decode progressive JPEGs. Direct `sips` jpeg→jpeg can leave progressive encoding, so theesync goes through a PNG intermediate to force baseline. Audiobook tags are updated with **mutagen** (Python):

```bash
npm run vendor:mutagen   # once: pip install mutagen into vendor/py
```

### Migrating from root-level artists (legacy layout)

Older cards often look like:

```text
/Volumes/H2/
  .rockbox/
  update.upt
  Tool/          # artist at volume root — NOT managed
  Nirvana/
  …
```

theesync **only** manages allowlisted categories (`Music/`, `Books/`). Root-level artist folders are **ignored** (never deleted, never mirrored). To adopt the new layout:

1. Create `Music/` on the card if missing.  
2. Move root-level artist folders **into** `Music/` (e.g. `Tool/` → `Music/Tool/`). Leave `.rockbox*` and `update.upt` alone.  
3. Point a job: source = your Mac library, volume = `/Volumes/H2`, category = `Music`.  
4. **Dry run** first, then sync.  

Do **not** use bare `/Volumes/H2` as dest — refused so the tool never manages arbitrary root children.

## Requirements

- **Node.js ≥ 20** (CLI and UI engine — not embedded in the app)  
- **Rust** toolchain (desktop UI only, first build)  
- macOS-oriented paths (`/Volumes/…`); absolute paths work elsewhere  

```bash
cd /Users/theo/repos/theesync
npm install          # repo root (CLI)
cd app && npm install && cd ..   # UI (once)
npm test
```

## Daily use (recommended)

Fish functions (already set up for this machine):

| Command | What it does |
|---------|----------------|
| **`theesync`** | Starts the **desktop UI** (`npm run app:dev` in the background) |
| **`theesync-cli`** | Runs the **Node engine** (`bin/theesync.js`) |

```fish
theesync                 # open UI
theesync-cli --help
theesync-cli categories --json
theesync-cli plan -s ~/Music/library -d /Volumes/H2/Music --dry-run
```

UI log (if the window does not appear): `tail -f /tmp/theesync-app.log`

Without fish, from the repo:

```bash
npm run app:dev                          # UI
node bin/theesync.js plan -s … -d …      # CLI
```

## CLI

Entry: `node bin/theesync.js` or `theesync-cli`.

### One-shot (plan + apply, single scan)

```bash
theesync-cli --source ~/Music/library --dest /Volumes/H2/Music
theesync-cli -s ~/Documents/Ebooks -d /Volumes/H2/Books

# Dry-run (plan only)
theesync-cli -s ~/Music/library -d /Volumes/H2/Music --dry-run

# Category sugar (volume + category name)
theesync-cli -s ~/Music/library -d /Volumes/H2 --category Music
```

### Plan / apply split

```bash
theesync-cli plan -s … -d /Volumes/H2/Music -o /tmp/music.plan.json
theesync-cli plan -s … -d … --json-lines
theesync-cli apply -p /tmp/music.plan.json -v
```

### Commands

| Command | Purpose |
|---------|---------|
| `sync` (default) | Plan + apply in one process |
| `plan` | Scan/compare only; optional `--write-plan` |
| `apply` | Execute a plan file (no re-scan) |
| `categories` | Print allowlist (`--json` for `["Music","Books"]`) |

### Flags

| Flag | Meaning |
|------|---------|
| `-s, --source` | Source library tree |
| `-d, --dest` | Destination **category** dir (e.g. `/Volumes/H2/Music`) |
| `--category` | Sugar when `-d` is the volume root |
| `--dry-run` | Plan only; no writes |
| `--no-delete` | Skip **library** deletion phase (metadata cleanup still runs) |
| `--checksum` | When sizes match, compare SHA-256 |
| `--mtime-tolerance <ms>` | FAT32 mtime slop (default **3000**) |
| `--require-rockbox` | Fail if volume has no `.rockbox*` / `update.upt` |
| `--json-lines` | NDJSON events on stdout |
| `-v, --verbose` | Per-action log + macOS metadata cleanup details |
| `-o, --write-plan` | Write plan JSON |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | OK |
| 1 | Runtime / safety / apply failures |
| 2 | Usage (missing flags, bad options) |

### Event protocol (NDJSON)

With `--json-lines`, stdout is one JSON object per line. Every event has `schemaVersion: 1`, `type`, `ts`.

| type | Purpose |
|------|---------|
| `start` | phase, source, dest |
| `scan` | side, files, dirs |
| `plan` | add, update, delete (library), addFiles, addDirs, … |
| `action` | op, path (`-v` only; junk deletes tagged when verbose) |
| `progress` | done, total |
| `warning` / `error` / `info` | message |
| `summary` | added, updated, deleted (library), skipped, failed, dryRun |
| `done` | ok |

**Library vs junk:** `delete` / `deleted` count **library** paths only. macOS `._*` / `.DS_Store` cleanups run on apply but stay out of default logs and confirm counts unless **verbose**.

Fatal errors with `--json-lines` also emit `{ type: "error" }` and `{ type: "done", ok: false }`.

## Safety model

### Volume root — never touch

Volume root = parent of the category dest (e.g. `/Volumes/H2` for `/Volumes/H2/Music`).

Never mutated:

- Names starting with `.` (`.rockbox`, `.rockbox 2`, `.DS_Store`, `._*`, …)  
- `update.upt` (case-insensitive)  
- Non-allowlisted root folders (`Screenshots`, …) — **ignored, not deleted**  

### What may be written/deleted

Only paths **strictly inside** the job’s category directory (creating the category dir is OK).

Every mutation re-checks:

1. Path under dest (boundary-safe)  
2. Dest is allowlisted (`Music`, `Books` by default)  
3. Top-level volume segment is not protected  

Dangerous dests (`/`, home, bare `/Volumes`, source==dest, nested source/dest) are refused.

No `.rockbox*` / `update.upt` → soft warning; `--require-rockbox` hard-fails.

### macOS metadata on the card

On FAT32, macOS often creates AppleDouble **`._*`** next to files and **`.DS_Store`** in folders. They are not useful for Rockbox.

- **Source:** never copied  
- **Dest:** cleaned on sync (not mixed into main “delete” count)  
- **Logs:** silent by default; **Verbose** shows cleanup  

## Sync behavior

- **One-way:** source is truth for that job’s dest tree  
- **Change detection:** relative path + size; mtime ±3s; optional checksum  
- **Plan:** read-only; **apply:** no full re-scan; safety on every op  
- **Copy:** non-dot temp beside target → rename; preserve mtime  
- **Paths:** exact string match (no Unicode NFC); soft warn on non-ASCII  

## Desktop UI

Tauri 2 app under `app/`. Sync logic stays in Node; Rust handles dialogs, volume probe, spawn/kill, events.

### Run

```fish
theesync
# or: npm run app:dev
```

Needs **Node ≥ 20** and the repo’s `bin/theesync.js`.

### Behavior

- **Jobs:** source + **volume** (card root) + **category** dropdown → **Writes to** = `volume/category`  
- Categories loaded from the engine (`categories --json`); **Reload categories** after editing the allowlist  
- Persist jobs/toggles in `localStorage`  
- Per-job Rockbox badge on the volume  
- Toggles: **No delete**, **Checksum**, **Require Rockbox markers**  
- **Dry run selected** / **Sync selected** (batch; cancel aborts remaining jobs)  
- Sync confirm only when **library** deletes &gt; 0  
- Log: Copy, Clear, **Verbose**  

```text
app/
  src/           # HTML/CSS/JS
  src-tauri/     # Rust shell
```

## Module map

```text
bin/theesync.js           CLI entry
src/cli.js                commander interface
src/config/categories.js  allowlisted category names (edit here)
src/safety.js             root protection, path bounds
src/walk.js               tree walk + skip rules
src/compare.js            plan actions
src/copy.js / delete.js   safe mutations
src/plan-file.js          plan JSON v1
src/events.js             human log + NDJSON
src/sync.js               plan / apply orchestration
test/                     node:test (temp dirs only)
app/                      Tauri UI
```

### Adding a category

1. Edit `src/config/categories.js` (names are **case-sensitive**).  
2. `npm test`  
3. UI: **Reload categories** (or restart).  

```bash
theesync-cli categories
theesync-cli categories --json
```

## Tests

```bash
npm test
```

Tests use temporary fake volumes (`.rockbox`, `update.upt`, `Screenshots`). They never target a real mounted card.

## Out of scope

Two-way sync, transcoding, watch mode, auto-detect source layout, managing non-allowlisted root folders, Rockbox filename “fixes”, embedded Node, packaged `.app` distribution.

## License

MIT
