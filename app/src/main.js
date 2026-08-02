/**
 * theesync UI — job list with volume + category dropdowns (C+D).
 * Categories loaded from the Node engine (src/config/categories.js).
 * Dest = volumeRoot + "/" + category (derived, not free-typed).
 */

const STORAGE_KEY = "theesync.jobs.v2";
const DEFAULT_VOLUME = "/Volumes/H2";
/** Fallback if engine is unavailable at first paint */
const FALLBACK_CATEGORIES = ["Music", "Books"];

function uid() {
  return `job_${Math.random().toString(36).slice(2, 10)}`;
}

function jobDest(job) {
  const vol = (job.volumeRoot || "").replace(/\/+$/, "");
  const cat = job.category || "";
  if (!vol || !cat) return "";
  return `${vol}/${cat}`;
}

function defaultJobs(categories = FALLBACK_CATEGORIES) {
  const cats = categories.length ? categories : FALLBACK_CATEGORIES;
  return cats.map((category) => ({
    id: uid(),
    label: category,
    enabled: true,
    collapsed: false,
    source: "",
    volumeRoot: DEFAULT_VOLUME,
    category,
  }));
}

/** Migrate v1 { dest } jobs → v2 { volumeRoot, category }. */
function normalizeJob(raw, categories) {
  const cats = categories.length ? categories : FALLBACK_CATEGORIES;
  let volumeRoot = raw.volumeRoot;
  let category = raw.category;

  if ((!volumeRoot || !category) && raw.dest) {
    const dest = String(raw.dest).replace(/\/+$/, "");
    const idx = dest.lastIndexOf("/");
    if (idx > 0) {
      category = dest.slice(idx + 1);
      volumeRoot = dest.slice(0, idx);
    } else {
      volumeRoot = DEFAULT_VOLUME;
      category = cats[0];
    }
  }

  volumeRoot = (volumeRoot || DEFAULT_VOLUME).replace(/\/+$/, "") || DEFAULT_VOLUME;
  if (!cats.includes(category)) {
    category = cats[0];
  }

  return {
    id: raw.id || uid(),
    label: raw.label || category,
    enabled: raw.enabled !== false,
    collapsed: Boolean(raw.collapsed),
    source: raw.source || "",
    volumeRoot,
    category,
  };
}

function loadState(categories) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("theesync.jobs.v1");
    if (!raw) {
      return {
        jobs: defaultJobs(categories),
        noDelete: false,
        checksum: false,
        thoroughCovers: false,
        requireRockbox: false,
        verbose: false,
      };
    }
    const data = JSON.parse(raw);
    let jobs = Array.isArray(data.jobs) ? data.jobs.map((j) => normalizeJob(j, categories)) : [];
    if (jobs.length === 0) jobs = defaultJobs(categories);
    return {
      jobs,
      noDelete: Boolean(data.noDelete),
      checksum: Boolean(data.checksum),
      thoroughCovers: Boolean(data.thoroughCovers),
      requireRockbox: Boolean(data.requireRockbox),
      verbose: Boolean(data.verbose),
    };
  } catch {
    return {
      jobs: defaultJobs(categories),
      noDelete: false,
      checksum: false,
      thoroughCovers: false,
      requireRockbox: false,
      verbose: false,
    };
  }
}

function saveState(state) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      jobs: state.jobs.map((j) => ({
        id: j.id,
        label: j.label,
        enabled: j.enabled,
        collapsed: Boolean(j.collapsed),
        source: j.source,
        volumeRoot: j.volumeRoot,
        category: j.category,
      })),
      noDelete: state.noDelete,
      checksum: state.checksum,
      thoroughCovers: Boolean(state.thoroughCovers),
      requireRockbox: state.requireRockbox,
      verbose: Boolean(state.verbose),
    }),
  );
}

const api = {
  invoke: (cmd, args) => window.__TAURI__.core.invoke(cmd, args),
  listen: (event, handler) => window.__TAURI__.event.listen(event, handler),
};

