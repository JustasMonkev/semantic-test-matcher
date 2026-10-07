import { DecisionsScorer } from './decisions.ts';
import { JevScorer } from './jev.ts';
import type { ModelProvider, ModelScorer, ModelScorerOptions } from './model-scorer.ts';

export function createModelScorer(provider: ModelProvider, options: ModelScorerOptions): ModelScorer {
    return provider === 'jev' ? new JevScorer(options) : new DecisionsScorer(options);
}
