//! theesync Tauri shell — dialogs, path probes, spawn/kill Node CLI.
//! Sync logic stays in the Node engine (bin/theesync.js).

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// Debounce window after /Volumes FS events before emitting to the UI.
const VOLUMES_DEBOUNCE_MS: u64 = 400;
/// Extra emits after a mount burst (path can appear before Rockbox markers are readable).
const VOLUMES_RETRY_MS: &[u64] = &[700, 1500];

/// Running Node child (at most one batch step at a time for cancel).
pub struct EngineState {
    pub child: Mutex<Option<Child>>,
    /// Set when cancel_theesync kills the child for the current run.
    pub cancelled: Mutex<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliLineEvent {
    stream: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliDoneEvent {
    code: i32,
    cancelled: bool,
}

/// Structured result for UI: distinguish cancel from ordinary failure.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub code: i32,
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeProbe {
    pub path: String,
    pub volume_root: String,
    /// True when the volume root path exists (e.g. /Volumes/H2 is mounted).
    pub root_exists: bool,
    pub exists: bool,
    pub is_dir: bool,
    pub has_rockbox: bool,
    pub has_update: bool,
    pub present: bool,
    pub message: String,
}

/// Emitted when the /Volumes watcher fails to start (UI can fall back to focus-only).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumesWatchStatusEvent {
    pub ok: bool,
    pub message: String,
}

/// Payload for `volumes-changed` (UI re-probes badges + mount autocomplete).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumesChangedEvent {
    pub mounts: Vec<String>,
    /// `watch` (debounced FS event) or `retry` (delayed re-check after mount).
    pub reason: String,
}

/// Resolve path to bin/theesync.js (repo root relative to src-tauri, or env override).
fn resolve_engine_js() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("THEESYNC_ENGINE") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
        return Err(format!("THEESYNC_ENGINE not a file: {}", pb.display()));
    }

    // Dev: app/src-tauri → ../../bin/theesync.js
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("../../bin/theesync.js"),
        manifest_dir.join("../bin/theesync.js"),
        manifest_dir.join("../../../bin/theesync.js"),
        // If app is run from repo root with cwd-based discovery
        PathBuf::from("bin/theesync.js"),
        PathBuf::from("../bin/theesync.js"),
    ];

    for c in candidates {
        if let Ok(canon) = c.canonicalize() {
            if canon.is_file() {
                return Ok(canon);
            }
        }
        if c.is_file() {
            return Ok(c);
        }
    }

    Err(
        "Could not find bin/theesync.js. Set THEESYNC_ENGINE or run from the theesync repo."
            .into(),
    )
}

fn resolve_node() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("THEESYNC_NODE") {
        let pb = PathBuf::from(p);
        if pb.is_file() || pb.exists() {
            return Ok(pb);
        }
    }
    which::which("node").map_err(|_| {
        "Node.js not found on PATH. Install Node ≥20 or set THEESYNC_NODE.".to_string()
    })
}

fn volume_root_from_dest(dest: &Path) -> PathBuf {
    dest.parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| dest.to_path_buf())
}

fn probe_volume_root(root: &Path) -> (bool, bool) {
    let mut has_rockbox = false;
    let mut has_update = false;
    let Ok(entries) = std::fs::read_dir(root) else {
        return (false, false);
    };
    for ent in entries.flatten() {
        let name = ent.file_name();
        let name = name.to_string_lossy();
        let ft = ent.file_type().ok();
        if let Some(ft) = ft {
            if ft.is_dir() && (name == ".rockbox" || name.starts_with(".rockbox ")) {
                has_rockbox = true;
            }
            if ft.is_file() && name.eq_ignore_ascii_case("update.upt") {
                has_update = true;
            }
        }
    }
    (has_rockbox, has_update)
}

/// Resolve a picked path up to the SD card / volume root.
/// 1. Walk parents until `.rockbox*` or `update.upt` is found.
/// 2. Else on macOS, clamp to `/Volumes/<name>`.
/// 3. Else return the path (or its parent if a file).
fn resolve_card_volume_root(path: &Path) -> PathBuf {
    let mut abs = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf());
    if abs.is_file() {
        if let Some(parent) = abs.parent() {
            abs = parent.to_path_buf();
        }
    }

    // Prefer ancestor with Rockbox / firmware markers
    let mut p = abs.clone();
    loop {
        let (rb, up) = probe_volume_root(&p);
        if rb || up {
            return p;
        }
        match p.parent() {
            Some(parent) if parent != p => p = parent.to_path_buf(),
            _ => break,
        }
    }

    // macOS mount point: /Volumes/H2/... → /Volumes/H2
    #[cfg(target_os = "macos")]
    {
        if let Ok(rel) = abs.strip_prefix("/Volumes") {
            if let Some(std::path::Component::Normal(name)) = rel.components().next() {
                return PathBuf::from("/Volumes").join(name);
            }
        }
    }

    abs
}

