#!/usr/bin/env node
import { runCli, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../src/cli.js';

const code = await runCli(process.argv);
process.exit(code ?? 0);