/** @type {string[]} */
let categories = [...FALLBACK_CATEGORIES];
let state = loadState(categories);
let running = false;
let cancelRequested = false;
let unlistenLine = null;
/** @type {(() => void) | null} */
let unlistenVolumes = null;
/** Last mount list fingerprint — skip datalist rewrite when unchanged */
let lastMountsKey = "";
/** @type {HTMLElement} */
let logEl;
/** @type {HTMLElement} */
let summaryEl;
/** @type {HTMLElement} */
let jobsEl;

function $(id) {
  return document.getElementById(id);
}

function appendLog(text, cls = "") {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text.endsWith("\n") ? text : text + "\n";
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

function appendSection(title) {
  appendLog(`\n── ${title} ──`, "section");
}

function setBusy(busy) {
  running = busy;
  if (busy) cancelRequested = false;
  $("btn-dry-run").disabled = busy;
  $("btn-sync").disabled = busy;
  $("btn-add-job").disabled = busy;
  $("btn-reload-categories").disabled = busy;
  $("btn-cancel").disabled = !busy;
}

function selectedJobs() {
  return state.jobs.filter((j) => j.enabled);
}

function commonFlags() {
  const flags = ["--json-lines"];
  if (state.noDelete) flags.push("--no-delete");
  if (state.checksum) flags.push("--checksum");
  if (state.thoroughCovers) flags.push("--thorough-covers");
  if (state.requireRockbox) flags.push("--require-rockbox");
  if (state.verbose) flags.push("-v");
  return flags;
}

async function runCli(args) {
  const result = await api.invoke("run_theesync", { args });
  if (typeof result === "number") {
    return { code: result, cancelled: cancelRequested };
  }
  if (result?.cancelled) {
    cancelRequested = true;
  }
  return {
    code: result?.code ?? 1,
    cancelled: Boolean(result?.cancelled) || cancelRequested,
  };
}

function shouldAbortBatch(result) {
  return cancelRequested || Boolean(result?.cancelled);
}

/**
 * Load allowlist from engine: theesync categories --json
 */
async function fetchCategories() {
  const list = await api.invoke("list_categories");
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("Empty categories list from engine");
  }
  return list.map(String);
}

/**
 * After reloading categories, fix jobs whose category is no longer allowed.
 */
function reconcileJobsWithCategories() {
  for (const job of state.jobs) {
    if (!categories.includes(job.category)) {
      job.category = categories[0];
      if (!job.label || FALLBACK_CATEGORIES.includes(job.label)) {
        job.label = job.category;
      }
    }
  }
  saveState(state);
}

async function reloadCategories({ quiet = false } = {}) {
  try {
    categories = await fetchCategories();
    reconcileJobsWithCategories();
    renderJobs();
    if (!quiet) {
      appendLog(`Categories loaded: ${categories.join(", ")}`, "ok");
    }
    return true;
  } catch (e) {
    appendLog(`Could not load categories from engine: ${e}`, "err");
    appendLog(`Using fallback: ${FALLBACK_CATEGORIES.join(", ")}`, "warn");
    categories = [...FALLBACK_CATEGORIES];
    return false;
  }
}

async function probeJob(job) {
  const dest = jobDest(job);
  if (!dest) {
    return { present: false, rootExists: false, message: "No dest", className: "err" };
  }
  try {
    const p = await api.invoke("probe_dest", { dest });
    if (!p.volumeRoot || p.rootExists === false) {
      return { ...p, className: "err" };
    }
    if (p.present) return { ...p, className: "ok" };
    return { ...p, className: "warn" };
  } catch (e) {
    return { message: String(e), rootExists: false, className: "err" };
  }
}

function categoryOptionsHtml(selected) {
  return categories
    .map(
      (c) =>
        `<option value="${escapeAttr(c)}"${c === selected ? " selected" : ""}>${escapeAttr(c)}</option>`,
    )
    .join("");
}

