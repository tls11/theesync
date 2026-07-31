/**
 * Directory walk with macOS metadata skip list.
 * Conservative: skip all hidden (dot) names at any depth when walking source.
 */

import fs from 'node:fs';
import path from 'node:path';
import { nonAsciiWarning } from './safety.js';

/**
 * Should this basename be skipped when walking source (or ignored for inventory)?
 * - .DS_Store, ._*, .Trash(es), .fseventsd, .Spotlight-V100
 * - any name starting with '.'
 */
export function shouldSkipName(name) {
  if (name == null || name === '') return true;
  if (name.startsWith('.')) return true;
  return false;
}

/**
 * Relative path is macOS metadata clutter (AppleDouble / .DS_Store / other dot names).
 * Used to split "library deletes" vs silent junk cleanup.
 */
export function isMacOsMetadataPath(relPath) {
  if (relPath == null || relPath === '') return false;
  return String(relPath).split('/').some((seg) => shouldSkipName(seg));
}

/**
 * @typedef {{ rel: string, abs: string, size: number, mtimeMs: number, isDir: boolean }} WalkEntry
 */

/**
 * Walk a directory tree recursively.
 * Returns Map relPath -> WalkEntry for files (and optionally dirs).
 *
 * @param {string} rootAbs
 * @param {{
 *   includeDirs?: boolean,
 *   includeHidden?: boolean,
 *   onSkip?: (rel: string, reason: string) => void,
 *   onWarning?: (msg: string) => void
 * }} options
 *   includeHidden: when false (default), skip all dot-names (macOS ._* / .DS_Store).
 *   Used for both source and dest so FAT32 AppleDouble sidecars are not treated as library files.
 * @returns {Promise<{ files: Map<string, WalkEntry>, dirs: Map<string, WalkEntry>, skipped: number, warnings: string[] }>}
 */
export async function walkTree(rootAbs, options = {}) {
  const includeDirs = options.includeDirs !== false;
  const includeHidden = Boolean(options.includeHidden);
  const files = new Map();
  const dirs = new Map();
  let skipped = 0;
  const warnings = [];

  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Cannot read directory ${relDir || '.'}: ${err.message}`);
      return;
    }

    for (const ent of entries) {
      const name = ent.name;
      const rel = relDir ? path.join(relDir, name) : name;
      // path.join uses platform sep; normalize to / for portable relative keys? Spec says exact strings.
      // Use path.sep as on-disk; for plan portability use forward slash consistently.
      const relKey = rel.split(path.sep).join('/');

      if (!includeHidden && shouldSkipName(name)) {
        skipped += 1;
        options.onSkip?.(relKey, 'hidden');
        continue;
      }

      const warn = nonAsciiWarning(relKey);
      if (warn) {
        warnings.push(warn);
        options.onWarning?.(warn);
      }

      const abs = path.join(absDir, name);

      let st;
      try {
        // Use lstat to avoid following symlinks into unexpected places
        st = await fs.promises.lstat(abs);
      } catch (err) {
        warnings.push(`Cannot stat ${relKey}: ${err.message}`);
        continue;
      }

      if (st.isSymbolicLink()) {
        skipped += 1;
        options.onSkip?.(relKey, 'symlink');
        continue;
      }

      if (st.isDirectory()) {
        if (includeDirs) {
          dirs.set(relKey, {
            rel: relKey,
            abs,
            size: 0,
            mtimeMs: st.mtimeMs,
            isDir: true,
          });
        }
        await walk(abs, relKey);
      } else if (st.isFile()) {
        files.set(relKey, {
          rel: relKey,
          abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
          isDir: false,
        });
      } else {
        skipped += 1;
        options.onSkip?.(relKey, 'special');
      }
    }
  }

  await walk(rootAbs, '');
  return { files, dirs, skipped, warnings };
}

/**
 * Synchronous walk for simpler tests / small trees.
 */
export function walkTreeSync(rootAbs, options = {}) {
  const includeDirs = options.includeDirs !== false;
  const includeHidden = Boolean(options.includeHidden);
  const files = new Map();
  const dirs = new Map();
  let skipped = 0;
  const warnings = [];

  function walk(absDir, relDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Cannot read directory ${relDir || '.'}: ${err.message}`);
      return;
    }

    for (const ent of entries) {
      const name = ent.name;
      const rel = relDir ? path.join(relDir, name) : name;
      const relKey = rel.split(path.sep).join('/');

      if (!includeHidden && shouldSkipName(name)) {
        skipped += 1;
        options.onSkip?.(relKey, 'hidden');
        continue;
      }

      const warn = nonAsciiWarning(relKey);
      if (warn) {
        warnings.push(warn);
        options.onWarning?.(warn);
      }

      const abs = path.join(absDir, name);
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch (err) {
        warnings.push(`Cannot stat ${relKey}: ${err.message}`);
        continue;
      }

      if (st.isSymbolicLink()) {
        skipped += 1;
        options.onSkip?.(relKey, 'symlink');
        continue;
      }

      if (st.isDirectory()) {
        if (includeDirs) {
          dirs.set(relKey, {
            rel: relKey,
            abs,
            size: 0,
            mtimeMs: st.mtimeMs,
            isDir: true,
          });
        }
        walk(abs, relKey);
      } else if (st.isFile()) {
        files.set(relKey, {
          rel: relKey,
          abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
          isDir: false,
        });
      } else {
        skipped += 1;
        options.onSkip?.(relKey, 'special');
      }
    }
  }

  walk(rootAbs, '');
  return { files, dirs, skipped, warnings };
}
