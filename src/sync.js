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
import {
  buildActions,
  compareActionsForApply,
  DEFAULT_MTIME_TOLERANCE_MS,
  countActions,
} from './compare.js';
import { copyFileSafe, mkdirSafe } from './copy.js';
import { deleteFileSafe, deleteDirSafe } from './delete.js';
import { createPlan, writePlanFile, readPlanFile, validatePlan } from './plan-file.js';
import { createEmitter, summaryPayload } from './events.js';
import {
  createCategoryTransforms,
  writeJpegForH2,
  jpegNeedsH2Convert,
  rewriteDestAudiobookCover,
  destAudiobookCoverStillNeedsFix,
  collectSidecarCoverAudioUpdates,
} from './transform.js';

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
 *   thoroughCovers?: boolean,
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
  const thoroughCovers = Boolean(options.thoroughCovers);
  const transforms = await resolveTransforms(paths.category, srcWalk.files, emit);
  /** @type {Map<string, boolean>} */
  const destTransformCache = new Map();
  const { actions, skippedUnchanged: skippedInitial } = await buildActions(
    srcWalk.files,
    destFiles,
    srcWalk.dirs,
    destDirs,
    {
      noDelete: options.noDelete,
      checksum: options.checksum,
      mtimeToleranceMs,
      mapDestPath: transforms.mapDestPath,
      contentTransformFor: transforms.contentTransformFor,
      usesMtimeOnlyCompare: transforms.usesMtimeOnlyCompare,
      destStillNeedsTransform: async (srcRel, destAbs) => {
        if (paths.category !== 'Books') return false;
        const cacheKey = `${srcRel}\0${destAbs}`;
        if (destTransformCache.has(cacheKey)) {
          return destTransformCache.get(cacheKey);
        }
        let needs = false;
        try {
          // Folder JPEGs: cheap header check (progressive/size) always
          if (/\.jpe?g$/i.test(srcRel)) {
            needs = await jpegNeedsH2Convert(destAbs);
          } else if (/\.(m4b|m4a)$/i.test(srcRel)) {
            // Audiobook embeds: only re-audit when Thorough covers is on.
            // Normal path rewrites on add/update and when a sidecar image changes.
            if (thoroughCovers) {
              const srcAbs = path.join(paths.source, ...srcRel.split('/'));
              needs = await destAudiobookCoverStillNeedsFix(srcAbs, destAbs);
            }
          }
        } catch (err) {
          emit.emit('warning', {
            message: `Transform re-check failed for ${srcRel}: ${err.message}`,
          });
          needs = false;
        }
        destTransformCache.set(cacheKey, needs);
        return needs;
      },
      onCollision: (dest, sources) => {
        emit.emit('warning', {
          message:
            `Path collision on dest "${dest}": sources ${sources.join(', ')} ` +
            `(using ${sources.find((s) => s === dest) || [...sources].sort()[0]})`,
        });
      },
    },
  );

  let skippedUnchanged = skippedInitial;

  // Sidecar JPEG add/update → also rewrite paired audiobook embeds (Books)
  if (paths.category === 'Books') {
    const { extras, forcedUpdateCount } = collectSidecarCoverAudioUpdates(
      actions,
      srcWalk.files,
      destFiles,
      transforms,
    );
    if (extras.length) {
      actions.push(...extras);
      actions.sort(compareActionsForApply);
      skippedUnchanged = Math.max(0, skippedUnchanged - forcedUpdateCount);
      if (options.verbose) {
        for (const e of extras) {
          emit.emit('action', {
            op: e.type,
            path: e.path,
            sourcePath: e.sourcePath,
            transform: e.transform,
            reason: e.reason,
          });
        }
      }
    }
  }

  const plan = createPlan({
    source: paths.source,
    dest: paths.dest,
    volumeRoot: paths.volumeRoot,
    category: paths.category,
    options: {
      noDelete: options.noDelete,
      checksum: options.checksum,
      mtimeToleranceMs,
      thoroughCovers,
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
        sourcePath: a.sourcePath,
        transform: a.transform,
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

  const transforms = {
    ...createCategoryTransforms(paths.category),
    shouldWriteJpeg: (rel) => paths.category === 'Books' && /\.jpe?g$/i.test(rel),
    shouldRewriteAudiobookCover: (rel) =>
      paths.category === 'Books' && /\.(m4b|m4a)$/i.test(rel),
  };

  for (const action of plan.actions) {
    const destRel = action.path;
    const sourceRel = action.sourcePath || action.path;
    const targetAbs = path.join(paths.dest, ...destRel.split('/'));
    const sourceAbs = path.join(paths.source, ...sourceRel.split('/'));
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
        await materializeFile(sourceAbs, targetAbs, paths.dest, sourceRel, transforms, action, emit);
        summary.added += 1;
        if (options.verbose) {
          emit.emit('action', {
            op: 'add',
            path: action.path,
            sourcePath: action.sourcePath,
            transform: action.transform,
          });
        }
      } else if (action.type === 'update' && action.kind === 'file') {
        assertWritablePath(targetAbs, paths.dest);
        if (!fs.existsSync(sourceAbs)) {
          throw new Error(`Source file missing at apply time: ${sourceAbs}`);
        }
        await materializeFile(sourceAbs, targetAbs, paths.dest, sourceRel, transforms, action, emit);
        summary.updated += 1;
        if (options.verbose) {
          emit.emit('action', {
            op: 'update',
            path: action.path,
            sourcePath: action.sourcePath,
            transform: action.transform,
          });
        }
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

/**
 * Category path mapping + which sources need content transforms (JPEG inspect).
 * @param {string} category
 * @param {Map<string, import('./walk.js').WalkEntry>} sourceFiles
 * @param {{ emit: (type: string, data?: object) => void }} emit
 */
async function resolveTransforms(category, sourceFiles, emit) {
  const base = createCategoryTransforms(category);
  /** @type {Set<string>} */
  const jpegConvert = new Set();

  if (category === 'Books') {
    for (const [rel, ent] of sourceFiles) {
      if (!/\.jpe?g$/i.test(rel)) continue;
      try {
        if (await jpegNeedsH2Convert(ent.abs)) {
          jpegConvert.add(rel);
        }
      } catch (err) {
        emit.emit('warning', {
          message: `JPEG inspect failed for ${rel}: ${err.message}; will convert on write`,
        });
        jpegConvert.add(rel);
      }
    }
  }

  return {
    category,
    mapDestPath: base.mapDestPath,
    contentTransformFor: (rel) => {
      if (jpegConvert.has(rel)) return 'jpeg-h2';
      if (category === 'Books' && /\.m4b$/i.test(rel)) return 'm4b-h2';
      if (category === 'Books' && /\.m4a$/i.test(rel)) return 'm4a-cover';
      return null;
    },
    // Re-encoded JPEGs and re-embedded audiobook covers change dest size.
    usesMtimeOnlyCompare: (rel) => {
      if (jpegConvert.has(rel)) return true;
      if (category === 'Books' && /\.(m4b|m4a)$/i.test(rel)) return true;
      return false;
    },
    /** Live apply: any Books JPEG may need convert even if plan omitted transform. */
    shouldWriteJpeg: (rel) => category === 'Books' && /\.jpe?g$/i.test(rel),
    shouldRewriteAudiobookCover: (rel) =>
      category === 'Books' && /\.(m4b|m4a)$/i.test(rel),
  };
}

/**
 * Write one source file into dest, applying category transforms when needed.
 * Source is never modified.
 * @param {{ emit?: (type: string, data?: object) => void }} [emit]
 */
async function materializeFile(sourceAbs, targetAbs, destRoot, sourceRel, transforms, action, emit) {
  const marked = action.transform === 'jpeg-h2';
  const booksJpeg =
    transforms.shouldWriteJpeg?.(sourceRel) ||
    (transforms.category === 'Books' && /\.jpe?g$/i.test(sourceRel));

  if (marked || booksJpeg) {
    // writeJpegForH2 plain-copies when already baseline and within max edge
    await writeJpegForH2(sourceAbs, targetAbs, destRoot);
    return;
  }

  await copyFileSafe(sourceAbs, targetAbs, destRoot);

  // Books audiobooks: re-embed H2-friendly cover (Rockbox often prefers embedded art).
  const rewriteCover =
    action.transform === 'm4b-h2' ||
    action.transform === 'm4a-cover' ||
    transforms.shouldRewriteAudiobookCover?.(sourceRel);
  if (rewriteCover) {
    const forceCover =
      action.reason === 'sidecar-cover' ||
      (typeof action.reason === 'string' && action.reason.includes('sidecar-cover'));
    try {
      await rewriteDestAudiobookCover(sourceAbs, targetAbs, destRoot, { force: forceCover });
    } catch (err) {
      const head = Buffer.alloc(12);
      let isMp4 = false;
      try {
        const fh = await fs.promises.open(targetAbs, 'r');
        await fh.read(head, 0, 12, 0);
        await fh.close();
        isMp4 = head.slice(4, 8).toString('ascii') === 'ftyp';
      } catch {
        // ignore
      }
      const msg = `Cover rewrite failed for ${sourceRel}: ${err.message}`;
      if (isMp4) {
        // Leave dest mtime far from source so the next plan re-tries (mtime-only
        // compare would otherwise treat the failed copy as settled).
        try {
          const epoch = new Date(0);
          await fs.promises.utimes(targetAbs, epoch, epoch);
        } catch {
          // ignore
        }
        throw new Error(msg);
      }
      // Test placeholders / non-MP4: keep copy, surface once
      emit?.emit?.('warning', { message: msg, path: sourceRel });
    }
  }
}

export { countActions, SafetyError };