function renderJobs() {
  jobsEl.innerHTML = "";
  for (const job of state.jobs) {
    const dest = jobDest(job);
    const card = document.createElement("div");
    card.className = "job" + (job.collapsed ? " is-collapsed" : "");
    card.dataset.id = job.id;

    card.innerHTML = `
      <div class="job-top">
        <button type="button" class="job-collapse" title="${job.collapsed ? "Expand" : "Collapse"}" aria-expanded="${job.collapsed ? "false" : "true"}">
          <span class="job-collapse-icon" aria-hidden="true">▾</span>
        </button>
        <label class="check" title="Include in Dry run / Sync">
          <input type="checkbox" class="job-enabled" ${job.enabled ? "checked" : ""} />
        </label>
        <input type="text" class="job-label" value="${escapeAttr(job.label)}" placeholder="Job label" />
        <span class="job-collapsed-summary" title="Writes to">${escapeAttr(dest || "—")}</span>
        <button type="button" class="job-remove" title="Remove job">Remove</button>
      </div>

      <div class="job-body">
        <div class="job-body-inner">
          <div class="job-section">
            <div class="job-section-title">Source library</div>
            <p class="job-section-hint">Files on this Mac to copy from</p>
            <div class="row">
              <label>Source</label>
              <input type="text" class="job-source" value="${escapeAttr(job.source)}" placeholder="/Users/you/Music/library" />
              <button type="button" class="btn btn-sm btn-browse-source">Browse</button>
            </div>
          </div>

          <div class="job-section job-section-card">
            <div class="job-section-title">On the card</div>
            <p class="job-section-hint">Volume + category → where files are written</p>
            <div class="row">
              <label>Volume</label>
              <input type="text" class="job-volume" list="volume-mounts" value="${escapeAttr(job.volumeRoot)}" placeholder="/Volumes/H2" title="Root of the mounted card (e.g. /Volumes/H2), not the Music folder" />
              <button type="button" class="btn btn-sm btn-browse-volume">Browse</button>
            </div>
            <div class="row">
              <label>Category</label>
              <select class="job-category">${categoryOptionsHtml(job.category)}</select>
              <span></span>
            </div>
            <div class="row">
              <label>Writes to</label>
              <div class="dest-display job-dest" title="Derived: volume + category">${escapeAttr(dest)}</div>
              <span></span>
            </div>
            <div class="badge job-badge"><span class="dot"></span><span class="badge-text">Checking…</span></div>
          </div>
        </div>
      </div>
    `;

    const enabled = card.querySelector(".job-enabled");
    const label = card.querySelector(".job-label");
    const source = card.querySelector(".job-source");
    const volume = card.querySelector(".job-volume");
    const category = card.querySelector(".job-category");
    const destEl = card.querySelector(".job-dest");
    const badge = card.querySelector(".job-badge");
    const badgeText = card.querySelector(".badge-text");

    function syncDestDisplay() {
      destEl.textContent = jobDest(job) || "—";
    }

    card.querySelector(".job-collapse").addEventListener("click", () => {
      job.collapsed = !job.collapsed;
      saveState(state);
      // Toggle in place so the chevron CSS transition can run
      card.classList.toggle("is-collapsed", job.collapsed);
      const btn = card.querySelector(".job-collapse");
      btn.title = job.collapsed ? "Expand" : "Collapse";
      btn.setAttribute("aria-expanded", job.collapsed ? "false" : "true");
    });

    enabled.addEventListener("change", () => {
      job.enabled = enabled.checked;
      saveState(state);
    });
    label.addEventListener("change", () => {
      job.label = label.value.trim() || job.category || "Job";
      saveState(state);
    });
    source.addEventListener("change", () => {
      job.source = source.value.trim();
      saveState(state);
    });
    volume.addEventListener("change", async () => {
      let vol = volume.value.trim().replace(/\/+$/, "") || DEFAULT_VOLUME;
      try {
        // Snap to card root if user pasted …/Music or a nested path
        const resolved = await api.invoke("resolve_volume_root", { path: vol });
        if (resolved && resolved !== vol) {
          appendLog(`Volume normalized to card root: ${resolved}`, "warn");
          vol = resolved;
        }
      } catch {
        /* keep typed path if resolve fails (missing mount) */
      }
      job.volumeRoot = vol;
      volume.value = vol;
      saveState(state);
      syncDestDisplay();
      await refreshBadge(job, badge, badgeText);
    });
    category.addEventListener("change", async () => {
      job.category = category.value;
      if (!job.label || categories.includes(job.label) || FALLBACK_CATEGORIES.includes(job.label)) {
        job.label = job.category;
        label.value = job.label;
      }
      saveState(state);
      syncDestDisplay();
      await refreshBadge(job, badge, badgeText);
    });

    card.querySelector(".btn-browse-source").addEventListener("click", async () => {
      const p = await api.invoke("pick_directory", { title: `Source for ${job.label}` });
      if (p) {
        job.source = p;
        source.value = p;
        saveState(state);
      }
    });
    card.querySelector(".btn-browse-volume").addEventListener("click", async () => {
      // Opens under /Volumes; always normalizes to card root (not Music/)
      const p = await api.invoke("pick_volume", {
        title: `Select card volume for ${job.label} (root of the SD card)`,
      });
      if (p) {
        job.volumeRoot = p;
        volume.value = p;
        saveState(state);
        syncDestDisplay();
        await refreshBadge(job, badge, badgeText);
      }
    });
    card.querySelector(".job-remove").addEventListener("click", () => {
      if (state.jobs.length <= 1) {
        appendLog("Keep at least one job.", "warn");
        return;
      }
      state.jobs = state.jobs.filter((j) => j.id !== job.id);
      saveState(state);
      renderJobs();
    });

    jobsEl.appendChild(card);
    refreshBadge(job, badge, badgeText);
  }
}

