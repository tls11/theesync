/**
 * Change detection: relative path + size + mtime (FAT32-friendly tolerance).
 * Optional streamed checksum when sizes match and --checksum is set.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';

export const DEFAULT_MTIME_TOLERANCE_MS = 3000;

/**
 * @typedef {'add'|'update'|'delete'|'skip'} ActionType
 */

/**
 * @typedef {{
 *   type: 'add'|'update'|'delete',
 *   path: string,
 *   sourcePath?: string,
 *   kind: 'file'|'dir',
 *   size?: number,
 *   mtimeMs?: number,
 *   reason?: string,
 *   transform?: string
 * }} PlanAction
 */

/**
 * Compare source and dest inventories; build mutable actions only.
 *
 * `path` on file actions is always the **dest** relative path. When the
 * category remaps names (e.g. Books `.m4b` → `.m4a`), `sourcePath` holds
 * the source-relative path. Deletes use dest paths only.
 *
 * @param {Map<string, import('./walk.js').WalkEntry>} sourceFiles
 * @param {Map<string, import('./walk.js').WalkEntry>} destFiles
 * @param {Map<string, import('./walk.js').WalkEntry>} sourceDirs
 * @param {Map<string, import('./walk.js').WalkEntry>} destDirs
 * @param {{
 *   noDelete?: boolean,
 *   checksum?: boolean,
 *   mtimeToleranceMs?: number,
 *   hashAlgo?: string,
 *   mapDestPath?: (sourceRel: string) => string,
 *   contentTransformFor?: (sourceRel: string) => string|null|undefined,
 *   usesMtimeOnlyCompare?: (sourceRel: string) => boolean,
 *   destStillNeedsTransform?: (sourceRel: string, destAbs: string) => boolean|Promise<boolean>,
 *   onCollision?: (dest: string, sources: string[]) => void
 * }} options
 */
export async function buildActions(sourceFiles, destFiles, sourceDirs, destDirs, options = {}) {
  const mtimeTol = options.mtimeToleranceMs ?? DEFAULT_MTIME_TOLERANCE_MS;
  const noDelete = Boolean(options.noDelete);
  const useChecksum = Boolean(options.checksum);
  const hashAlgo = options.hashAlgo || 'sha256';
  const mapDest = options.mapDestPath || ((rel) => rel);
  const contentTransformFor = options.contentTransformFor || (() => null);
  const usesMtimeOnly =
    options.usesMtimeOnlyCompare || ((rel) => Boolean(contentTransformFor(rel)));

  /** @type {PlanAction[]} */
  const actions = [];
  let skippedUnchanged = 0;

  // Dest path → chosen source path (handles m4b/m4a collisions)
  /** @type {Map<string, string>} */
  const destToSource = new Map();
  /** @type {Map<string, string[]>} */
  const destBuckets = new Map();
  for (const srcRel of sourceFiles.keys()) {
    const destRel = mapDest(srcRel);
    if (!destBuckets.has(destRel)) destBuckets.set(destRel, []);
    destBuckets.get(destRel).push(srcRel);
  }
  for (const [destRel, sources] of destBuckets) {
    if (sources.length > 1) {
      options.onCollision?.(destRel, sources);
      // Prefer source that already matches dest name, else lexical
      const preferred =
        sources.find((s) => s === destRel) ||
        [...sources].sort((a, b) => a.localeCompare(b))[0];
      destToSource.set(destRel, preferred);
    } else {
      destToSource.set(destRel, sources[0]);
    }
  }

  // Ensure parent dirs exist on dest for adds (mkdir actions).
  // Dir paths use the same dest mapping as files (e.g. Books ASCII sanitize).
  /** @type {Set<string>} */
  const ownedDestDirs = new Set();
  for (const [rel, sDir] of sourceDirs) {
    const destRel = mapDest(rel);
    ownedDestDirs.add(destRel);
    if (!destDirs.has(destRel)) {
      actions.push({
        type: 'add',
        path: destRel,
        sourcePath: rel !== destRel ? rel : undefined,
        kind: 'dir',
        mtimeMs: sDir.mtimeMs,
      });
    }
  }

  for (const [destRel, srcRel] of destToSource) {
    const sFile = sourceFiles.get(srcRel);
    if (!sFile) continue;

    const transform = contentTransformFor(srcRel) || undefined;
    const sourcePath = srcRel !== destRel ? srcRel : undefined;
    const mtimeOnly = usesMtimeOnly(srcRel);

    const dFile = destFiles.get(destRel);
    if (!dFile) {
      actions.push({
        type: 'add',
        path: destRel,
        sourcePath,
        kind: 'file',
        size: sFile.size,
        mtimeMs: sFile.mtimeMs,
        reason: 'missing',
        transform,
      });
      continue;
    }

    // Content transforms (e.g. JPEG re-encode, cover re-embed) change size;
    // treat as unchanged when mtimes match — unless dest still fails H2 checks
    // (e.g. progressive JPEG left by an older convert path).
    if (mtimeOnly) {
      const mtimeDiff = Math.abs(sFile.mtimeMs - dFile.mtimeMs);
      if (mtimeDiff > mtimeTol) {
        actions.push({
          type: 'update',
          path: destRel,
          sourcePath,
          kind: 'file',
          size: sFile.size,
          mtimeMs: sFile.mtimeMs,
          reason: 'mtime',
          transform,
        });
      } else if (
        options.destStillNeedsTransform &&
        (await options.destStillNeedsTransform(srcRel, dFile.abs))
      ) {
        actions.push({
          type: 'update',
          path: destRel,
          sourcePath,
          kind: 'file',
          size: sFile.size,
          mtimeMs: sFile.mtimeMs,
          reason: 'transform',
          transform,
        });
      } else {
        skippedUnchanged += 1;
      }
      continue;
    }

    if (sFile.size !== dFile.size) {
      actions.push({
        type: 'update',
        path: destRel,
        sourcePath,
        kind: 'file',
        size: sFile.size,
        mtimeMs: sFile.mtimeMs,
        reason: 'size',
        transform,
      });
      continue;
    }

    const mtimeDiff = Math.abs(sFile.mtimeMs - dFile.mtimeMs);
    if (mtimeDiff > mtimeTol) {
      if (useChecksum) {
        const same = await filesMatchChecksum(sFile.abs, dFile.abs, hashAlgo);
        if (same) {
          skippedUnchanged += 1;
          continue;
        }
        actions.push({
          type: 'update',
          path: destRel,
          sourcePath,
          kind: 'file',
          size: sFile.size,
          mtimeMs: sFile.mtimeMs,
          reason: 'checksum',
          transform,
        });
      } else {
        actions.push({
          type: 'update',
          path: destRel,
          sourcePath,
          kind: 'file',
          size: sFile.size,
          mtimeMs: sFile.mtimeMs,
          reason: 'mtime',
          transform,
        });
      }
      continue;
    }

    // sizes match and mtimes within tolerance
    if (useChecksum) {
      const same = await filesMatchChecksum(sFile.abs, dFile.abs, hashAlgo);
      if (!same) {
        actions.push({
          type: 'update',
          path: destRel,
          sourcePath,
          kind: 'file',
          size: sFile.size,
          mtimeMs: sFile.mtimeMs,
          reason: 'checksum',
          transform,
        });
        continue;
      }
    }

    skippedUnchanged += 1;
  }

  if (!noDelete) {
    // Delete dest files not owned by any mapped source path
    for (const [rel] of destFiles) {
      if (!destToSource.has(rel)) {
        actions.push({
          type: 'delete',
          path: rel,
          kind: 'file',
          reason: 'dest-only',
        });
      }
    }

    // Delete dest dirs not owned by mapped source dirs (deepest first — apply sorts)
    for (const [rel] of destDirs) {
      if (!ownedDestDirs.has(rel)) {
        actions.push({
          type: 'delete',
          path: rel,
          kind: 'dir',
          reason: 'dest-only',
        });
      }
    }
  }

  // Sort for safe apply (deletes before adds so file↔dir type flips work):
  // 1. file deletes
  // 2. dir deletes (deepest first)
  // 3. dir adds (shallow first)
  // 4. file adds
  // 5. file updates
  actions.sort(compareActionsForApply);

  return { actions, skippedUnchanged };
}

