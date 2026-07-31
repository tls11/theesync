/**
 * Safe delete — only paths strictly inside the job dest category.
 * Dir deletes are non-recursive by default so apply stays plan-bound
 * (files deleted first; deepest-first empty dirs).
 */

import fs from 'node:fs';
import { assertDeletablePath, resolveAbs } from './safety.js';

/**
 * Delete a file under dest.
 */
export async function deleteFileSafe(targetAbs, destRoot) {
  const target = resolveAbs(targetAbs);
  assertDeletablePath(target, destRoot);

  try {
    await fs.promises.unlink(target);
  } catch (err) {
    if (err.code === 'ENOENT') return; // already gone
    throw err;
  }
}

/**
 * Delete a directory under dest.
 * Default: non-recursive rmdir (must be empty after planned file deletes).
 * recursive: true only for intentional full subtree wipe (not used by apply).
 */
export async function deleteDirSafe(targetAbs, destRoot, { recursive = false } = {}) {
  const target = resolveAbs(targetAbs);
  assertDeletablePath(target, destRoot);

  try {
    if (recursive) {
      await fs.promises.rm(target, { recursive: true, force: true });
    } else {
      await fs.promises.rmdir(target);
    }
  } catch (err) {
    if (err.code === 'ENOENT') return;
    if (!recursive && (err.code === 'ENOTEMPTY' || err.code === 'EEXIST')) {
      // Do not escalate to rm -rf — plan should have emptied the dir first.
      throw new Error(
        `Directory not empty at apply time (refusing recursive wipe): ${target}`,
      );
    }
    throw err;
  }
}
