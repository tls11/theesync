# theesync desktop UI

Tauri 2 shell for the [theesync](../README.md) Node engine.

## Dev

```bash
# From repo root
npm run app:dev

# Or
cd app
npm install
npm run dev
```

## Requirements

- Node.js ≥ 20 on `PATH` (sync engine is `../bin/theesync.js`)
- Rust + system deps for Tauri 2

Optional env overrides:

| Env | Meaning |
|-----|---------|
| `THEESYNC_ENGINE` | Absolute path to `theesync.js` |
| `THEESYNC_NODE` | Absolute path to `node` binary |

## Architecture

- **Frontend:** vanilla HTML/CSS/JS, `withGlobalTauri`
- **Rust:** folder picker, confirm dialog, volume probe, spawn/kill Node CLI, stream NDJSON lines as Tauri events
- **Node:** all plan/apply/safety logic (never reimplemented in Rust)
