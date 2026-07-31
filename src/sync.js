/**
 * Sync engine: plan (scan+compare) and apply (execute plan, no re-scan).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  resolveJobPaths,
  assertWritablePath,
  assertDeletablePath,
  assertDestNotSymlink,
  SafetyError,
  resolveAbs,
} from './safety.js';
import { walkTree, isMacOsMetadataPath } from './walk.js';
import { buildActions, DEFAULT_MTIME_TOLERANCE_MS, countActions } from './compare.js';
import { copyFileSafe, mkdirSafe } from './copy.js';
import { deleteFileSafe, deleteDirSafe } from './delete.js';
import { createPlan, writePlanFile, readPlanFile, validatePlan } from './plan-file.js';
import { createEmitter, summaryPayload } from './events.js';

/**
 * @typedef {{
 *   source: string,
 *   dest: string,
 *   category?: string,
 *   dryRun?: boolean,
 *   noDelete?: boolean,
 *   checksum?: boolean,
 *   mtimeToleranceMs?: number,
 *   requireRockbox?: boolean,
 *   writePlan?: string,
 *   jsonLines?: boolean,
 *   verbose?: boolean,
 *   emit?: ReturnType<typeof createEmitter>
 * }} SyncOptions
 */

/**
 * Run plan phase: walk source + dest, compare, optionally write plan file.
 * Read-only — never mutates dest.
 */
export async function planJob(options) {
  const emit = options.emit || createEmitter({
    jsonLines: options.jsonLines,
    verbose: options.verbose,
  });

  const paths = resolveJobPaths({
    source: options.source,
    dest: options.dest,
    category: options.category,
    requireRockbox: options.requireRockbox,
  });

  for (const w of paths.warnings) {
    emit.emit('warning', { message: w });
  }

  emit.emit('start', {
    phase: 'plan',
    source: paths.source,
    dest: paths.dest,
    category: paths.category,
    volumeRoot: paths.volumeRoot,
  });

  // Dest may not exist yet — treat as empty
  let destFiles = new Map();
  let destDirs = new Map();
  let destSkipped = 0;
  let destWarnings = [];

  if (fs.existsSync(paths.dest)) {
    assertDestNotSymlink(paths.dest);
    // Inventory hidden on dest so we can delete macOS ._* / .DS_Store clutter.
    // Those deletes are counted separately (deleteJunk) and only logged when verbose.
    const destWalk = await walkTree(paths.dest, {
      includeHidden: true,
      onSkip: (rel, reason) => {
        if (options.verbose) emit.emit('action', { op: 'skip', path: rel, reason: `dest-${reason}` });
      },
    });
    destFiles = destWalk.files;
    destDirs = destWalk.dirs;
    destSkipped = destWalk.skipped;
    destWarnings = destWalk.warnings;
  }

  // Source: never copy hidden macOS metadata
  const srcWalk = await walkTree(paths.source, {
    includeHidden: false,
    onSkip: (rel, reason) => {
      if (options.verbose) emit.emit('action', { op: 'skip', path: rel, reason: `source-${reason}` });
    },
  });

  for (const w of [...srcWalk.warnings, ...destWarnings]) {
    emit.emit('warning', { message: w });
  }

  emit.emit('scan', {
    side: 'source',
    files: srcWalk.files.size,
    dirs: srcWalk.dirs.size,
    skipped: srcWalk.skipped,
  });
  // Dest inventory includes macOS metadata for cleanup; report library-visible counts by default
  let destLibFiles = 0;
  let destLibDirs = 0;
  let destMetaFiles = 0;
  for (const rel of destFiles.keys()) {
    if (isMacOsMetadataPath(rel)) destMetaFiles += 1;
    else destLibFiles += 1;
  }
  for (const rel of destDirs.keys()) {
    if (!isMacOsMetadataPath(rel)) destLibDirs += 1;
  }
  emit.emit('scan', {
    side: 'dest',
    files: options.verbose ? destFiles.size : destLibFiles,
    dirs: options.verbose ? destDirs.size : destLibDirs,
    skipped: destSkipped,
    ...(options.verbose && destMetaFiles
      ? { metadataFiles: destMetaFiles }
      : {}),
  });

  const mtimeToleranceMs = options.mtimeToleranceMs ?? DEFAULT_MTIME_TOLERANCE_MS;
  const { actions, skippedUnchanged } = await buildActions(
    srcWalk.files,
    destFiles,
    srcWalk.dirs,
    destDirs,
    {
      noDelete: options.noDelete,
      checksum: options.checksum,
      mtimeToleranceMs,
    },
  );

  const plan = createPlan({
    source: paths.source,
    dest: paths.dest,
    volumeRoot: paths.volumeRoot,
    category: paths.category,
    options: {
      noDelete: options.noDelete,
      checksum: options.checksum,
      mtimeToleranceMs,
    },
    actions,
    skippedUnchanged,
    skippedWalk: srcWalk.skipped + destSkipped,
  });

  const counts = plan.counts;
  emit.emit('plan', {
    add: counts.add,
    update: counts.update,
    delete: counts.delete,
    deleteJunk: counts.deleteJunk,
    addFiles: counts.addFiles,
    addDirs: counts.addDirs,
    deleteFiles: counts.deleteFiles,
    deleteDirs: counts.deleteDirs,
    skippedUnchanged: counts.skippedUnchanged,
  });

  if (options.verbose) {
    for (const a of actions) {
      const junk = a.type === 'delete' && isMacOsMetadataPath(a.path);
      emit.emit('action', {
        op: a.type,
        path: a.path,
        kind: a.kind,
        reason: junk ? 'macos-metadata' : a.reason,
        junk: junk || undefined,
      });
    }
  }

  if (options.writePlan) {
    const p = await writePlanFile(options.writePlan, plan);
    emit.emit('info', { message: `plan written: ${p}` });
  }

  return { plan, paths, emit };
}

