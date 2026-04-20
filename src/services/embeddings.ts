import { createEmbeddingProvider } from './embedding-provider.ts';
import { isStableEmbeddingBackend, type EmbeddingResult } from './embedding-types.ts';
import {
    getCacheFile,
    loadCache,
    readCachedEmbedding,
    writeCachedEmbedding,
} from './cache.ts';
import type { EmbeddingProvider } from '../config.ts';
import { isDebug } from '../utils/io.ts';

export interface CreateEmbeddingOptions {
    text: string;
    provider: EmbeddingProvider;
    model: string;
    cacheDir: string;
    ollamaHost: string;
    skipCache?: boolean;
}

export async function createEmbedding({
    text,
    provider,
    model,
    cacheDir,
    ollamaHost,
    skipCache,
}: CreateEmbeddingOptions): Promise<EmbeddingResult> {
    if (provider === 'ollama' && !model) {
        throw new Error('Ollama model is required when using --provider ollama');
    }

    const cacheFile = getCacheFile(cacheDir);

    if (!skipCache) {
        const cached = await readCachedEmbedding(cacheFile, provider, model, text);
        if (cached && isStableEmbeddingBackend(cached.backend)) {
            return {
                vector: cached.vector,
                backend: cached.backend,
                cacheHit: true,
                fallbackReason: cached.fallbackReason,
            };
        }
    }

    const embeddingProvider = createEmbeddingProvider(provider, {
        model,
        ollamaHost,
    });

    const embedding = await embeddingProvider.embed(text);

    if (!skipCache && isStableEmbeddingBackend(embedding.backend)) {
        try {
            await writeCachedEmbedding(
                cacheFile,
                provider,
                model,
                text,
                embedding.vector,
                embedding.backend,
                embedding.fallbackReason
            );
        } catch (error) {
            if (isDebug()) {
                console.warn(`Cache write failed: ${(error as Error).message}`);
            }
        }
    }

    return {
        vector: embedding.vector,
        backend: embedding.backend,
        cacheHit: false,
        fallbackReason: embedding.fallbackReason,
    };
}

export async function getCacheEntryCount(cacheDir: string): Promise<number> {
    try {
        const cache = await loadCache(getCacheFile(cacheDir));
        return Object.keys(cache).length;
    } catch {
        return 0;
    }
}
