/**
 * Safe copy into dest: temp name without leading dot beside target, then rename.
 * Preserves mtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertWritablePath, resolveAbs, isPathInside, SafetyError } from './safety.js';

/**
 * Create a non-hidden temp filename beside target.
 * e.g. track.flac → track.flac.theesync-tmp-<pid>-<rand>
 */
export function tempNameFor(targetAbs) {
  const dir = path.dirname(targetAbs);
  const base = path.basename(targetAbs);
  const rand = Math.random().toString(36).slice(2, 10);
  const tmpBase = `${base}.theesync-tmp-${process.pid}-${rand}`;
  // Ensure no leading dot
  const safe = tmpBase.startsWith('.') ? `t${tmpBase}` : tmpBase;
  return path.join(dir, safe);
}

/**
 * Ensure parent directory exists and lies under dest (or is dest).
 */
export async function ensureParentDir(targetAbs, destAbs) {
  const parent = path.dirname(resolveAbs(targetAbs));
  const dest = resolveAbs(destAbs);

  if (!isPathInside(dest, parent)) {
    throw new SafetyError(
      `Parent dir outside dest: ${parent} (dest=${dest})`,
      'OUTSIDE_DEST',
    );
  }

  if (!fs.existsSync(parent)) {
    await fs.promises.mkdir(parent, { recursive: true });
  }
}

/**
 * Copy a file from sourceAbs to destAbs path, with safety checks.
 * Uses temp file + rename; sets mtime from source.
 *
 * @param {string} sourceAbs
 * @param {string} targetAbs - final destination path (under job dest)
 * @param {string} destRoot - job dest category directory
 * @param {{ mtimeMs?: number }} options
 */
export async function copyFileSafe(sourceAbs, targetAbs, destRoot, options = {}) {
  const target = resolveAbs(targetAbs);
  assertWritablePath(target, destRoot);

  await ensureParentDir(target, destRoot);

  const tmp = tempNameFor(target);
  // Temp must also be under dest
  assertWritablePath(tmp, destRoot);

  try {
    await fs.promises.copyFile(sourceAbs, tmp);
    if (options.mtimeMs != null) {
      const mtime = new Date(options.mtimeMs);
      await fs.promises.utimes(tmp, mtime, mtime);
    } else {
      const st = await fs.promises.stat(sourceAbs);
      await fs.promises.utimes(tmp, st.atime, st.mtime);
    }
    // Atomic replace
    await fs.promises.rename(tmp, target);
  } catch (err) {
    // Cleanup temp on failure
    try {
      await fs.promises.unlink(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Create a directory under dest (safe).
 */
export async function mkdirSafe(targetAbs, destRoot) {
  const target = resolveAbs(targetAbs);
  const dest = resolveAbs(destRoot);
  if (target === dest) {
    assertWritablePath(target, dest);
    await fs.promises.mkdir(target, { recursive: true });
    return;
  }
  assertWritablePath(target, dest);
  await fs.promises.mkdir(target, { recursive: true });
}