/**
 * Apply a plan file: re-validate roots, execute actions, no full re-scan.
 */
export async function applyPlan(planOrPath, options = {}) {
  const emit = options.emit || createEmitter({
    jsonLines: options.jsonLines,
    verbose: options.verbose,
  });

  let plan;
  if (typeof planOrPath === 'string') {
    plan = await readPlanFile(planOrPath);
  } else {
    validatePlan(planOrPath);
    plan = planOrPath;
  }

  // Re-validate dest safety (category allowlist, not dangerous, rockbox probe)
  const paths = resolveJobPaths({
    source: plan.roots.source,
    dest: plan.roots.dest,
    requireRockbox: options.requireRockbox,
  });

  // Roots must still match plan
  if (resolveAbs(paths.dest) !== resolveAbs(plan.roots.dest)) {
    throw new SafetyError(
      `Plan dest mismatch: plan=${plan.roots.dest} resolved=${paths.dest}`,
      'PLAN_ROOT_MISMATCH',
    );
  }
  if (resolveAbs(paths.source) !== resolveAbs(plan.roots.source)) {
    throw new SafetyError(
      `Plan source mismatch: plan=${plan.roots.source} resolved=${paths.source}`,
      'PLAN_ROOT_MISMATCH',
    );
  }

  for (const w of paths.warnings) {
    emit.emit('warning', { message: w });
  }

  emit.emit('start', {
    phase: 'apply',
    source: paths.source,
    dest: paths.dest,
    category: paths.category,
  });

  // Ensure category dest exists (real dir, not symlink)
  if (!fs.existsSync(paths.dest)) {
    assertWritablePath(paths.dest, paths.dest);
    await fs.promises.mkdir(paths.dest, { recursive: true });
    emit.emit('info', { message: `created category dir: ${paths.dest}` });
  } else {
    assertDestNotSymlink(paths.dest);
  }

  const summary = {
    added: 0,
    updated: 0,
    deleted: 0,
    junkCleaned: 0,
    skipped: plan.counts?.skippedUnchanged ?? 0,
    failed: 0,
    failures: [],
  };

  const total = plan.actions.length;
  let done = 0;

  for (const action of plan.actions) {
    const targetAbs = path.join(paths.dest, ...action.path.split('/'));
    const sourceAbs = path.join(paths.source, ...action.path.split('/'));
    const isJunk = action.type === 'delete' && isMacOsMetadataPath(action.path);

    try {
      if (action.type === 'add' && action.kind === 'dir') {
        assertWritablePath(targetAbs, paths.dest);
        await mkdirSafe(targetAbs, paths.dest);
        summary.added += 1;
        if (options.verbose) emit.emit('action', { op: 'mkdir', path: action.path });
      } else if (action.type === 'add' && action.kind === 'file') {
        assertWritablePath(targetAbs, paths.dest);
        if (!fs.existsSync(sourceAbs)) {
          throw new Error(`Source file missing at apply time: ${sourceAbs}`);
        }
        // Use live source mtime (not plan-time) so content and mtime stay consistent
        await copyFileSafe(sourceAbs, targetAbs, paths.dest);
        summary.added += 1;
        if (options.verbose) emit.emit('action', { op: 'add', path: action.path });
      } else if (action.type === 'update' && action.kind === 'file') {
        assertWritablePath(targetAbs, paths.dest);
        if (!fs.existsSync(sourceAbs)) {
          throw new Error(`Source file missing at apply time: ${sourceAbs}`);
        }
        await copyFileSafe(sourceAbs, targetAbs, paths.dest);
        summary.updated += 1;
        if (options.verbose) emit.emit('action', { op: 'update', path: action.path });
      } else if (action.type === 'delete' && action.kind === 'file') {
        assertDeletablePath(targetAbs, paths.dest);
        await deleteFileSafe(targetAbs, paths.dest);
        if (isJunk) summary.junkCleaned += 1;
        else summary.deleted += 1;
        if (options.verbose) {
          emit.emit('action', {
            op: 'delete',
            path: action.path,
            reason: isJunk ? 'macos-metadata' : action.reason,
            junk: isJunk || undefined,
          });
        }
      } else if (action.type === 'delete' && action.kind === 'dir') {
        assertDeletablePath(targetAbs, paths.dest);
        // Non-recursive: plan must have emptied the dir via file deletes first
        await deleteDirSafe(targetAbs, paths.dest, { recursive: false });
        if (isJunk) summary.junkCleaned += 1;
        else summary.deleted += 1;
        if (options.verbose) {
          emit.emit('action', {
            op: 'delete',
            path: action.path,
            reason: isJunk ? 'macos-metadata' : action.reason,
            junk: isJunk || undefined,
          });
        }
      } else {
        throw new Error(`Unknown action: ${action.type}/${action.kind}`);
      }
    } catch (err) {
      summary.failed += 1;
      summary.failures.push({ path: action.path, message: err.message });
      emit.emit('error', { message: err.message, path: action.path });
    }

    done += 1;
    if (total > 20 && done % Math.ceil(total / 10) === 0) {
      emit.emit('progress', { done, total });
    }
  }

  if (total > 0) {
    emit.emit('progress', { done: total, total });
  }

  emit.emit('summary', summaryPayload({
    added: summary.added,
    updated: summary.updated,
    deleted: summary.deleted,
    junkCleaned: summary.junkCleaned,
    skipped: summary.skipped,
    failed: summary.failed,
    dryRun: false,
    failures: summary.failures,
  }));
  emit.emit('done', { ok: summary.failed === 0 });

  return { summary, paths, plan };
}

