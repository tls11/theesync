/**
 * theesync UI — job list with volume + category dropdowns (C+D).
 * Categories loaded from the Node engine (src/config/categories.js).
 * Dest = volumeRoot + "/" + category (derived, not free-typed).
 */

const STORAGE_KEY = "theesync.jobs.v3";
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

/** Browser-side copy of engine normalizeExcludeRel; invalid → null. */
function normalizeExcludeRelUi(rel) {
  let s = String(rel ?? "").trim().replace(/\\/g, "/");
  if (!s || s.startsWith("/")) return null;
  s = s.replace(/\/+$/, "");
  if (!s) return null;
  const segs = s.split("/");
  if (segs.some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return s;
}

function normalizeStoredList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const n = normalizeExcludeRelUi(item);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function excludeKey(side) {
  return side === "dest" ? "excludeDest" : "excludeSource";
}

function addExclude(job, side, rel) {
  if (running) return false;
  const n = normalizeExcludeRelUi(rel);
  if (!n) return false;
  const key = excludeKey(side);
  if (!Array.isArray(job[key])) job[key] = [];
  if (!job[key].includes(n)) job[key].push(n);
  job[key].sort((a, b) => a.localeCompare(b));
  return true;
}

function toggleExclude(job, side, rel) {
  if (running) return;
  const n = normalizeExcludeRelUi(rel);
  if (!n) return;
  const key = excludeKey(side);
  if (!Array.isArray(job[key])) job[key] = [];
  const i = job[key].indexOf(n);
  if (i >= 0) job[key].splice(i, 1);
  else {
    job[key].push(n);
    job[key].sort((a, b) => a.localeCompare(b));
  }
}

function isUnderPrefixUi(rel, prefix) {
  if (!rel || !prefix) return false;
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/** Stored prefix that covers rel, if any (exact or ancestor). */
function coveringExclude(rel, prefixes) {
  if (!rel || !prefixes) return null;
  for (const p of prefixes) {
    if (isUnderPrefixUi(rel, p)) return p;
  }
  return null;
}

function jobCollapsedSummary(job) {
  const dest = jobDest(job) || "—";
  const skip = (job.excludeSource || []).length;
  const keep = (job.excludeDest || []).length;
  const bits = [dest];
  if (skip) bits.push(`skip ${skip}`);
  if (keep) bits.push(`keep ${keep}`);
  return bits.join(" · ");
}

/** Label for logs/dialogs; dest category if the nickname is empty. */
function jobTitle(job) {
  const label = String(job.label || "").trim();
  if (label) return label;
  return job.category || "Job";
}

function firstUnusedCategory() {
  const used = new Set(state.jobs.map((j) => j.category));
  return categories.find((c) => !used.has(c)) || categories[0] || "Music";
}

function excludeUndoLabel(side) {
  return side === "dest" ? "Don't keep" : "Unskip";
}

function excludeActionLabel(side, selected) {
  if (side === "source") return selected ? "Unskip" : "Skip";
  return selected ? "Don't keep" : "Keep";
}

function excludeOpenLabel(side, n) {
  const base = side === "dest" ? "Keep" : "Skip";
  return n ? `${base} · ${n}` : base;
}

function relUnderRoot(root, abs) {
  const r = String(root || "").replace(/\/+$/, "");
  const a = String(abs || "").replace(/\/+$/, "");
  if (!r || !a) return null;
  if (a === r) return null;
  const prefix = r.endsWith("/") ? r : `${r}/`;
  if (!a.startsWith(prefix)) return null;
  return normalizeExcludeRelUi(a.slice(prefix.length));
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
    excludeSource: [],
    excludeDest: [],
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
    label: raw.label != null ? String(raw.label) : category,
    enabled: raw.enabled !== false,
    collapsed: Boolean(raw.collapsed),
    source: raw.source || "",
    volumeRoot,
    category,
    excludeSource: normalizeStoredList(raw.excludeSource),
    excludeDest: normalizeStoredList(raw.excludeDest),
  };
}

function loadState(categories) {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ||
      localStorage.getItem("theesync.jobs.v2") ||
      localStorage.getItem("theesync.jobs.v1");
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
        excludeSource: normalizeStoredList(j.excludeSource),
        excludeDest: normalizeStoredList(j.excludeDest),
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
  if (busy && folderSheet) closeFolderSheet();
  if (jobsEl) {
    for (const btn of jobsEl.querySelectorAll(".btn-browse-skip, .btn-browse-keep")) {
      btn.disabled = busy;
    }
  }
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

function jobExcludeFlags(job) {
  const flags = [];
  for (const rel of job.excludeSource || []) {
    flags.push("--exclude-source", rel);
  }
  for (const rel of job.excludeDest || []) {
    flags.push("--exclude-dest", rel);
  }
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
        <input type="text" class="job-label" value="${escapeAttr(job.label)}" placeholder="Job name" />
        <span class="job-collapsed-summary" title="${escapeAttr(jobCollapsedSummary(job))}">${escapeAttr(jobCollapsedSummary(job))}</span>
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
            <div class="folder-excludes">
              <div class="folder-excludes-label">Skip</div>
              <p class="job-section-hint">Folder or track, not copied. Already on the card → deleted unless Keep (or No delete).</p>
              <button type="button" class="btn btn-sm btn-browse-skip">${escapeAttr(excludeOpenLabel("source", (job.excludeSource || []).length))}</button>
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
            <div class="folder-excludes">
              <div class="folder-excludes-label">Keep</div>
              <p class="job-section-hint">Folder or track, never library-deleted, even with No delete off. Adds/updates still run.</p>
              <button type="button" class="btn btn-sm btn-browse-keep">${escapeAttr(excludeOpenLabel("dest", (job.excludeDest || []).length))}</button>
            </div>
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
    const collapsedSummary = card.querySelector(".job-collapsed-summary");
    const skipBtn = card.querySelector(".btn-browse-skip");
    const keepBtn = card.querySelector(".btn-browse-keep");

    function syncDestDisplay() {
      destEl.textContent = jobDest(job) || "—";
      const sum = jobCollapsedSummary(job);
      collapsedSummary.textContent = sum;
      collapsedSummary.title = sum;
    }

    skipBtn.disabled = running;
    keepBtn.disabled = running;
    skipBtn.addEventListener("click", () => {
      openFolderSheet(job, "source");
    });
    keepBtn.addEventListener("click", () => {
      openFolderSheet(job, "dest");
    });

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
      job.label = label.value.trim();
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
      saveState(state);
      syncDestDisplay();
      await refreshBadge(job, badge, badgeText);
    });

    card.querySelector(".btn-browse-source").addEventListener("click", async () => {
      const p = await api.invoke("pick_directory", { title: `Source for ${jobTitle(job)}` });
      if (p) {
        job.source = p;
        source.value = p;
        saveState(state);
      }
    });
    card.querySelector(".btn-browse-volume").addEventListener("click", async () => {
      // Opens under /Volumes; always normalizes to card root (not Music/)
      const p = await api.invoke("pick_volume", {
        title: `Select card volume for ${jobTitle(job)} (root of the SD card)`,
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
        `${jobTitle(job)}: ${p.message || "volume not found"} — plug in the card or fix Volume path`,
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

/** @type {{ jobId: string, side: string, rootAbs: string, rel: string, renderId: number } | null} */
let folderSheet = null;
let sheetSelectedHeight = 240;
let sheetRenderSeq = 0;

function refreshExcludeCounts() {
  saveState(state);
  if (!jobsEl) return;
  for (const card of jobsEl.querySelectorAll(".job")) {
    const job = state.jobs.find((j) => j.id === card.dataset.id);
    if (!job) continue;
    const skipBtn = card.querySelector(".btn-browse-skip");
    const keepBtn = card.querySelector(".btn-browse-keep");
    if (skipBtn) skipBtn.textContent = excludeOpenLabel("source", (job.excludeSource || []).length);
    if (keepBtn) keepBtn.textContent = excludeOpenLabel("dest", (job.excludeDest || []).length);
    const summary = card.querySelector(".job-collapsed-summary");
    if (summary) {
      const sum = jobCollapsedSummary(job);
      summary.textContent = sum;
      summary.title = sum;
    }
  }
}

function closeFolderSheet() {
  folderSheet = null;
  const el = $("folder-sheet");
  if (el) el.hidden = true;
  refreshExcludeCounts();
}

async function openFolderSheet(job, side) {
  if (running) return;
  const rootAbs = side === "source" ? job.source : jobDest(job);
  if (!rootAbs) {
    appendLog(
      side === "source"
        ? `${jobTitle(job)}: set a source first.`
        : `${jobTitle(job)}: set volume and category first.`,
      "warn",
    );
    return;
  }
  try {
    const exists = await api.invoke("path_exists", { path: rootAbs });
    if (!exists) {
      appendLog(
        side === "source"
          ? `${jobTitle(job)}: source folder not found.`
          : `${jobTitle(job)}: category folder is not on the card yet — sync once, then Keep.`,
        "warn",
      );
      return;
    }
  } catch (e) {
    appendLog(`Could not check folder: ${e}`, "err");
    return;
  }

  folderSheet = { jobId: job.id, side, rootAbs, rel: "", renderId: 0 };
  $("folder-sheet-title").textContent = side === "source" ? "Skip from source" : "Keep on dest";
  $("folder-sheet").hidden = false;
  await renderFolderSheet();
}

function currentSheetAbs() {
  if (!folderSheet) return "";
  return folderSheet.rel ? `${folderSheet.rootAbs}/${folderSheet.rel}` : folderSheet.rootAbs;
}

async function renderFolderSheet() {
  if (!folderSheet) return;
  const renderId = ++sheetRenderSeq;
  folderSheet.renderId = renderId;
  const listingRel = folderSheet.rel;
  const listingJobId = folderSheet.jobId;
  const listingAbs = currentSheetAbs();
  const job = state.jobs.find((j) => j.id === listingJobId);
  if (!job) {
    closeFolderSheet();
    return;
  }
  const list = job[excludeKey(folderSheet.side)] || [];
  const selectedEl = $("folder-sheet-selected");
  const splitHandle = $("folder-sheet-split");
  const crumb = $("folder-sheet-crumb");
  const listEl = $("folder-sheet-list");
  const currentEl = $("folder-sheet-current");
  const toggleBtn = $("folder-sheet-toggle");

  selectedEl.replaceChildren();
  if (list.length === 0) {
    selectedEl.hidden = true;
    splitHandle.hidden = true;
  } else {
    selectedEl.hidden = false;
    splitHandle.hidden = false;
    selectedEl.style.height = `${sheetSelectedHeight}px`;
    const heading = document.createElement("div");
    heading.className = "sheet-selected-head";
    const headingLabel = document.createElement("div");
    headingLabel.className = "sheet-selected-label";
    headingLabel.textContent =
      folderSheet.side === "source" ? `Skipped · ${list.length}` : `Keeping · ${list.length}`;
    const clearAll = document.createElement("button");
    clearAll.type = "button";
    clearAll.className = "btn btn-sm btn-ghost";
    clearAll.textContent = "Clear all";
    clearAll.addEventListener("click", () => {
      if (running || !folderSheet) return;
      job[excludeKey(folderSheet.side)] = [];
      saveState(state);
      renderFolderSheet();
    });
    heading.appendChild(headingLabel);
    heading.appendChild(clearAll);
    selectedEl.appendChild(heading);
    for (const rel of list) {
      const row = document.createElement("div");
      row.className = "exclude-row";
      const pathEl = document.createElement("span");
      pathEl.className = "exclude-row-path";
      pathEl.textContent = rel;
      const act = document.createElement("button");
      act.type = "button";
      act.className = "btn btn-sm btn-secondary";
      act.textContent = excludeUndoLabel(folderSheet.side);
      act.addEventListener("click", () => {
        toggleExclude(job, folderSheet.side, rel);
        saveState(state);
        renderFolderSheet();
      });
      row.appendChild(pathEl);
      row.appendChild(act);
      selectedEl.appendChild(row);
    }
  }

  crumb.replaceChildren();
  const parts = folderSheet.rel ? folderSheet.rel.split("/") : [];
  const rootBtn = document.createElement("button");
  rootBtn.type = "button";
  rootBtn.className = "sheet-crumb-btn";
  rootBtn.textContent = folderSheet.side === "source" ? "Source" : "Card";
  rootBtn.addEventListener("click", () => {
    folderSheet.rel = "";
    renderFolderSheet();
  });
  crumb.appendChild(rootBtn);
  parts.forEach((part, i) => {
    crumb.appendChild(document.createTextNode(" / "));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sheet-crumb-btn";
    btn.textContent = part;
    btn.addEventListener("click", () => {
      folderSheet.rel = parts.slice(0, i + 1).join("/");
      renderFolderSheet();
    });
    crumb.appendChild(btn);
  });

  if (folderSheet.rel && !coveringExclude(folderSheet.rel, list)) {
    currentEl.hidden = false;
    toggleBtn.textContent =
      folderSheet.side === "source" ? "Skip this folder" : "Keep this folder";
  } else {
    currentEl.hidden = true;
  }

  listEl.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "sheet-loading";
  loading.textContent = "Loading…";
  listEl.appendChild(loading);

  try {
    const result = await api.invoke("list_subdirs", { root: listingAbs });
    if (!folderSheet || folderSheet.renderId !== renderId || folderSheet.jobId !== listingJobId) {
      return;
    }
    const dirs = result?.dirs || [];
    const files = result?.files || [];
    listEl.replaceChildren();
    if (dirs.length === 0 && files.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sheet-empty";
      empty.textContent = "No folders or files";
      listEl.appendChild(empty);
      return;
    }

    function appendRow(name, isDir) {
      const childRel = listingRel ? `${listingRel}/${name}` : name;
      const cover = coveringExclude(childRel, list);
      const row = document.createElement("div");
      row.className =
        "sheet-row" +
        (cover ? " is-selected" : "") +
        (isDir ? "" : " is-file");
      const nameEl = document.createElement(isDir ? "button" : "span");
      nameEl.className = "sheet-row-name";
      nameEl.textContent = name;
      if (isDir) {
        nameEl.type = "button";
        nameEl.addEventListener("click", () => {
          if (!folderSheet) return;
          folderSheet.rel = childRel;
          renderFolderSheet();
        });
      }
      row.appendChild(nameEl);
      if (cover) {
        const status = document.createElement("span");
        status.className = "sheet-row-status";
        const viaParent = cover !== childRel;
        if (folderSheet.side === "source") {
          status.textContent = viaParent ? `Skipped via ${cover}` : "Skipped";
        } else {
          status.textContent = viaParent ? `Keeping via ${cover}` : "Keeping";
        }
        row.appendChild(status);
      } else {
        const act = document.createElement("button");
        act.type = "button";
        act.className = "btn btn-sm btn-primary";
        act.textContent = excludeActionLabel(folderSheet.side, false);
        act.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleExclude(job, folderSheet.side, childRel);
          saveState(state);
          renderFolderSheet();
        });
        row.appendChild(act);
      }
      listEl.appendChild(row);
    }

    for (const name of dirs) appendRow(name, true);
    for (const name of files) appendRow(name, false);
  } catch (e) {
    if (!folderSheet || folderSheet.renderId !== renderId) return;
    listEl.replaceChildren();
    const err = document.createElement("p");
    err.className = "sheet-empty";
    err.textContent = String(e);
    listEl.appendChild(err);
  }
}

async function pickExcludeInFinder() {
  if (!folderSheet || running) return;
  const jobId = folderSheet.jobId;
  const side = folderSheet.side;
  const rootAbs = folderSheet.rootAbs;
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;
  const p = await api.invoke("pick_directory", {
    title: side === "source" ? "Skip folder" : "Keep folder",
    directory: currentSheetAbs(),
  });
  if (!p) return;
  if (!folderSheet || folderSheet.jobId !== jobId || folderSheet.side !== side) return;
  const rel = relUnderRoot(rootAbs, p);
  if (!rel) {
    appendLog("Pick a folder inside the job root (not the root itself).", "warn");
    return;
  }
  addExclude(job, side, rel);
  saveState(state);
  await renderFolderSheet();
}

function wireFolderSheet() {
  const sheet = $("folder-sheet");
  if (!sheet) return;
  sheet.querySelectorAll("[data-sheet-close]").forEach((el) => {
    el.addEventListener("click", () => closeFolderSheet());
  });
  $("folder-sheet-done").addEventListener("click", () => closeFolderSheet());
  $("folder-sheet-finder").addEventListener("click", () => {
    pickExcludeInFinder().catch((e) => appendLog(String(e), "err"));
  });
  $("folder-sheet-toggle").addEventListener("click", () => {
    if (!folderSheet?.rel) return;
    const job = state.jobs.find((j) => j.id === folderSheet.jobId);
    if (!job) return;
    toggleExclude(job, folderSheet.side, folderSheet.rel);
    saveState(state);
    renderFolderSheet();
  });
  const handle = $("folder-sheet-split");
  const selectedEl = $("folder-sheet-selected");
  let splitDragging = false;
  let splitStartY = 0;
  let splitStartH = 0;
  handle.addEventListener("pointerdown", (e) => {
    if (selectedEl.hidden) return;
    splitDragging = true;
    splitStartY = e.clientY;
    splitStartH = selectedEl.getBoundingClientRect().height;
    handle.classList.add("is-dragging");
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!splitDragging) return;
    const split = handle.parentElement;
    const minH = 88;
    const maxH = Math.max(minH, (split?.clientHeight || 400) - 150);
    const h = Math.max(minH, Math.min(maxH, splitStartH + (e.clientY - splitStartY)));
    sheetSelectedHeight = h;
    selectedEl.style.height = `${h}px`;
  });
  const endSplitDrag = () => {
    splitDragging = false;
    handle.classList.remove("is-dragging");
  };
  handle.addEventListener("pointerup", endSplitDrag);
  handle.addEventListener("pointercancel", endSplitDrag);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && folderSheet) {
      closeFolderSheet();
    }
  });
}