/**
 * Apply order: clear dest-only / kind conflicts first, then create.
 * File↔dir at the same relative path: delete dir (after children) then add file,
 * or delete file then add dir — requires deletes before adds.
 */
export function compareActionsForApply(a, b) {
  const order = (x) => {
    if (x.type === 'delete' && x.kind === 'file') return 0;
    if (x.type === 'delete' && x.kind === 'dir') return 1;
    if (x.type === 'add' && x.kind === 'dir') return 2;
    if (x.type === 'add' && x.kind === 'file') return 3;
    if (x.type === 'update') return 4;
    return 5;
  };
  const oa = order(a);
  const ob = order(b);
  if (oa !== ob) return oa - ob;

  // dir deletes: deepest first
  if (a.type === 'delete' && a.kind === 'dir') {
    const da = a.path.split('/').length;
    const db = b.path.split('/').length;
    if (da !== db) return db - da;
    return b.path.localeCompare(a.path);
  }

  // dir adds: shallow first
  if (a.type === 'add' && a.kind === 'dir') {
    const da = a.path.split('/').length;
    const db = b.path.split('/').length;
    if (da !== db) return da - db;
    return a.path.localeCompare(b.path);
  }

  return a.path.localeCompare(b.path);
}

/**
 * Streamed content hash comparison.
 */
export function hashFile(absPath, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function filesMatchChecksum(a, b, algo = 'sha256') {
  // Fast path: if either missing
  try {
    await fs.promises.access(a);
    await fs.promises.access(b);
  } catch {
    return false;
  }
  const [ha, hb] = await Promise.all([hashFile(a, algo), hashFile(b, algo)]);
  return ha === hb;
}

/**
 * Count action types for summary / plan header.
 * Library deletes and macOS metadata junk are counted separately:
 * - delete / deleteFiles / deleteDirs = real library paths (confirm UI uses these)
 * - deleteJunk = ._* / .DS_Store / other dot-names (cleaned silently unless verbose)
 */
export function countActions(actions) {
  const counts = {
    add: 0,
    update: 0,
    delete: 0,
    addFiles: 0,
    addDirs: 0,
    deleteFiles: 0,
    deleteDirs: 0,
    deleteJunk: 0,
  };
  // Lazy import avoid cycle — walk is leaf module
  // Inline check: any path segment starting with '.'
  const isJunk = (rel) => String(rel).split('/').some((s) => s.startsWith('.'));

  for (const a of actions) {
    if (a.type === 'add') {
      counts.add += 1;
      if (a.kind === 'file') counts.addFiles += 1;
      else counts.addDirs += 1;
    } else if (a.type === 'update') {
      counts.update += 1;
    } else if (a.type === 'delete') {
      if (isJunk(a.path)) {
        counts.deleteJunk += 1;
      } else {
        counts.delete += 1;
        if (a.kind === 'file') counts.deleteFiles += 1;
        else counts.deleteDirs += 1;
      }
    }
  }
  return counts;
}
