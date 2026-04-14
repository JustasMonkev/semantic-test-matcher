import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig } from '../config.ts';
import { getCacheEntryCount } from '../services/embeddings.ts';

export function registerStatusCommand(program: Command): void {
    program
        .command('status')
        .description('Show resolved runtime configuration')
        .option('--json', 'Print machine-readable output')
        .action(async (options: { json?: boolean }) => {
            const rootOptions = program.opts();
            const config = await resolveConfig(
                {
                    config: rootOptions.config,
                    provider: rootOptions.provider,
                    model: rootOptions.model,
                    cacheDir: rootOptions.cacheDir,
                    logLevel: rootOptions.logLevel,
                    verbose: rootOptions.verbose,
                    quiet: rootOptions.quiet,
                },
                {
                    threshold: undefined,
                    topK: undefined,
                    minScore: undefined,
                    candidates: undefined,
                    includeFile: undefined,
                    excludeFile: undefined,
                    provider: undefined,
                    model: undefined,
                    cacheDir: undefined,
                    json: undefined,
                }
            );

            const cacheEntries = await getCacheEntryCount(config.cacheDir);
            const defaultConfigPath = path.join(process.cwd(), '.rbt', 'config.json');
            const defaultAltConfigPath = path.join(process.cwd(), '.rbtconfig');
            const checkedPath = rootOptions.config || defaultConfigPath;
            let configFileStatus = 'missing';
            try {
                await fs.access(checkedPath);
                configFileStatus = 'present';
            } catch {
                configFileStatus = 'missing';
                try {
                    await fs.access(defaultAltConfigPath);
                    configFileStatus = 'present';
                } catch {
                    configFileStatus = 'missing';
                }
            }

            if (options.json) {
                console.log(
                    JSON.stringify({
                        provider: config.provider,
                        model: config.model,
                        logLevel: config.logLevel,
                        cacheDir: config.cacheDir,
                        cacheEntries,
                        match: config.match,
                        resolvedConfigFile: rootOptions.config ?? 'auto',
                        hasConfig: configFileStatus,
                    })
                );
                return;
            }

            console.log(`provider: ${config.provider}`);
            console.log(`model: ${config.model}`);
            console.log(`logLevel: ${config.logLevel}`);
            console.log(`cacheDir: ${config.cacheDir}`);
            console.log(`cache entries: ${cacheEntries}`);
            console.log(`match.topK: ${config.match.topK}`);
            console.log(`match.threshold: ${config.match.threshold}`);
            console.log(`config source: ${configFileStatus}`);
            console.log(`candidates: ${config.match.candidatePaths.join(', ')}`);
        });
}
