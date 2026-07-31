/**
 * Safety module — non-negotiable volume root protection and dest validation.
 * Every mutation path must pass through these checks.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ALLOWED_CATEGORIES, isAllowedCategory } from './config/categories.js';

// Re-export for callers that import from safety
export { ALLOWED_CATEGORIES, isAllowedCategory };

/** Filenames protected at volume root (case-insensitive). */
const PROTECTED_ROOT_FILES = new Set(['update.upt']);

/**
 * True if basename is a protected root entry.
 * - any name starting with '.'
 * - update.upt (case-insensitive)
 */
export function isProtectedRootName(name) {
  if (name == null || name === '') return true;
  if (name.startsWith('.')) return true;
  if (PROTECTED_ROOT_FILES.has(name.toLowerCase())) return true;
  return false;
}

/**
 * Resolve and normalize an absolute path (no trailing slash except root).
 */
export function resolveAbs(p) {
  if (p == null || String(p).trim() === '') {
    throw new SafetyError('Path is empty');
  }
  return path.resolve(String(p));
}

/**
 * Boundary-safe: is `child` strictly under or equal to `parent`?
 * Uses path.sep boundaries so /foo is not under /foobar.
 */
export function isPathInside(parent, child) {
  const p = resolveAbs(parent);
  const c = resolveAbs(child);
  if (p === c) return true;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

/**
 * True if path is strictly inside parent (not equal).
 */
export function isStrictlyInside(parent, child) {
  const p = resolveAbs(parent);
  const c = resolveAbs(child);
  if (p === c) return false;
  return isPathInside(p, c);
}

/**
 * Derive volume root from a category dest path.
 * dest is expected to be .../VolumeRoot/CategoryName
 * volume root = dirname(dest).
 */
export function volumeRootFromDest(dest) {
  const d = resolveAbs(dest);
  return path.dirname(d);
}

/**
 * Category name from dest (basename).
 */
export function categoryFromDest(dest) {
  return path.basename(resolveAbs(dest));
}

export class SafetyError extends Error {
  constructor(message, code = 'SAFETY') {
    super(message);
    this.name = 'SafetyError';
    this.code = code;
  }
}

/**
 * Dangerous absolute destinations (OS roots, home, etc.).
 */
function isDangerousPath(abs) {
  const home = os.homedir();
  const dangerous = new Set([
    path.resolve('/'),
    path.resolve(home),
    path.resolve(home, 'Desktop'),
    path.resolve(home, 'Documents'),
    path.resolve(home, 'Downloads'),
    path.resolve(home, 'Library'),
    path.resolve('/System'),
    path.resolve('/Users'),
    path.resolve('/Applications'),
    path.resolve('/Library'),
    path.resolve('/private'),
    path.resolve('/etc'),
    path.resolve('/var'),
    path.resolve('/usr'),
    path.resolve('/bin'),
    path.resolve('/sbin'),
  ]);
  if (dangerous.has(abs)) return true;
  // Refuse bare /Volumes
  if (abs === path.resolve('/Volumes')) return true;
  return false;
}

/**
 * Validate that dest is a legal managed category path.
 * Does NOT require dest to exist yet (creating category dir is OK).
 *
 * @returns {{ dest, volumeRoot, category, warnings: string[] }}
 */
export function validateDest(destPath, options = {}) {
  const warnings = [];
  const dest = resolveAbs(destPath);
  const category = path.basename(dest);
  const volumeRoot = path.dirname(dest);

  if (isDangerousPath(dest)) {
    throw new SafetyError(
      `Refusing dangerous dest: ${dest}`,
      'DANGEROUS_DEST',
    );
  }

  // Refuse bare volume root (e.g. /Volumes/H2) — must be a category folder
  if (isAllowedCategory(category) === false) {
    // Special case: if user pointed at volume root itself
    if (dest === volumeRoot || path.basename(dest) === dest) {
      throw new SafetyError(
        `Dest must be an allowlisted category directory (one of: ${ALLOWED_CATEGORIES.join(', ')}). Got: ${dest}`,
        'NOT_CATEGORY',
      );
    }
    throw new SafetyError(
      `Dest category "${category}" is not allowlisted. Allowed: ${ALLOWED_CATEGORIES.join(', ')}. Dest: ${dest}`,
      'NOT_CATEGORY',
    );
  }

  // Dest must be exactly volumeRoot/Category — not deeper nesting like Music/subdir as dest
  // (job dest IS the category root; contents go inside)
  // volumeRoot itself must not be /
  if (volumeRoot === path.resolve('/')) {
    throw new SafetyError(
      `Refusing dest under filesystem root: ${dest}`,
      'DANGEROUS_DEST',
    );
  }

  if (isDangerousPath(volumeRoot)) {
    throw new SafetyError(
      `Refusing dangerous volume root: ${volumeRoot}`,
      'DANGEROUS_DEST',
    );
  }

  // Soft probe for Rockbox markers
  const hasRockbox = probeRockbox(volumeRoot);
  if (!hasRockbox.present) {
    const msg = `Volume ${volumeRoot} has no .rockbox* or update.upt — may not be an H2 card`;
    if (options.requireRockbox) {
      throw new SafetyError(msg, 'REQUIRE_ROCKBOX');
    }
    warnings.push(msg);
  }

  return { dest, volumeRoot, category, warnings, rockbox: hasRockbox };
}

/**
 * Probe volume root for Rockbox / firmware markers.
 */
export function probeRockbox(volumeRoot) {
  const root = resolveAbs(volumeRoot);
  let hasRockboxDir = false;
  let hasUpdate = false;
  let entries = [];

  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { present: false, hasRockboxDir: false, hasUpdate: false, path: root };
  }

  for (const ent of entries) {
    const name = ent.name;
    if (ent.isDirectory() && (name === '.rockbox' || name.startsWith('.rockbox '))) {
      hasRockboxDir = true;
    }
    if (ent.isFile() && name.toLowerCase() === 'update.upt') {
      hasUpdate = true;
    }
  }

  return {
    present: hasRockboxDir || hasUpdate,
    hasRockboxDir,
    hasUpdate,
    path: root,
  };
}