async function refreshBadge(job, badge, badgeText) {
  const p = await probeJob(job);
  badge.classList.remove("ok", "warn", "err");
  badge.classList.add(p.className || "warn");
  badgeText.textContent = p.message || "—";
}

/**
 * Refresh every job badge without rebuilding the job list DOM.
 * Triggered by /Volumes watch events and window focus.
 */
async function refreshAllJobBadges() {
  if (!jobsEl) return;
  const cards = [...jobsEl.querySelectorAll(".job")];
  await Promise.all(
    cards.map(async (card) => {
      const id = card.dataset.id;
      const job = state.jobs.find((j) => j.id === id);
      if (!job) return;
      const badge = card.querySelector(".job-badge");
      const badgeText = card.querySelector(".badge-text");
      if (!badge || !badgeText) return;
      await refreshBadge(job, badge, badgeText);
    }),
  );
}

/** Refresh /Volumes/* autocomplete when the mount list changes. */
async function refreshVolumeMounts(mountsFromEvent) {
  try {
    const mounts = Array.isArray(mountsFromEvent)
      ? mountsFromEvent
      : await api.invoke("list_volumes");
    if (!Array.isArray(mounts)) return;
    const key = mounts.join("\n");
    if (key === lastMountsKey) return;
    lastMountsKey = key;
    const dl = $("volume-mounts");
    if (dl) {
      dl.innerHTML = mounts
        .map((m) => `<option value="${escapeAttr(m)}"></option>`)
        .join("");
    }
  } catch {
    /* optional */
  }
}

async function onVolumesChanged(payload) {
  // Still update badges while a sync runs (card may vanish mid-batch).
  const mounts = payload?.mounts;
  await refreshVolumeMounts(mounts);
  await refreshAllJobBadges();
}

/**
 * Wire FS-driven volume updates + focus backstop.
 * Rust watches /Volumes and emits `volumes-changed` (debounced + retries).
 */
async function startVolumeAwareness() {
  try {
    unlistenVolumes = await api.listen("volumes-changed", (event) => {
      onVolumesChanged(event?.payload).catch(() => {});
    });
  } catch (e) {
    appendLog(`Volume watch unavailable: ${e}`, "warn");
  }

  try {
    await api.listen("volumes-watch-status", (event) => {
      const p = event?.payload;
      if (!p) return;
      if (p.ok) {
        // Quiet success — only log failures so startup stays calm
        return;
      }
      appendLog(`Volume watch: ${p.message || "unavailable"} (focus re-probe still works)`, "warn");
    });
  } catch {
    /* optional */
  }

  const onFocus = () => {
    onVolumesChanged(null).catch(() => {});
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onFocus();
  });
}

