#!/usr/bin/env node
import { Command } from 'commander';
import { registerCommands } from './commands/index.ts';
import { isDebug } from './utils/io.ts';

const program = new Command();

program
    .name('rbt')
    .description('RBT Semantic Test Matcher')
    .version('0.1.0');

program
    .option('-c, --config <path>', 'Path to config file')
    .option('--provider <provider>', 'Embedding provider: hf or ollama')
    .option('--model <model>', 'Embedding model for the selected provider')
    .option('--cache-dir <path>', 'Directory used to store embedding cache')
    .option('--log-level <level>', 'debug | info | warn | error')
    .option('-v, --verbose', 'Enable verbose output')
    .option('-q, --quiet', 'Suppress non-essential output')
    .configureHelp({
        sortSubcommands: true,
    });

registerCommands(program);

try {
    await program.parseAsync(process.argv);
} catch (error) {
    if (error instanceof Error && isDebug()) {
        console.error(error.stack ?? error.message);
    } else {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        console.error('Re-run with RBT_DEBUG=1 for a full stack trace.');
    }
    process.exitCode = 1;
}
