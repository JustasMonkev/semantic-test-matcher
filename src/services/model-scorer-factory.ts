import type { RuntimeConfig } from '../config.ts';
import { DecisionsScorer, getOpenAIKey } from './decisions.ts';
import { getJevKey, JevScorer } from './jev.ts';
import type { ModelProvider, ModelScorer, ModelScorerOptions } from './model-scorer.ts';

export function createModelScorer(provider: ModelProvider, options: ModelScorerOptions): ModelScorer {
    return provider === 'jev' ? new JevScorer(options) : new DecisionsScorer(options);
}

export function createScorerFromConfig(
    provider: ModelProvider,
    config: Pick<RuntimeConfig, 'jevModel' | 'decisionsModel' | 'cacheDir'>
): ModelScorer {
    const isJev = provider === 'jev';
    return createModelScorer(provider, {
        apiKey: (isJev ? getJevKey() : getOpenAIKey()) ?? '',
        model: isJev ? config.jevModel : config.decisionsModel,
        cacheDir: config.cacheDir,
    });
}
