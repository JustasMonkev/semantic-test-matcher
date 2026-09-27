import { Command } from 'commander';
import { resolveConfig } from '../config.ts';
import { getJevCacheEntryCount, JEV_API_KEY_ENV } from '../services/jev.ts';

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
                    cacheDir: rootOptions.cacheDir,
                    logLevel: rootOptions.logLevel,
                    verbose: rootOptions.verbose,
                    quiet: rootOptions.quiet,
                },
                {}
            );

            const cacheEntries = await getJevCacheEntryCount(config.cacheDir);
            const configFileStatus = config.configFile ? 'present' : 'missing';
            const jevApiKey = process.env[JEV_API_KEY_ENV] ? 'set' : 'missing';

            if (options.json) {
                console.log(
                    JSON.stringify({
                        ranker: config.ranker,
                        jevModel: config.jevModel,
                        jevApiKey,
                        logLevel: config.logLevel,
                        cacheDir: config.cacheDir,
                        cacheEntries,
                        match: config.match,
                        resolvedConfigFile: config.configFile ?? 'auto',
                        hasConfig: configFileStatus,
                    })
                );
                return;
            }

            console.log(`ranker: ${config.ranker}`);
            console.log(`jev model: ${config.jevModel}`);
            console.log(`jev api key (${JEV_API_KEY_ENV}): ${jevApiKey}`);
            console.log(`logLevel: ${config.logLevel}`);
            console.log(`cacheDir: ${config.cacheDir}`);
            console.log(`cache entries: ${cacheEntries}`);
            console.log(`match.topK: ${config.match.topK ?? 'none'}`);
            console.log(`match.threshold: ${config.match.threshold}`);
            console.log(`config source: ${configFileStatus}`);
            console.log(`candidates: ${config.match.candidatePaths.join(', ')}`);
        });
}