/** True if probe says the volume root is missing / unmounted. */
function isVolumeMissing(probe) {
  if (!probe) return true;
  if (probe.rootExists === false) return true;
  if (probe.rootExists === true) return false;
  // Fallback if older probe payload lacks rootExists
  const msg = String(probe.message || "");
  return msg.includes("Volume not found");
}

/**
 * Fresh probe before Dry run / Sync. Returns false if any selected job's volume is gone.
 */
async function ensureVolumesForJobs(jobs) {
  await refreshAllJobBadges();
  for (const job of jobs) {
    const p = await probeJob(job);
    if (isVolumeMissing(p)) {
      appendLog(
        `${job.label}: ${p.message || "volume not found"} — plug in the card or fix Volume path`,
        "err",
      );
      return false;
    }
  }
  return true;
}

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function validateJob(job) {
  if (!job.source) return `${job.label}: missing source`;
  if (!job.volumeRoot) return `${job.label}: missing volume`;
  if (!job.category) return `${job.label}: missing category`;
  if (!categories.includes(job.category)) {
    return `${job.label}: category "${job.category}" not allowlisted (reload categories?)`;
  }
  if (!jobDest(job)) return `${job.label}: could not build dest`;
  return null;
}

/**
 * Snapshot for a run: freeze dest path at start.
 */
function snapshotJob(job) {
  return {
    ...job,
    dest: jobDest(job),
  };
}

async function withLineListener(prefix, fn) {
  if (unlistenLine) {
    unlistenLine();
    unlistenLine = null;
  }
  unlistenLine = await api.listen("theesync-line", (event) => {
    const { stream, line } = event.payload;
    let text = line;
    let cls = "";
    try {
      const ev = JSON.parse(line);
      text = formatEvent(ev, prefix);
      if (ev.type === "error") cls = "err";
      else if (ev.type === "warning") cls = "warn";
      else if (ev.type === "done" && ev.ok) cls = "ok";
      else if (ev.type === "done" && ev.ok === false) cls = "err";
    } catch {
      if (stream === "stderr") cls = "err";
      if (prefix) text = `[${prefix}] ${line}`;
    }
    appendLog(text, cls);
  });

  try {
    return await fn();
  } finally {
    if (unlistenLine) {
      unlistenLine();
      unlistenLine = null;
    }
  }
}

