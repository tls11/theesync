/**
 * CLI — commander-based interface for theesync.
 *
 * theesync [sync] --source <path> --dest <path> [options]
 * theesync plan  -s <path> -d <path> [options] [-o file] [--json-lines]
 * theesync apply -p|--plan <file> [--json-lines] [-v]
 */

import { Command } from 'commander';
import { syncJob, runPlan, runApply, SafetyError } from './sync.js';
import { createEmitter } from './events.js';
import { ALLOWED_CATEGORIES } from './config/categories.js';
import { DEFAULT_MTIME_TOLERANCE_MS } from './compare.js';

export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = EXIT_USAGE;
  }
}

function addCommonOptions(cmd) {
  return cmd
    .option('-s, --source <path>', 'source library tree')
    .option('-d, --dest <path>', 'destination category directory (e.g. /Volumes/H2/Music)')
    .option('--category <name>', `category sugar when dest is volume root (${ALLOWED_CATEGORIES.join(', ')})`)
    .option('--dry-run', 'plan only; do not write', false)
    .option('--no-delete', 'skip deletion phase')
    .option('--checksum', 'compare checksums when size matches', false)
    .option('--mtime-tolerance <ms>', 'mtime tolerance in ms (FAT32-friendly)', String(DEFAULT_MTIME_TOLERANCE_MS))
    .option(
      '--thorough-covers',
      'Books: re-inspect embedded art on unchanged audiobooks (slower repair mode)',
      false,
    )
    .option('--require-rockbox', 'fail if volume has no .rockbox / update.upt', false)
    .option('--json-lines', 'emit NDJSON events on stdout', false)
    .option('-v, --verbose', 'verbose action logging', false);
}

function parseMtime(opts) {
  const n = Number(opts.mtimeTolerance);
  if (!Number.isFinite(n) || n < 0) {
    throw new UsageError(`Invalid --mtime-tolerance: ${opts.mtimeTolerance}`);
  }
  return n;
}

/**
 * Commander treats `.option('--no-delete')` as a negated option for `delete`.
 * Default: delete === true; with --no-delete: delete === false.
 * Also accept explicit noDelete: true for programmatic callers.
 */
export function resolveNoDelete(opts) {
  if (opts.noDelete === true) return true;
  if (opts.delete === false) return true;
  return false;
}

/**
 * True if any job-related flag was set without source/dest (should be usage, not help).
 */
export function hasPartialJobFlags(opts) {
  if (opts.dryRun) return true;
  if (opts.checksum) return true;
  if (opts.thoroughCovers) return true;
  if (opts.requireRockbox) return true;
  if (opts.jsonLines) return true;
  if (opts.verbose) return true;
  if (opts.writePlan) return true;
  if (opts.category) return true;
  if (opts.delete === false) return true;
  if (opts.noDelete === true) return true;
  // mtimeTolerance is always set by default string — only count if non-default
  if (
    opts.mtimeTolerance != null &&
    String(opts.mtimeTolerance) !== String(DEFAULT_MTIME_TOLERANCE_MS)
  ) {
    return true;
  }
  return false;
}

function requireSourceDest(opts) {
  if (!opts.source) throw new UsageError('Missing required option: --source / -s');
  if (!opts.dest) throw new UsageError('Missing required option: --dest / -d');
}

function buildJobOptions(opts, extra = {}) {
  return {
    source: opts.source,
    dest: opts.dest,
    category: opts.category,
    dryRun: Boolean(opts.dryRun),
    noDelete: resolveNoDelete(opts),
    checksum: Boolean(opts.checksum),
    mtimeToleranceMs: parseMtime(opts),
    thoroughCovers: Boolean(opts.thoroughCovers),
    requireRockbox: Boolean(opts.requireRockbox),
    writePlan: opts.writePlan,
    jsonLines: Boolean(opts.jsonLines),
    verbose: Boolean(opts.verbose),
    ...extra,
  };
}

async function runSyncAction(opts) {
  requireSourceDest(opts);
  const emit = createEmitter({ jsonLines: opts.jsonLines, verbose: opts.verbose });
  const result = await syncJob({ ...buildJobOptions(opts), emit });
  if (result.summary?.failed > 0) {
    throw Object.assign(new Error('Sync completed with failures'), {
      exitCode: EXIT_RUNTIME,
      alreadyEmittedDone: true,
    });
  }
}

async function runPlanAction(opts) {
  requireSourceDest(opts);
  const emit = createEmitter({ jsonLines: opts.jsonLines, verbose: opts.verbose });
  await runPlan({ ...buildJobOptions(opts), emit });
}

async function runApplyAction(opts) {
  const emit = createEmitter({ jsonLines: opts.jsonLines, verbose: opts.verbose });
  const result = await runApply(opts.plan, {
    jsonLines: Boolean(opts.jsonLines),
    verbose: Boolean(opts.verbose),
    requireRockbox: Boolean(opts.requireRockbox),
    emit,
  });
  if (result.summary?.failed > 0) {
    throw Object.assign(new Error('Apply completed with failures'), {
      exitCode: EXIT_RUNTIME,
      alreadyEmittedDone: true,
    });
  }
}

