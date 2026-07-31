/**
 * Managed category folder names (case-sensitive basename of job dest).
 *
 * Dest must be: <volumeRoot>/<Category>
 * e.g. /Volumes/H2/Music, /Volumes/H2/Books
 *
 * Edit this list to add categories. Restart the UI or click "Reload categories"
 * so the dropdown picks up changes. Sync always uses the live list from the engine.
 */

/** @type {readonly string[]} */
export const ALLOWED_CATEGORIES = Object.freeze(['Music', 'Books']);

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isAllowedCategory(name) {
  return ALLOWED_CATEGORIES.includes(name);
}
