/**
 * Plan file JSON v1 — roots, options, counts, mutable actions only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { countActions } from './compare.js';

export const PLAN_VERSION = 1;

/**
 * @typedef {import('./compare.js').PlanAction} PlanAction
 */

/**
 * @typedef {{
 *   version: number,
 *   createdAt: string,
 *   roots: { source: string, dest: string, volumeRoot: string, category: string },
 *   options: {
 *     noDelete: boolean,
 *     checksum: boolean,
 *     mtimeToleranceMs: number,
 *     thoroughCovers?: boolean,
 *     excludeSource?: string[],
 *     excludeDest?: string[]
 *   },
 *   counts: {
 *     add: number,
 *     update: number,
 *     delete: number,
 *     deleteJunk: number,
 *     addFiles: number,
 *     addDirs: number,
 *     deleteFiles: number,
 *     deleteDirs: number,
 *     skippedUnchanged: number,
 *     skippedWalk: number
 *   },
 *   actions: PlanAction[]
 * }} PlanFile
 */

/**
 * Build a plan object from scan results.
 */
export function createPlan({
  source,
  dest,
  volumeRoot,
  category,
  options,
  actions,
  skippedUnchanged = 0,
  skippedWalk = 0,
}) {
  const counts = countActions(actions);
  return {
    version: PLAN_VERSION,
    createdAt: new Date().toISOString(),
    roots: {
      source,
      dest,
      volumeRoot,
      category,
    },
    options: {
      noDelete: Boolean(options.noDelete),
      checksum: Boolean(options.checksum),
      mtimeToleranceMs: options.mtimeToleranceMs ?? 3000,
      thoroughCovers: Boolean(options.thoroughCovers),
      excludeSource: Array.isArray(options.excludeSource) ? [...options.excludeSource] : [],
      excludeDest: Array.isArray(options.excludeDest) ? [...options.excludeDest] : [],
    },
    counts: {
      ...counts,
      skippedUnchanged,
      skippedWalk,
    },
    actions,
  };
}

/**
 * Write plan to JSON file (pretty).
 */
export async function writePlanFile(filePath, plan) {
  const abs = path.resolve(filePath);
  const json = JSON.stringify(plan, null, 2);
  await fs.promises.writeFile(abs, json + '\n', 'utf8');
  return abs;
}

/**
 * Read and validate plan file.
 */
export async function readPlanFile(filePath) {
  const abs = path.resolve(filePath);
  const raw = await fs.promises.readFile(abs, 'utf8');
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid plan JSON: ${err.message}`);
  }
  validatePlan(plan);
  return plan;
}

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Plan must be an object');
  }
  if (plan.version !== PLAN_VERSION) {
    throw new Error(`Unsupported plan version: ${plan.version} (expected ${PLAN_VERSION})`);
  }
  if (!plan.roots?.source || !plan.roots?.dest) {
    throw new Error('Plan missing roots.source or roots.dest');
  }
  if (!Array.isArray(plan.actions)) {
    throw new Error('Plan missing actions array');
  }
  for (const a of plan.actions) {
    if (!a.type || !a.path || !a.kind) {
      throw new Error(`Invalid action: ${JSON.stringify(a)}`);
    }
    if (!['add', 'update', 'delete'].includes(a.type)) {
      throw new Error(`Invalid action type: ${a.type}`);
    }
    if (!['file', 'dir'].includes(a.kind)) {
      throw new Error(`Invalid action kind: ${a.kind}`);
    }
    // Paths in plan are relative; reject absolute, empty, ., ..
    assertSafeRelPath(a.path, 'path');
    if (a.sourcePath != null) {
      assertSafeRelPath(a.sourcePath, 'sourcePath');
    }
  }
  return true;
}

function assertSafeRelPath(rel, label) {
  if (typeof rel !== 'string' || rel === '') {
    throw new Error(`Unsafe action ${label}: ${rel}`);
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`Unsafe action ${label}: ${rel}`);
  }
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Unsafe action ${label}: ${rel}`);
  }
}