#[tauri::command]
fn get_engine_info() -> Result<serde_json::Value, String> {
    let engine = resolve_engine_js()?;
    let node = resolve_node()?;
    Ok(serde_json::json!({
        "engine": engine.to_string_lossy(),
        "node": node.to_string_lossy(),
    }))
}

#[tauri::command]
fn probe_dest(dest: String) -> VolumeProbe {
    let dest_path = PathBuf::from(&dest);
    let volume_root = volume_root_from_dest(&dest_path);
    let exists = dest_path.exists();
    let is_dir = dest_path.is_dir();
    let root_exists = volume_root.exists();

    let (has_rockbox, has_update) = if root_exists {
        probe_volume_root(&volume_root)
    } else {
        (false, false)
    };
    let present = has_rockbox || has_update;

    let message = if !root_exists {
        format!("Volume not found: {}", volume_root.display())
    } else if present {
        let mut parts = Vec::new();
        if has_rockbox {
            parts.push("Rockbox");
        }
        if has_update {
            parts.push("update.upt");
        }
        format!("H2 markers: {}", parts.join(" + "))
    } else {
        format!(
            "No .rockbox / update.upt on {}",
            volume_root.display()
        )
    };

    VolumeProbe {
        path: dest,
        volume_root: volume_root.to_string_lossy().into_owned(),
        root_exists,
        exists,
        is_dir,
        has_rockbox,
        has_update,
        present,
        message,
    }
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    PathBuf::from(path).exists()
}

/// Native folder picker. Returns absolute path or null if cancelled.
#[tauri::command]
async fn pick_directory(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    let title = title.unwrap_or_else(|| "Select folder".into());
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_title(&title)
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });

    let folder = rx.await.map_err(|e| e.to_string())?;
    Ok(folder.and_then(|fp: FilePath| {
        fp.into_path()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }))
}

/// Pick a folder, then normalize to the card/volume root (not Music/ nested paths).
/// Starts the dialog under /Volumes when that exists (macOS).
#[tauri::command]
async fn pick_volume(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    let title = title.unwrap_or_else(|| "Select card volume (root of the SD card)".into());
    let (tx, rx) = tokio::sync::oneshot::channel();

    let mut dialog = app.dialog().file().set_title(&title);
    let volumes = PathBuf::from("/Volumes");
    if volumes.is_dir() {
        dialog = dialog.set_directory(&volumes);
    }

    dialog.pick_folder(move |folder| {
        let _ = tx.send(folder);
    });

    let folder = rx.await.map_err(|e| e.to_string())?;
    Ok(folder.and_then(|fp: FilePath| {
        fp.into_path().ok().map(|p| {
            resolve_card_volume_root(&p)
                .to_string_lossy()
                .into_owned()
        })
    }))
}

/// Normalize any path to the card/volume root (for paste / manual edit).
#[tauri::command]
fn resolve_volume_root(path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Path is empty".into());
    }
    let p = PathBuf::from(path.trim());
    Ok(resolve_card_volume_root(&p)
        .to_string_lossy()
        .into_owned())
}

/// List mount points under /Volumes (macOS) for a volume dropdown.
fn list_volumes_impl() -> Vec<String> {
    let volumes = PathBuf::from("/Volumes");
    if !volumes.is_dir() {
        return vec![];
    }
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&volumes) else {
        return vec![];
    };
    for ent in entries.flatten() {
        let name = ent.file_name();
        let name = name.to_string_lossy();
        // Skip macOS system volume symlink noise if desired; still list H2 etc.
        if name == "Macintosh HD" {
            continue;
        }
        let path = ent.path();
        if path.is_dir() || path.is_symlink() {
            out.push(path.to_string_lossy().into_owned());
        }
    }
    out.sort();
    out
}

#[tauri::command]
fn list_volumes() -> Result<Vec<String>, String> {
    Ok(list_volumes_impl())
}

