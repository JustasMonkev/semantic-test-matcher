import { Command } from 'commander';
import { resolveConfig } from '../config.ts';
import { getDecisionsCacheEntryCount, getOpenAIKey } from '../services/decisions.ts';
import { getJevCacheEntryCount, JEV_API_KEY_ENV, getJevKey } from '../services/jev.ts';

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
            const decisionsCacheEntries = await getDecisionsCacheEntryCount(config.cacheDir);
            const decisionsApiKey = getOpenAIKey() ? 'set' : 'missing';
            const configFileStatus = config.configFile ? 'present' : 'missing';
            const jevApiKey = getJevKey() ? 'set' : 'missing';

            if (options.json) {
                console.log(
                    JSON.stringify({
                        ranker: config.ranker,
                        jevModel: config.jevModel,
                        decisionsModel: config.decisionsModel,
                        fallbackRanker: config.fallbackRanker,
                        decisionsApiKey,
                        decisionsCacheEntries,
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
            console.log(`fallback ranker: ${config.fallbackRanker}`);
            console.log(`decisions model: ${config.decisionsModel}`);
            console.log(`decisions api key (OPENAI_API_KEY or OPEN_AI): ${decisionsApiKey}`);
            console.log(`decisions cache entries: ${decisionsCacheEntries}`);
            console.log(`jev model: ${config.jevModel}`);
            console.log(`jev api key (${JEV_API_KEY_ENV} or JEF): ${jevApiKey}`);
            console.log(`logLevel: ${config.logLevel}`);
            console.log(`cacheDir: ${config.cacheDir}`);
            console.log(`cache entries: ${cacheEntries}`);
            console.log(`match.topK: ${config.match.topK ?? 'none'}`);
            console.log(`match.threshold: ${config.match.threshold}`);
            console.log(`config source: ${configFileStatus}`);
            console.log(`candidates: ${config.match.candidatePaths.join(', ')}`);
        });
}
