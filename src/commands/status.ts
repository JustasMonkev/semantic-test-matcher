import { Command } from 'commander';
import { resolveConfig } from '../config.ts';
import { getDecisionsCacheEntryCount, getOpenAIKey } from '../services/decisions.ts';
import { getJevCacheEntryCount, getJevKey } from '../services/jev.ts';
import { rootOptionsOf } from './shared.ts';

function presence(value: unknown, present: string, absent: string): string {
    return value ? present : absent;
}

export function registerStatusCommand(program: Command): void {
    program
        .command('status')
        .description('Show resolved runtime configuration')
        .option('--json', 'Print machine-readable output')
        .action(async (options: { json?: boolean }) => {
            const config = await resolveConfig(rootOptionsOf(program), {});
            const cacheEntries = await getJevCacheEntryCount(config.cacheDir);
            const decisionsCacheEntries = await getDecisionsCacheEntryCount(config.cacheDir);
            const decisionsApiKey = presence(getOpenAIKey(), 'set', 'missing');
            const jevApiKey = presence(getJevKey(), 'set', 'missing');
            const configFileStatus = presence(config.configFile, 'present', 'missing');

            if (options.json) {
                console.log(JSON.stringify({
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
                }));
                return;
            }

            console.log([
                `ranker: ${config.ranker}`,
                `fallback ranker: ${config.fallbackRanker}`,
                `decisions model: ${config.decisionsModel}`,
                `decisions api key (OPENAI_API_KEY or OPEN_AI): ${decisionsApiKey}`,
                `decisions cache entries: ${decisionsCacheEntries}`,
                `jev model: ${config.jevModel}`,
                `jev api key (TYPESAFE_API_KEY or JEF): ${jevApiKey}`,
                `logLevel: ${config.logLevel}`,
                `cacheDir: ${config.cacheDir}`,
                `cache entries: ${cacheEntries}`,
                `match.topK: ${config.match.topK ?? 'none'}`,
                `match.threshold: ${config.match.threshold}`,
                `config source: ${configFileStatus}`,
                `candidates: ${config.match.candidatePaths.join(', ')}`,
            ].join('\n'));
        });
}