fn emit_volumes_watch_status(app: &AppHandle, ok: bool, message: impl Into<String>) {
    let payload = VolumesWatchStatusEvent {
        ok,
        message: message.into(),
    };
    if let Err(e) = app.emit("volumes-watch-status", payload) {
        eprintln!("theesync: emit volumes-watch-status failed: {e}");
    }
}

/// Watch `/Volumes` (FSEvents via notify) and emit `volumes-changed` after debounce.
/// Lifetime: background thread holds the Watcher until process exit.
fn start_volumes_watcher(app: AppHandle) {
    let volumes = PathBuf::from("/Volumes");
    if !volumes.is_dir() {
        eprintln!("theesync: /Volumes not present — volume watch disabled");
        emit_volumes_watch_status(&app, false, "/Volumes not present — volume watch disabled");
        return;
    }

    let app_main = app.clone();
    let spawn_result = std::thread::Builder::new()
        .name("volumes-watch".into())
        .spawn(move || {
            let (tx, rx) = std::sync::mpsc::channel::<Result<notify::Event, notify::Error>>();
            let mut watcher = match RecommendedWatcher::new(
                move |res| {
                    let _ = tx.send(res);
                },
                Config::default(),
            ) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("theesync: volume watcher init failed: {e}");
                    emit_volumes_watch_status(
                        &app,
                        false,
                        format!("volume watcher init failed: {e}"),
                    );
                    return;
                }
            };

            if let Err(e) = watcher.watch(&volumes, RecursiveMode::NonRecursive) {
                eprintln!("theesync: watch /Volumes failed: {e}");
                emit_volumes_watch_status(&app, false, format!("watch /Volumes failed: {e}"));
                return;
            }

            eprintln!("theesync: watching /Volumes for mount changes");
            emit_volumes_watch_status(&app, true, "watching /Volumes for mount changes");

            // Generation: each FS burst schedules debounced emits; a newer burst cancels older retries.
            let gen = std::sync::Arc::new(AtomicU64::new(0));

            while let Ok(res) = rx.recv() {
                match res {
                    Ok(event) => {
                        // Ignore pure access/open noise; care about create/remove/modify/rename.
                        if !event_kind_matters(&event.kind) {
                            continue;
                        }
                    }
                    Err(e) => {
                        eprintln!("theesync: volume watch error: {e}");
                        continue;
                    }
                }

                let g = gen.fetch_add(1, Ordering::SeqCst) + 1;
                schedule_volumes_changed(app.clone(), gen.clone(), g);
            }

            // Keep watcher alive for the life of this thread (channel only closes if callback drops).
            drop(watcher);
        });

    if let Err(e) = spawn_result {
        eprintln!("theesync: volume watcher thread spawn failed: {e}");
        emit_volumes_watch_status(
            &app_main,
            false,
            format!("volume watcher thread spawn failed: {e}"),
        );
    }
}

fn event_kind_matters(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Any
            | EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(_)
            | EventKind::Other
    )
}

fn schedule_volumes_changed(app: AppHandle, gen: std::sync::Arc<AtomicU64>, g: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(VOLUMES_DEBOUNCE_MS)).await;
        if gen.load(Ordering::SeqCst) != g {
            return;
        }
        emit_volumes_changed(&app, "watch");

        for delay in VOLUMES_RETRY_MS {
            tokio::time::sleep(Duration::from_millis(*delay)).await;
            if gen.load(Ordering::SeqCst) != g {
                return;
            }
            emit_volumes_changed(&app, "retry");
        }
    });
}

fn emit_volumes_changed(app: &AppHandle, reason: &str) {
    let mounts = list_volumes_impl();
    let payload = VolumesChangedEvent {
        mounts,
        reason: reason.to_string(),
    };
    if let Err(e) = app.emit("volumes-changed", payload) {
        eprintln!("theesync: emit volumes-changed failed: {e}");
    }
}

/// Native yes/no confirm. Returns true if confirmed.
#[tauri::command]
async fn confirm_dialog(
    app: AppHandle,
    title: String,
    message: String,
) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .message(&message)
        .title(&title)
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
        .show(move |result| {
            let _ = tx.send(result);
        });

    rx.await.map_err(|e| e.to_string())
}