/**
 * Validate source path (must exist as directory, not equal dest, not dangerous alone as empty).
 */
export function validateSource(sourcePath, destPath) {
  const source = resolveAbs(sourcePath);
  const dest = resolveAbs(destPath);

  if (!fs.existsSync(source)) {
    throw new SafetyError(`Source does not exist: ${source}`, 'SOURCE_MISSING');
  }
  const st = fs.statSync(source);
  if (!st.isDirectory()) {
    throw new SafetyError(`Source is not a directory: ${source}`, 'SOURCE_NOT_DIR');
  }

  if (source === dest) {
    throw new SafetyError('Source and dest must not be the same path', 'SOURCE_EQ_DEST');
  }

  // Refuse if dest is inside source or source inside dest (would recurse badly)
  if (isPathInside(source, dest)) {
    throw new SafetyError(
      `Dest is inside source — refusing nested paths: dest=${dest} source=${source}`,
      'NESTED_PATHS',
    );
  }
  if (isPathInside(dest, source)) {
    throw new SafetyError(
      `Source is inside dest — refusing nested paths: source=${source} dest=${dest}`,
      'NESTED_PATHS',
    );
  }

  return { source };
}

/**
 * Expand --dest volume + --category sugar into category path.
 */
export function expandDestCategory(destOrVolume, category) {
  if (category) {
    const base = resolveAbs(destOrVolume);
    if (isAllowedCategory(category) === false) {
      throw new SafetyError(
        `Category "${category}" is not allowlisted. Allowed: ${ALLOWED_CATEGORIES.join(', ')}`,
        'NOT_CATEGORY',
      );
    }
    // If user already passed full category path matching category, use it
    if (path.basename(base) === category && isAllowedCategory(category)) {
      return base;
    }
    return path.join(base, category);
  }
  return resolveAbs(destOrVolume);
}

/**
 * Refuse dest that exists as a symlink (or non-directory).
 * Call when dest exists before walk/apply.
 */
export function assertDestNotSymlink(destAbs) {
  const dest = resolveAbs(destAbs);
  if (!fs.existsSync(dest)) return dest;
  let st;
  try {
    st = fs.lstatSync(dest);
  } catch (err) {
    throw new SafetyError(`Cannot lstat dest: ${dest}: ${err.message}`, 'DEST_LSTAT');
  }
  if (st.isSymbolicLink()) {
    throw new SafetyError(
      `Refusing symlink dest (must be a real category directory): ${dest}`,
      'DEST_SYMLINK',
    );
  }
  if (!st.isDirectory()) {
    throw new SafetyError(`Dest exists but is not a directory: ${dest}`, 'DEST_NOT_DIR');
  }
  return dest;
}

/**
 * Assert every path component from dest down to target is not a symlink.
 * Prevents intermediate links redirecting mutations outside the category.
 */
export function assertNoSymlinkParents(targetAbs, destAbs) {
  const target = resolveAbs(targetAbs);
  const dest = resolveAbs(destAbs);
  if (!isPathInside(dest, target)) {
    throw new SafetyError(
      `Path outside dest for symlink check: ${target}`,
      'OUTSIDE_DEST',
    );
  }

  // Walk from dest down to target (inclusive if target exists)
  const rel = path.relative(dest, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SafetyError(`Path not under dest: ${target}`, 'OUTSIDE_DEST');
  }

  // Check dest itself if it exists
  if (fs.existsSync(dest)) {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink()) {
      throw new SafetyError(
        `Refusing mutation via symlink dest: ${dest}`,
        'DEST_SYMLINK',
      );
    }
  }

  if (rel === '' || rel === '.') return;

  const parts = rel.split(path.sep).filter(Boolean);
  let cur = dest;
  for (const part of parts) {
    cur = path.join(cur, part);
    if (!fs.existsSync(cur)) break;
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break;
    }
    if (st.isSymbolicLink()) {
      throw new SafetyError(
        `Refusing mutation via symlink component: ${cur}`,
        'SYMLINK_COMPONENT',
      );
    }
  }
}

