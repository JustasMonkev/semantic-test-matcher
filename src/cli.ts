#!/usr/bin/env node
import { Command } from 'commander';
import { registerCommands } from './commands/index.ts';

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

await program.parseAsync(process.argv);
