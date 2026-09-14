/**
 * Folder exclude matching — source skip prefixes and dest keep prefixes.
 * Pure functions, no I/O. Paths are /-separated relative keys (same as walk).
 */

export class ExcludeError extends Error {
  constructor(message, code = 'EXCLUDE') {
    super(message);
    this.name = 'ExcludeError';
    this.code = code;
  }
}

/**
 * Normalize one relative exclude path.
 * Forward slashes, no leading/trailing slash, no `.` / `..` / empty segments.
 * @param {unknown} rel
 * @returns {string}
 */
export function normalizeExcludeRel(rel) {
  if (rel == null) {
    throw new ExcludeError('Exclude path is empty', 'EXCLUDE_EMPTY');
  }
  let s = String(rel).trim().replace(/\\/g, '/');
  if (s.startsWith('/')) {
    throw new ExcludeError(`Exclude path must be relative: ${rel}`, 'EXCLUDE_ABSOLUTE');
  }
  s = s.replace(/\/+$/, '');
  if (s === '') {
    throw new ExcludeError('Exclude path is empty', 'EXCLUDE_EMPTY');
  }
  const segs = s.split('/');
  if (segs.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new ExcludeError(`Unsafe exclude path: ${rel}`, 'EXCLUDE_UNSAFE');
  }
  return s;
}

/**
 * Normalize a list of exclude paths: validate, dedupe, locale-sort.
 * @param {unknown} list
 * @returns {string[]}
 */
export function normalizeExcludeList(list) {
  if (list == null) return [];
  const arr = Array.isArray(list) ? list : [list];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const n = normalizeExcludeRel(item);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * Segment-aware prefix: `Tool` matches `Tool` and `Tool/a`, not `Toolbox`.
 * @param {string} rel
 * @param {string} prefix
 */
export function isUnderPrefix(rel, prefix) {
  if (rel == null || prefix == null || rel === '' || prefix === '') return false;
  if (rel === prefix) return true;
  return rel.startsWith(`${prefix}/`);
}

/**
 * @param {string} rel
 * @param {string[]} prefixes
 */
export function isUnderAnyPrefix(rel, prefixes) {
  if (!prefixes || prefixes.length === 0) return false;
  for (const p of prefixes) {
    if (isUnderPrefix(rel, p)) return true;
  }
  return false;
}

/**
 * Dest path is protected from library delete:
 * - it is the kept folder or inside it, or
 * - it is an ancestor of a kept folder (so apply cannot ENOTEMPTY a parent).
 * @param {string} rel
 * @param {string[]} keepPrefixes
 */
export function isDestDeleteProtected(rel, keepPrefixes) {
  if (!keepPrefixes || keepPrefixes.length === 0) return false;
  if (rel == null || rel === '') return false;
  for (const p of keepPrefixes) {
    if (isUnderPrefix(rel, p)) return true;
    if (isUnderPrefix(p, rel)) return true;
  }
  return false;
}