function formatEvent(ev, prefix) {
  const p = prefix ? `[${prefix}] ` : "";
  switch (ev.type) {
    case "start":
      return `${p}→ ${ev.phase || "sync"}: ${ev.source || ""} → ${ev.dest || ""}`;
    case "scan": {
      const side = ev.side === "source" ? "source library" : "dest category";
      const empty =
        ev.files === 0 && ev.dirs === 0 ? " (empty — nothing to compare)" : "";
      return `${p}  scan ${side}: ${ev.files ?? "?"} files, ${ev.dirs ?? "?"} dirs${empty}`;
    }
    case "plan": {
      const lines = [
        `${p}  plan (what would change):`,
        `${p}    add:     ${ev.add ?? 0}  (${ev.addFiles ?? "?"} files, ${ev.addDirs ?? "?"} dirs)  — missing on dest`,
        `${p}    update:  ${ev.update ?? 0}  — size/mtime/checksum differ`,
        `${p}    delete:  ${ev.delete ?? 0}  (${ev.deleteFiles ?? "?"} files, ${ev.deleteDirs ?? "?"} dirs)  — dest-only library`,
      ];
      if (ev.skippedUnchanged != null) {
        lines.push(`${p}    unchanged (skip): ${ev.skippedUnchanged}`);
      }
      if (state.verbose && (ev.deleteJunk ?? 0) > 0) {
        lines.push(
          `${p}    cleanup:  ${ev.deleteJunk} macOS metadata files (._* / .DS_Store)`,
        );
      }
      if ((ev.add ?? 0) > 0 && (ev.update ?? 0) === 0 && (ev.delete ?? 0) === 0) {
        lines.push(
          `${p}    note: plan is add-only (no library updates or deletes)`,
        );
      }
      return lines.join("\n");
    }
    case "action":
      if (!state.verbose && (ev.junk || ev.op === "skip")) return null;
      return `${p}  ${ev.op} ${ev.path || ""}${ev.reason ? ` (${ev.reason})` : ""}`;
    case "warning":
      return `${p}  ⚠ ${ev.message}`;
    case "error":
      return `${p}  ✗ ${ev.message}${ev.path ? ` [${ev.path}]` : ""}`;
    case "summary": {
      const lines = [
        `${p}── summary ──`,
        `${p}  would add:     ${ev.added ?? 0}`,
        `${p}  would update:  ${ev.updated ?? 0}`,
        `${p}  would delete:  ${ev.deleted ?? 0}`,
        `${p}  unchanged:     ${ev.skipped ?? 0}`,
        `${p}  failed:        ${ev.failed ?? 0}`,
      ];
      if (state.verbose && (ev.junkCleaned ?? 0) > 0) {
        lines.push(`${p}  cleanup:        ${ev.junkCleaned} macOS metadata files`);
      }
      if (ev.dryRun) lines.push(`${p}  (dry-run — nothing written)`);
      return lines.join("\n");
    }
    case "done":
      return `${p}${ev.ok ? "✓ done" : "✗ finished with errors"}`;
    case "info":
      return `${p}  ${ev.message}`;
    case "progress":
      return `${p}  progress ${ev.done}/${ev.total}`;
    default:
      return `${p}${JSON.stringify(ev)}`;
  }
}

async function dryRunSelected() {
  const jobs = selectedJobs();
  if (jobs.length === 0) {
    appendLog("No jobs selected.", "warn");
    return;
  }
  for (const j of jobs) {
    const err = validateJob(j);
    if (err) {
      appendLog(err, "err");
      return;
    }
  }
  if (!(await ensureVolumesForJobs(jobs))) return;

  setBusy(true);
  summaryEl.innerHTML = "";
  let batchFailed = false;
  let aborted = false;
  let completed = 0;
  const snapshot = jobs.map(snapshotJob);

  try {
    await withLineListener(null, async () => {
      for (const job of snapshot) {
        if (cancelRequested) {
          aborted = true;
          break;
        }
        appendSection(`Dry run · ${job.label}`);
        const args = [
          "plan",
          "-s",
          job.source,
          "-d",
          job.dest,
          ...commonFlags(),
        ];
        const result = await runCli(args);
        if (shouldAbortBatch(result)) {
          aborted = true;
          appendLog(`[${job.label}] cancelled — aborting batch`, "warn");
          break;
        }
        if (result.code !== 0) {
          batchFailed = true;
          appendLog(`[${job.label}] plan exited ${result.code}`, "err");
        } else {
          completed += 1;
        }
      }
    });
    if (aborted) {
      summaryEl.innerHTML = `<strong>Batch cancelled</strong> · completed ${completed}/${snapshot.length}`;
    } else if (batchFailed) {
      summaryEl.innerHTML = `<strong>Dry run finished with errors</strong> · ${completed}/${snapshot.length}`;
    } else {
      summaryEl.innerHTML = `<strong>Dry run complete</strong> · ${snapshot.length} job(s)`;
    }
  } catch (e) {
    appendLog(String(e), "err");
    summaryEl.innerHTML = `<strong>Dry run failed</strong>`;
  } finally {
    setBusy(false);
  }
}