/// Write a temp plan path for apply flow.
#[tauri::command]
fn temp_plan_path(label: String) -> Result<String, String> {
    let safe: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let name = format!(
        "theesync-{}-{}.plan.json",
        safe,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let path = std::env::temp_dir().join(name);
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn remove_file_if_exists(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Cancel the running CLI child if any.
#[tauri::command]
async fn cancel_theesync(state: State<'_, EngineState>) -> Result<bool, String> {
    {
        let mut flag = state.cancelled.lock().map_err(|e| e.to_string())?;
        *flag = true;
    }
    let child = {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        guard.take()
    };
    if let Some(mut child) = child {
        let _ = child.kill().await;
        return Ok(true);
    }
    Ok(false)
}

/// Spawn `node bin/theesync.js …`, stream lines as events.
/// Returns `{ code, cancelled }` so the UI can abort the batch on cancel.
/// Events: `theesync-line` { stream, line }, `theesync-done` { code, cancelled }
#[tauri::command]
async fn run_theesync(
    app: AppHandle,
    state: State<'_, EngineState>,
    args: Vec<String>,
) -> Result<RunResult, String> {
    // Ensure no prior child (drop lock before await)
    {
        let prior = {
            let mut guard = state.child.lock().map_err(|e| e.to_string())?;
            guard.take()
        };
        if let Some(mut child) = prior {
            let _ = child.kill().await;
        }
    }
    {
        let mut flag = state.cancelled.lock().map_err(|e| e.to_string())?;
        *flag = false;
    }

    let node = resolve_node()?;
    let engine = resolve_engine_js()?;

    let mut cmd = Command::new(&node);
    cmd.arg(&engine)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn node: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr".to_string())?;

    {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    let app_out = app.clone();
    let out_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(
                "theesync-line",
                CliLineEvent {
                    stream: "stdout".into(),
                    line,
                },
            );
        }
    });

    let app_err = app.clone();
    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "theesync-line",
                CliLineEvent {
                    stream: "stderr".into(),
                    line,
                },
            );
        }
    });

    let _ = out_task.await;
    let _ = err_task.await;

    let was_cancelled = {
        let flag = state.cancelled.lock().map_err(|e| e.to_string())?;
        *flag
    };

    let child = {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        guard.take()
    };

    let (code, cancelled) = if let Some(mut child) = child {
        match child.wait().await {
            Ok(status) => {
                let c = status.code().unwrap_or(1);
                (c, was_cancelled)
            }
            Err(_) => (1, true),
        }
    } else {
        // Child taken by cancel (or already reaped)
        (1, true)
    };

    let result = RunResult { code, cancelled };
    let _ = app.emit(
        "theesync-done",
        CliDoneEvent {
            code: result.code,
            cancelled: result.cancelled,
        },
    );
    Ok(result)
}

/// Read a plan file and return delete count (for confirm UI).
#[tauri::command]
fn plan_delete_count(plan_path: String) -> Result<u64, String> {
    let raw = std::fs::read_to_string(&plan_path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let n = v
        .pointer("/counts/delete")
        .and_then(|x| x.as_u64())
        .or_else(|| {
            v.get("counts")
                .and_then(|c| c.get("delete"))
                .and_then(|x| x.as_u64())
        })
        .unwrap_or(0);
    Ok(n)
}

/// Ask the Node engine for allowlisted categories (`theesync categories --json`).
/// Source of truth: src/config/categories.js loaded by that process.
#[tauri::command]
fn list_categories() -> Result<Vec<String>, String> {
    let node = resolve_node()?;
    let engine = resolve_engine_js()?;
    let output = std::process::Command::new(&node)
        .arg(&engine)
        .arg("categories")
        .arg("--json")
        .output()
        .map_err(|e| format!("Failed to run categories: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "categories exited {}: {}",
            output.status.code().unwrap_or(1),
            err.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .ok_or_else(|| "categories produced no output".to_string())?;

    let list: Vec<String> =
        serde_json::from_str(line).map_err(|e| format!("Invalid categories JSON: {e}"))?;
    if list.is_empty() {
        return Err("categories list is empty".into());
    }
    Ok(list)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState {
            child: Mutex::new(None),
            cancelled: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            get_engine_info,
            probe_dest,
            path_exists,
            pick_directory,
            pick_volume,
            resolve_volume_root,
            list_volumes,
            confirm_dialog,
            temp_plan_path,
            remove_file_if_exists,
            cancel_theesync,
            run_theesync,
            plan_delete_count,
            list_categories,
        ])
        .setup(|app| {
            // Best-effort: log engine path at startup in dev
            if let Ok(info) = get_engine_info() {
                eprintln!("theesync engine: {info}");
            }
            start_volumes_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running theesync");
}
