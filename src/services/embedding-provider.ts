import { getLlama, type LlamaEmbeddingContext } from 'node-llama-cpp';
import type { LiveEmbeddingResult } from './embedding-types.ts';
import { textToVector } from './text-utils.ts';

export function createEmbeddingProvider(modelPath: string): {
    embed(text: string): Promise<LiveEmbeddingResult>;
} {
    let contextPromise: Promise<LlamaEmbeddingContext> | undefined;

    return {
        async embed(text: string): Promise<LiveEmbeddingResult> {
            if (process.env.RBT_EMBEDDING_TEST_MODE === 'stub') {
                return { vector: textToVector(text), backend: 'node-llama-cpp' };
            }

            contextPromise ??= getLlama()
                .then((llama) => llama.loadModel({ modelPath }))
                .then((model) => model.createEmbeddingContext());
            const embedding = await (await contextPromise).getEmbeddingFor(
                `task: sentence similarity | query: ${text}`
            );
            return { vector: [...embedding.vector], backend: 'node-llama-cpp' };
        },
    };
}
