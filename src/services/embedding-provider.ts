import { getLlama, type LlamaEmbeddingContext } from 'node-llama-cpp';
import type { LiveEmbeddingResult } from './embedding-types.ts';
import { textToVector } from './text-utils.ts';

export function createEmbeddingProvider(modelPath: string): {
    embed(text: string): Promise<LiveEmbeddingResult>;
} {
    let contextPromise: Promise<{
        context: LlamaEmbeddingContext;
        maxInputTokens: number;
    }> | undefined;

    return {
        async embed(text: string): Promise<LiveEmbeddingResult> {
            if (process.env.RBT_EMBEDDING_TEST_MODE === 'stub') {
                return { vector: textToVector(text), backend: 'node-llama-cpp' };
            }

            contextPromise ??= getLlama()
                .then((llama) => llama.loadModel({ modelPath }))
                .then(async (model) => {
                    const contextSize = Math.min(model.trainContextSize, 2048);
                    return {
                        context: await model.createEmbeddingContext({ contextSize }),
                        maxInputTokens: Math.max(1, contextSize - 2),
                    };
                });
            const { context, maxInputTokens } = await contextPromise;
            const tokens = context.model.tokenize(
                `task: sentence similarity | query: ${text}`
            );
            const embedding = await context.getEmbeddingFor(tokens.slice(0, maxInputTokens));
            return { vector: [...embedding.vector], backend: 'node-llama-cpp' };
        },
    };
}