/**
 * One-shot: plan then optionally apply (unless dryRun).
 */
export async function syncJob(options) {
  const emit = options.emit || createEmitter({
    jsonLines: options.jsonLines,
    verbose: options.verbose,
  });
  options.emit = emit;

  const { plan, paths } = await planJob(options);

  if (options.dryRun) {
    emit.emit('summary', summaryPayload({
      added: plan.counts.add,
      updated: plan.counts.update,
      deleted: plan.counts.delete,
      junkCleaned: plan.counts.deleteJunk,
      skipped: plan.counts.skippedUnchanged,
      failed: 0,
      dryRun: true,
    }));
    emit.emit('done', { ok: true, dryRun: true });
    return { plan, paths, summary: null, dryRun: true };
  }

  // Apply in-process without re-scan
  const result = await applyPlan(plan, { ...options, emit });
  return { plan, paths, summary: result.summary, dryRun: false };
}

/**
 * Plan-only entry (always dry regarding dest mutations).
 */
export async function runPlan(options) {
  const emit = options.emit || createEmitter({
    jsonLines: options.jsonLines,
    verbose: options.verbose,
  });
  options.emit = emit;
  options.dryRun = true;

  const { plan, paths } = await planJob(options);

  emit.emit('summary', summaryPayload({
    added: plan.counts.add,
    updated: plan.counts.update,
    deleted: plan.counts.delete,
    junkCleaned: plan.counts.deleteJunk,
    skipped: plan.counts.skippedUnchanged,
    failed: 0,
    dryRun: true,
  }));
  emit.emit('done', { ok: true, dryRun: true });

  return { plan, paths };
}

/**
 * Apply from plan file path.
 */
export async function runApply(planPath, options = {}) {
  return applyPlan(planPath, options);
}

export { countActions, SafetyError };