/**
 * Build and run the CLI. Returns exit code.
 * @param {string[]} argv - process.argv style (node, script, ...args)
 */
export async function runCli(argv = process.argv) {
  // Detect --json-lines early so fatal catch can emit NDJSON
  const jsonLinesArg = argv.includes('--json-lines');
  let jsonLinesActive = jsonLinesArg;

  const program = new Command();
  program.exitOverride();

  program
    .name('theesync')
    .description(
      'Safe one-way category sync for HiFi Walker H2 / Rockbox.\n\n' +
        'Examples:\n' +
        '  theesync -s ~/Music/H2-Music -d /Volumes/H2/Music\n' +
        '  theesync plan -s … -d … -o plan.json\n' +
        '  theesync apply -p plan.json\n\n' +
        'Default command is sync (plan+apply). See: theesync sync --help',
    )
    .version('1.0.0')
    .showHelpAfterError(true);

  // Default one-shot as default command so options are not shared with siblings.
  const syncCmd = program
    .command('sync', { isDefault: true })
    .description('One-shot plan+apply (default when no subcommand)');
  addCommonOptions(syncCmd)
    .option('-o, --write-plan <file>', 'write plan JSON to file (still applies unless --dry-run)')
    .action(async (opts) => {
      jsonLinesActive = Boolean(opts.jsonLines) || jsonLinesArg;
      if (!opts.source && !opts.dest) {
        if (hasPartialJobFlags(opts)) {
          throw new UsageError('Missing required option: --source / -s');
        }
        program.outputHelp();
        return;
      }
      await runSyncAction(opts);
    });

  const planCmd = program
    .command('plan')
    .description('Scan and compare only; optionally write a plan file (never mutates dest)');
  addCommonOptions(planCmd)
    .option('-o, --write-plan <file>', 'write plan JSON to file')
    .action(async (opts) => {
      jsonLinesActive = Boolean(opts.jsonLines) || jsonLinesArg;
      await runPlanAction(opts);
    });

  const applyCmd = program
    .command('apply')
    .description('Execute a plan file (no re-scan; safety checks on every op; options come from the plan)');
  applyCmd
    .requiredOption('-p, --plan <file>', 'plan JSON file from `theesync plan`')
    .option('--json-lines', 'emit NDJSON events on stdout', false)
    .option('-v, --verbose', 'verbose action logging', false)
    .option('--require-rockbox', 'fail if volume has no .rockbox / update.upt', false)
    .action(async (opts) => {
      jsonLinesActive = Boolean(opts.jsonLines) || jsonLinesArg;
      await runApplyAction(opts);
    });

  // Category allowlist for UI / tooling (source: src/config/categories.js)
  program
    .command('categories')
    .description('Print allowlisted category names (dest basename must match one of these)')
    .option('--json', 'print as JSON array', false)
    .action((opts) => {
      if (opts.json) {
        process.stdout.write(JSON.stringify([...ALLOWED_CATEGORIES]) + '\n');
      } else {
        process.stdout.write(ALLOWED_CATEGORIES.join('\n') + '\n');
      }
    });

  try {
    await program.parseAsync(argv);
    return EXIT_OK;
  } catch (err) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      return EXIT_OK;
    }
    if (err.code === 'commander.help') {
      return EXIT_OK;
    }

    const code =
      err instanceof UsageError || err.exitCode === EXIT_USAGE
        ? EXIT_USAGE
        : err instanceof SafetyError || err.name === 'SafetyError'
          ? EXIT_RUNTIME
          : err.code?.startsWith?.('commander.')
            ? EXIT_USAGE
            : err.exitCode === EXIT_RUNTIME
              ? EXIT_RUNTIME
              : EXIT_RUNTIME;

    const message = err.message || String(err);

    // Structured terminal events for UI when --json-lines was requested
    if (jsonLinesActive && !err.alreadyEmittedDone) {
      const emit = createEmitter({ jsonLines: true });
      emit.emitFatal(message, {
        exitCode: code,
        name: err.name || 'Error',
      });
    }

    if (err instanceof UsageError || err.exitCode === EXIT_USAGE) {
      process.stderr.write(`Error: ${message}\n`);
      return EXIT_USAGE;
    }
    if (err instanceof SafetyError || err.name === 'SafetyError') {
      process.stderr.write(`Safety: ${message}\n`);
      return EXIT_RUNTIME;
    }
    if (err.code?.startsWith?.('commander.')) {
      process.stderr.write(`${message}\n`);
      return EXIT_USAGE;
    }
    if (err.exitCode === EXIT_RUNTIME) {
      // Avoid duplicate stderr when apply already emitted done with failures
      if (!err.alreadyEmittedDone || !jsonLinesActive) {
        process.stderr.write(`Error: ${message}\n`);
      }
      return EXIT_RUNTIME;
    }
    process.stderr.write(`Error: ${message}\n`);
    if (process.env.THEESYNC_DEBUG) {
      process.stderr.write(err.stack + '\n');
    }
    return EXIT_RUNTIME;
  }
}