/**
 * If realpath is available, ensure the resolved path stays under resolved dest.
 * Soft-fails open if path does not exist yet (create case).
 */
export function assertRealPathInsideDest(targetAbs, destAbs) {
  const dest = resolveAbs(destAbs);
  const target = resolveAbs(targetAbs);

  let realDest;
  try {
    if (fs.existsSync(dest)) {
      realDest = fs.realpathSync(dest);
    } else {
      realDest = dest;
    }
  } catch {
    realDest = dest;
  }

  // Lexical check always
  if (!isPathInside(dest, target) && target !== dest) {
    throw new SafetyError(
      `Path outside dest boundary: ${target} (dest=${dest})`,
      'OUTSIDE_DEST',
    );
  }

  // If target exists, realpath must stay under realDest
  if (fs.existsSync(target)) {
    let realTarget;
    try {
      realTarget = fs.realpathSync(target);
    } catch {
      return;
    }
    if (!isPathInside(realDest, realTarget) && realTarget !== realDest) {
      throw new SafetyError(
        `Resolved path escapes dest: ${realTarget} (dest=${realDest})`,
        'REALPATH_ESCAPE',
      );
    }
  }
}

/**
 * Assert a mutation target is safe to write/delete.
 * Re-checks on every op.
 *
 * Policy:
 * - deletable ⇒ strictly inside dest
 * - writable ⇒ under dest; equality only if allowDestItself
 *
 * @param {string} targetAbs - absolute path to create/write/delete
 * @param {string} destAbs - job dest (category dir)
 * @param {{ allowDestItself?: boolean }} opts - allowDestItself for mkdir of category
 */
export function assertMutablePath(targetAbs, destAbs, opts = {}) {
  const target = resolveAbs(targetAbs);
  const dest = resolveAbs(destAbs);
  const volumeRoot = volumeRootFromDest(dest);
  const category = categoryFromDest(dest);

  if (!isAllowedCategory(category)) {
    throw new SafetyError(
      `Dest is not an allowlisted category: ${dest}`,
      'NOT_CATEGORY',
    );
  }

  if (opts.allowDestItself) {
    if (!isPathInside(dest, target)) {
      throw new SafetyError(
        `Path must be under dest: ${target}`,
        'OUTSIDE_DEST',
      );
    }
  } else if (!isStrictlyInside(dest, target)) {
    throw new SafetyError(
      `Path must be strictly inside dest: ${target}`,
      'OUTSIDE_DEST',
    );
  }

  // Top-level volume segment must not be protected
  const relToVol = path.relative(volumeRoot, target);
  if (relToVol.startsWith('..') || path.isAbsolute(relToVol)) {
    throw new SafetyError(
      `Path not under volume root: ${target}`,
      'OUTSIDE_VOLUME',
    );
  }

  const topSegment = relToVol.split(path.sep)[0];
  if (topSegment && isProtectedRootName(topSegment)) {
    throw new SafetyError(
      `Refusing to touch protected root entry: ${topSegment}`,
      'PROTECTED_ROOT',
    );
  }

  // Top segment must be the allowlisted category (not Screenshots etc.)
  if (topSegment && topSegment !== category) {
    throw new SafetyError(
      `Top-level volume segment "${topSegment}" is not the managed category "${category}"`,
      'WRONG_CATEGORY',
    );
  }

  if (target === volumeRoot) {
    throw new SafetyError('Refusing to mutate volume root', 'PROTECTED_ROOT');
  }

  // Symlink / realpath re-checks when the path (or parents) exist
  assertNoSymlinkParents(target, dest);
  assertRealPathInsideDest(target, dest);

  return { target, dest, volumeRoot, category };
}

/**
 * Assert path is safe to delete (strictly inside dest category).
 */
export function assertDeletablePath(targetAbs, destAbs) {
  return assertMutablePath(targetAbs, destAbs, { allowDestItself: false });
}

/**
 * Assert path is safe to write/copy (under dest, may create dest itself).
 */
export function assertWritablePath(targetAbs, destAbs) {
  const target = resolveAbs(targetAbs);
  const dest = resolveAbs(destAbs);
  if (target === dest) {
    return assertMutablePath(target, dest, { allowDestItself: true });
  }
  return assertMutablePath(target, dest, { allowDestItself: false });
}

/**
 * Soft check: warn if path contains non-ASCII characters.
 */
export function nonAsciiWarning(relativePath) {
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(relativePath)) {
    return `Non-ASCII path (exact-match only, no NFC normalize): ${relativePath}`;
  }
  return null;
}

/**
 * Resolve --dest /Volumes/H2 with optional category, refuse bare root.
 */
export function resolveJobPaths({ source, dest, category, requireRockbox = false }) {
  const expandedDest = expandDestCategory(dest, category);
  const destInfo = validateDest(expandedDest, { requireRockbox });
  const sourceInfo = validateSource(source, destInfo.dest);
  return {
    source: sourceInfo.source,
    dest: destInfo.dest,
    volumeRoot: destInfo.volumeRoot,
    category: destInfo.category,
    warnings: destInfo.warnings,
    rockbox: destInfo.rockbox,
  };
}
