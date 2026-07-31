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
 *   kind: 'file'|'dir',
 *   size?: number,
 *   mtimeMs?: number,
 *   reason?: string
 * }} PlanAction
 */

/**
 * Compare source and dest inventories; build mutable actions only.
 *
 * @param {Map<string, import('./walk.js').WalkEntry>} sourceFiles
 * @param {Map<string, import('./walk.js').WalkEntry>} destFiles
 * @param {Map<string, import('./walk.js').WalkEntry>} sourceDirs
 * @param {Map<string, import('./walk.js').WalkEntry>} destDirs
 * @param {{
 *   noDelete?: boolean,
 *   checksum?: boolean,
 *   mtimeToleranceMs?: number,
 *   hashAlgo?: string
 * }} options
 */
export async function buildActions(sourceFiles, destFiles, sourceDirs, destDirs, options = {}) {
  const mtimeTol = options.mtimeToleranceMs ?? DEFAULT_MTIME_TOLERANCE_MS;
  const noDelete = Boolean(options.noDelete);
  const useChecksum = Boolean(options.checksum);
  const hashAlgo = options.hashAlgo || 'sha256';

  /** @type {PlanAction[]} */
  const actions = [];
  let skippedUnchanged = 0;

  // Ensure parent dirs exist on dest for adds (mkdir actions)
  // We emit dir adds for dirs only on source, not on dest
  for (const [rel, sDir] of sourceDirs) {
    if (!destDirs.has(rel)) {
      actions.push({
        type: 'add',
        path: rel,
        kind: 'dir',
        mtimeMs: sDir.mtimeMs,
      });
    }
  }

  for (const [rel, sFile] of sourceFiles) {
    const dFile = destFiles.get(rel);
    if (!dFile) {
      actions.push({
        type: 'add',
        path: rel,
        kind: 'file',
        size: sFile.size,
        mtimeMs: sFile.mtimeMs,
        reason: 'missing',
      });
      continue;
    }

    if (sFile.size !== dFile.size) {
      actions.push({
        type: 'update',
        path: rel,
        kind: 'file',
        size: sFile.size,
        mtimeMs: sFile.mtimeMs,
        reason: 'size',
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
          path: rel,
          kind: 'file',
          size: sFile.size,
          mtimeMs: sFile.mtimeMs,
          reason: 'checksum',
        });
      } else {
        actions.push({
          type: 'update',
          path: rel,
          kind: 'file',
          size: sFile.size,
          mtimeMs: sFile.mtimeMs,
          reason: 'mtime',
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
          path: rel,
          kind: 'file',
          size: sFile.size,
          mtimeMs: sFile.mtimeMs,
          reason: 'checksum',
        });
        continue;
      }
    }

    skippedUnchanged += 1;
  }

  if (!noDelete) {
    // Delete dest files not in source
    for (const [rel] of destFiles) {
      if (!sourceFiles.has(rel)) {
        actions.push({
          type: 'delete',
          path: rel,
          kind: 'file',
          reason: 'dest-only',
        });
      }
    }

    // Delete dest dirs not in source (deepest first — apply will sort)
    for (const [rel] of destDirs) {
      if (!sourceDirs.has(rel)) {
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