async function syncSelected() {
  const jobs = selectedJobs();
  if (jobs.length === 0) {
    appendLog("No jobs selected.", "warn");
    return;
  }
  for (const j of jobs) {
    const err = validateJob(j);
    if (err) {
      appendLog(err, "err");
      return;
    }
  }
  if (!(await ensureVolumesForJobs(jobs))) return;

  setBusy(true);
  summaryEl.innerHTML = "";
  let aborted = false;
  let failed = false;
  let completed = 0;
  const snapshot = jobs.map(snapshotJob);
  const noDelete = state.noDelete;
  const requireRockbox = state.requireRockbox;

  try {
    await withLineListener(null, async () => {
      for (const job of snapshot) {
        if (cancelRequested || aborted) {
          aborted = true;
          break;
        }
        appendSection(`Sync · ${job.label}`);

        const planPath = await api.invoke("temp_plan_path", { label: job.label });
        try {
          const planArgs = [
            "plan",
            "-s",
            job.source,
            "-d",
            job.dest,
            "-o",
            planPath,
            ...commonFlags(),
          ];
          const planResult = await runCli(planArgs);
          if (shouldAbortBatch(planResult)) {
            aborted = true;
            appendLog(`[${job.label}] cancelled during plan — aborting batch`, "warn");
            break;
          }
          if (planResult.code !== 0) {
            failed = true;
            appendLog(
              `[${job.label}] plan failed (exit ${planResult.code}) — skipping apply`,
              "err",
            );
            continue;
          }

          if (!noDelete) {
            let delCount = 0;
            try {
              delCount = await api.invoke("plan_delete_count", { planPath });
            } catch (e) {
              appendLog(`[${job.label}] could not read plan: ${e}`, "err");
              failed = true;
              continue;
            }
            if (delCount > 0) {
              if (cancelRequested) {
                aborted = true;
                break;
              }
              const ok = await api.invoke("confirm_dialog", {
                title: "Confirm deletions",
                message:
                  `Job “${job.label}” will delete ${delCount} item(s) under:\n\n` +
                  `${job.dest}\n\n` +
                  `Cancel aborts this and all remaining jobs.`,
              });
              if (!ok) {
                appendLog(`[${job.label}] user cancelled — aborting batch`, "warn");
                aborted = true;
                cancelRequested = true;
                break;
              }
            }
          }

          const applyArgs = ["apply", "-p", planPath, "--json-lines"];
          if (requireRockbox) applyArgs.push("--require-rockbox");
          const applyResult = await runCli(applyArgs);
          if (shouldAbortBatch(applyResult)) {
            aborted = true;
            appendLog(`[${job.label}] cancelled during apply — aborting batch`, "warn");
            break;
          }
          if (applyResult.code !== 0) {
            failed = true;
            appendLog(`[${job.label}] apply exited ${applyResult.code}`, "err");
          } else {
            completed += 1;
          }
        } finally {
          try {
            await api.invoke("remove_file_if_exists", { path: planPath });
          } catch {
            /* ignore */
          }
        }
      }
    });

    if (aborted) {
      summaryEl.innerHTML = `<strong>Batch aborted</strong> · completed ${completed}/${snapshot.length}`;
    } else if (failed) {
      summaryEl.innerHTML = `<strong>Finished with errors</strong> · completed ${completed}/${snapshot.length}`;
    } else {
      summaryEl.innerHTML = `<strong>Sync complete</strong> · ${completed} job(s)`;
    }
  } catch (e) {
    appendLog(String(e), "err");
    summaryEl.innerHTML = `<strong>Sync failed</strong>`;
  } finally {
    setBusy(false);
  }
}

