/**
 * Event / progress reporting — human log + optional NDJSON lines.
 *
 * NDJSON schema v1 event types:
 *   start, scan, plan, action, progress, warning, error, info, summary, done
 * Every line includes: schemaVersion (1), type, ts
 *
 * Library vs junk: plan/summary "delete" is library-only.
 * MacOS metadata cleanup is deleteJunk / junkCleaned — human-shown only when verbose.
 */

export const EVENT_SCHEMA_VERSION = 1;

/**
 * Create an event emitter for CLI / UI bridge.
 * @param {{ jsonLines?: boolean, verbose?: boolean, write?: (line: string) => void, writeErr?: (line: string) => void }} options
 */
export function createEmitter(options = {}) {
  const write = options.write || ((s) => process.stdout.write(s));
  const writeErr = options.writeErr || ((s) => process.stderr.write(s));
  const jsonLines = Boolean(options.jsonLines);
  const verbose = Boolean(options.verbose);

  function emit(type, data = {}) {
    // type/ts/schemaVersion last so they cannot be overwritten by data
    const event = {
      ...data,
      schemaVersion: EVENT_SCHEMA_VERSION,
      type,
      ts: new Date().toISOString(),
    };
    if (jsonLines) {
      // Strip junk counts from JSON when not verbose so UI default log stays calm
      // (UI formats events itself; still omit junk fields unless verbose for consistency)
      let out = event;
      if (!verbose && (type === 'plan' || type === 'summary')) {
        out = { ...event };
        delete out.deleteJunk;
        delete out.junkCleaned;
      }
      if (!verbose && type === 'action' && event.junk) {
        return event; // don't print junk actions unless verbose
      }
      write(JSON.stringify(out) + '\n');
    } else {
      const line = formatHuman(event, verbose);
      if (line != null) {
        if (type === 'error' || type === 'warning') {
          writeErr(line + '\n');
        } else {
          write(line + '\n');
        }
      }
    }
    return event;
  }

  /**
   * Emit structured fatal terminal events (json-lines) plus human stderr.
   */
  function emitFatal(message, extra = {}) {
    emit('error', { message, ...extra });
    emit('done', { ok: false });
  }

  return { emit, emitFatal, jsonLines, verbose };
}

/**
 * Stable summary payload for plan and apply (allowlisted keys).
 */
export function summaryPayload({
  added = 0,
  updated = 0,
  deleted = 0,
  junkCleaned = 0,
  skipped = 0,
  failed = 0,
  dryRun = false,
  failures = undefined,
} = {}) {
  const out = { added, updated, deleted, junkCleaned, skipped, failed, dryRun };
  if (failures != null && failures.length > 0) {
    out.failures = failures;
  }
  return out;
}

function formatHuman(event, verbose) {
  switch (event.type) {
    case 'start':
      return `→ ${event.phase || 'sync'}: ${event.source || ''} → ${event.dest || ''}`;
    case 'scan': {
      const side = event.side === 'source' ? 'source library' : 'dest category';
      // Dest scan with hidden inventory can look huge; keep simple unless verbose
      const empty = (event.files === 0 && event.dirs === 0)
        ? ' (empty — nothing to compare)'
        : '';
      return `  scan ${side}: ${event.files ?? '?'} files, ${event.dirs ?? '?'} dirs` +
        (event.skipped ? ` (${event.skipped} skipped)` : '') + empty;
    }
    case 'plan':
      return formatPlanHuman(event, verbose);
    case 'action':
      if (!verbose && (event.op === 'skip' || event.junk)) return null;
      return `  ${symbol(event.op)} ${event.path}${event.reason ? ` (${event.reason})` : ''}`;
    case 'progress':
      return `  progress ${event.done}/${event.total}`;
    case 'warning':
      return `  ⚠ ${event.message}`;
    case 'error':
      return `  ✗ ${event.message}${event.path ? ` [${event.path}]` : ''}`;
    case 'summary':
      return formatSummaryHuman(event, verbose);
    case 'done':
      return event.ok ? '✓ done' : '✗ finished with errors';
    case 'info':
      return `  ${event.message}`;
    default:
      if (verbose) return `  [${event.type}] ${JSON.stringify(event)}`;
      return null;
  }
}

function formatPlanHuman(event, verbose) {
  const addFiles = event.addFiles ?? '?';
  const addDirs = event.addDirs ?? '?';
  const delFiles = event.deleteFiles ?? '?';
  const delDirs = event.deleteDirs ?? '?';
  const lines = [
    '  plan (what would change):',
    `    add:     ${event.add ?? 0}  (${addFiles} files, ${addDirs} dirs)  — missing on dest`,
    `    update:  ${event.update ?? 0}  — size/mtime/checksum differ`,
    `    delete:  ${event.delete ?? 0}  (${delFiles} files, ${delDirs} dirs)  — dest-only library`,
  ];
  if (event.skippedUnchanged != null) {
    lines.push(`    unchanged (skip): ${event.skippedUnchanged}`);
  }
  if (verbose && (event.deleteJunk ?? 0) > 0) {
    lines.push(`    cleanup:  ${event.deleteJunk} macOS metadata files (._* / .DS_Store)`);
  }
  if ((event.add ?? 0) > 0 && (event.update ?? 0) === 0 && (event.delete ?? 0) === 0) {
    lines.push('    note: plan is add-only (no library updates or deletes)');
  }
  return lines.join('\n');
}

function formatSummaryHuman(event, verbose) {
  const lines = [
    '── summary ──',
    `  added:   ${event.added ?? 0}`,
    `  updated: ${event.updated ?? 0}`,
    `  deleted: ${event.deleted ?? 0}`,
    `  skipped: ${event.skipped ?? 0}`,
    `  failed:  ${event.failed ?? 0}`,
  ];
  if (verbose && (event.junkCleaned ?? 0) > 0) {
    lines.push(`  cleanup: ${event.junkCleaned} macOS metadata files`);
  }
  if (event.dryRun) lines.push('  (dry-run — no changes written)');
  return lines.join('\n');
}

function symbol(op) {
  switch (op) {
    case 'add': return '+';
    case 'update': return '~';
    case 'delete': return '-';
    case 'mkdir': return 'd';
    case 'skip': return '=';
    default: return '?';
  }
}