function validateJob(job) {
  if (!job.source) return `${jobTitle(job)}: missing source`;
  if (!job.volumeRoot) return `${jobTitle(job)}: missing volume`;
  if (!job.category) return `${jobTitle(job)}: missing category`;
  if (!categories.includes(job.category)) {
    return `${jobTitle(job)}: category "${job.category}" not allowlisted (reload categories?)`;
  }
  if (!jobDest(job)) return `${jobTitle(job)}: could not build dest`;
  return null;
}

/**
 * Snapshot for a run: freeze dest path and exclude lists at start.
 */
function snapshotJob(job) {
  return {
    ...job,
    dest: jobDest(job),
    excludeSource: [...(job.excludeSource || [])],
    excludeDest: [...(job.excludeDest || [])],
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
    case "start": {
      let line = `${p}→ ${ev.phase || "sync"}: ${ev.source || ""} → ${ev.dest || ""}`;
      const skipN = Array.isArray(ev.excludeSource) ? ev.excludeSource.length : 0;
      const keepN = Array.isArray(ev.excludeDest) ? ev.excludeDest.length : 0;
      if (skipN || keepN) {
        const bits = [];
        if (skipN) bits.push(`skip ${skipN}`);
        if (keepN) bits.push(`keep ${keepN}`);
        line += ` (${bits.join(", ")})`;
      }
      return line;
    }
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
        appendSection(`Dry run · ${jobTitle(job)}`);
        const args = [
          "plan",
          "-s",
          job.source,
          "-d",
          job.dest,
          ...commonFlags(),
          ...jobExcludeFlags(job),
        ];
        const result = await runCli(args);
        if (shouldAbortBatch(result)) {
          aborted = true;
          appendLog(`[${jobTitle(job)}] cancelled — aborting batch`, "warn");
          break;
        }
        if (result.code !== 0) {
          batchFailed = true;
          appendLog(`[${jobTitle(job)}] plan exited ${result.code}`, "err");
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
        appendSection(`Sync · ${jobTitle(job)}`);

        const planPath = await api.invoke("temp_plan_path", { label: jobTitle(job) });
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
            ...jobExcludeFlags(job),
          ];
          const planResult = await runCli(planArgs);
          if (shouldAbortBatch(planResult)) {
            aborted = true;
            appendLog(`[${jobTitle(job)}] cancelled during plan — aborting batch`, "warn");
            break;
          }
          if (planResult.code !== 0) {
            failed = true;
            appendLog(
              `[${jobTitle(job)}] plan failed (exit ${planResult.code}) — skipping apply`,
              "err",
            );
            continue;
          }

          if (!noDelete) {
            let delCount = 0;
            try {
              delCount = await api.invoke("plan_delete_count", { planPath });
            } catch (e) {
              appendLog(`[${jobTitle(job)}] could not read plan: ${e}`, "err");
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
                  `Job “${jobTitle(job)}” will delete ${delCount} item(s) under:\n\n` +
                  `${job.dest}\n\n` +
                  `Cancel aborts this and all remaining jobs.`,
              });
              if (!ok) {
                appendLog(`[${jobTitle(job)}] user cancelled — aborting batch`, "warn");
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
            appendLog(`[${jobTitle(job)}] cancelled during apply — aborting batch`, "warn");
            break;
          }
          if (applyResult.code !== 0) {
            failed = true;
            appendLog(`[${jobTitle(job)}] apply exited ${applyResult.code}`, "err");
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
  wireFolderSheet();

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
    const category = firstUnusedCategory();
    const id = uid();
    state.jobs.push({
      id,
      label: "",
      enabled: true,
      collapsed: false,
      source: "",
      volumeRoot: DEFAULT_VOLUME,
      category,
      excludeSource: [],
      excludeDest: [],
    });
    saveState(state);
    renderJobs();
    const input = jobsEl.querySelector(`.job[data-id="${id}"] .job-label`);
    if (input) input.focus();
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