async function init() {
  logEl = $("log");
  summaryEl = $("summary");
  jobsEl = $("jobs");

  $("opt-no-delete").checked = state.noDelete;
  $("opt-checksum").checked = state.checksum;
  $("opt-thorough-covers").checked = state.thoroughCovers;
  $("opt-require-rockbox").checked = state.requireRockbox;
  $("opt-verbose").checked = state.verbose;

  $("opt-no-delete").addEventListener("change", (e) => {
    state.noDelete = e.target.checked;
    saveState(state);
  });
  $("opt-checksum").addEventListener("change", (e) => {
    state.checksum = e.target.checked;
    saveState(state);
  });
  $("opt-thorough-covers").addEventListener("change", (e) => {
    state.thoroughCovers = e.target.checked;
    saveState(state);
  });
  $("opt-require-rockbox").addEventListener("change", (e) => {
    state.requireRockbox = e.target.checked;
    saveState(state);
  });
  $("opt-verbose").addEventListener("change", (e) => {
    state.verbose = e.target.checked;
    saveState(state);
  });

  $("btn-add-job").addEventListener("click", () => {
    const category = categories[0] || "Music";
    state.jobs.push({
      id: uid(),
      label: category,
      enabled: true,
      collapsed: false,
      source: "",
      volumeRoot: DEFAULT_VOLUME,
      category,
    });
    saveState(state);
    renderJobs();
  });

  $("btn-expand-jobs").addEventListener("click", () => {
    for (const j of state.jobs) j.collapsed = false;
    saveState(state);
    for (const card of jobsEl.querySelectorAll(".job")) {
      card.classList.remove("is-collapsed");
      const btn = card.querySelector(".job-collapse");
      if (btn) {
        btn.title = "Collapse";
        btn.setAttribute("aria-expanded", "true");
      }
    }
  });
  $("btn-collapse-jobs").addEventListener("click", () => {
    for (const j of state.jobs) j.collapsed = true;
    saveState(state);
    for (const card of jobsEl.querySelectorAll(".job")) {
      card.classList.add("is-collapsed");
      const btn = card.querySelector(".job-collapse");
      if (btn) {
        btn.title = "Expand";
        btn.setAttribute("aria-expanded", "false");
      }
    }
  });

  $("btn-reload-categories").addEventListener("click", async () => {
    await reloadCategories({ quiet: false });
  });

  $("btn-copy-log").addEventListener("click", async () => {
    const text = [logEl.innerText, summaryEl.innerText].filter(Boolean).join("\n").trim();
    if (!text) {
      appendLog("Log is empty — nothing to copy.", "warn");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      appendLog("Log copied to clipboard.", "ok");
    } catch (e) {
      // Fallback for restricted clipboard
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        appendLog("Log copied to clipboard.", "ok");
      } catch (e2) {
        appendLog(`Copy failed: ${e2 || e}`, "err");
      }
    }
  });

  $("btn-clear-log").addEventListener("click", () => {
    logEl.innerHTML = "";
    summaryEl.innerHTML = "";
  });

  $("btn-dry-run").addEventListener("click", () => dryRunSelected());
  $("btn-sync").addEventListener("click", () => syncSelected());
  $("btn-cancel").addEventListener("click", async () => {
    cancelRequested = true;
    try {
      await api.invoke("cancel_theesync");
      appendLog("Cancel requested — aborting batch after current step…", "warn");
    } catch (e) {
      appendLog(String(e), "err");
    }
  });

  try {
    const info = await api.invoke("get_engine_info");
    // Path is for debugging only — log once, don't clutter the header
    appendLog(`Engine ready: ${info.engine}`, "ok");
  } catch (e) {
    appendLog(`Engine error: ${e}`, "err");
    appendLog("Install Node ≥20 and run the UI from the theesync repo.", "warn");
  }

  await reloadCategories({ quiet: true });

  // Volume autocomplete + live mount awareness (/Volumes FS watch in Rust)
  await refreshVolumeMounts();
  await startVolumeAwareness();

  // Re-normalize persisted jobs now that we have real categories
  state.jobs = state.jobs.map((j) => normalizeJob(j, categories));
  saveState(state);
  renderJobs();
  appendLog(`Categories: ${categories.join(", ")} (Reload categories to refresh)`, "ok");
}

if (window.__TAURI__) {
  init();
} else {
  window.addEventListener("DOMContentLoaded", () => {
    document.body.innerHTML =
      "<p style='padding:2rem;font-family:system-ui'>Open with <code>npm run dev</code> inside <code>app/</code> (Tauri).</p>";
  });
}
