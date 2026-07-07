import { createEmbeddingProvider, type EmbeddingProviderClient } from './embedding-provider.ts';
import { isStableEmbeddingBackend, type EmbeddingResult } from './embedding-types.ts';
import {
    buildCacheKey,
    getCacheFile,
    loadCache,
    writeCachedEmbeddings,
    type CachedEmbedding,
    type EmbeddingCache,
} from './cache.ts';
import type { EmbeddingProvider } from '../config.ts';
import { isDebug } from '../utils/io.ts';

export interface EmbeddingSessionOptions {
    provider: EmbeddingProvider;
    model: string;
    cacheDir: string;
    ollamaHost: string;
    skipCache?: boolean;
}

export interface CreateEmbeddingOptions extends EmbeddingSessionOptions {
    text: string;
}

/**
 * Embeds texts against a single provider/model/cache configuration.
 *
 * The on-disk cache is read once per session and new embeddings are buffered
 * in memory, so callers embedding many documents pay for one cache read and
 * one locked cache write (on flush) instead of one of each per document.
 */
export class EmbeddingSession {
    private cachePromise?: Promise<EmbeddingCache>;
    private pending: EmbeddingCache = {};
    private providerClient?: EmbeddingProviderClient;
    private readonly options: EmbeddingSessionOptions;
    private readonly cacheFile: string;

    constructor(options: EmbeddingSessionOptions) {
        if (options.provider === 'ollama' && !options.model) {
            throw new Error('Ollama model is required when using --provider ollama');
        }
        this.options = options;
        this.cacheFile = getCacheFile(options.cacheDir);
    }

    private getCache(): Promise<EmbeddingCache> {
        this.cachePromise ??= loadCache(this.cacheFile).catch((error) => {
            if (isDebug()) {
                console.warn(`Cache read failed: ${(error as Error).message}`);
            }
            return {};
        });
        return this.cachePromise;
    }

    async embed(text: string): Promise<EmbeddingResult> {
        const { provider, model, ollamaHost, skipCache } = this.options;
        const key = buildCacheKey(provider, model, text);

        if (!skipCache) {
            const cache = await this.getCache();
            const hit = this.pending[key] ?? cache[key];
            if (hit?.backend && isStableEmbeddingBackend(hit.backend)) {
                return {
                    vector: hit.vector,
                    backend: hit.backend,
                    cacheHit: true,
                    fallbackReason: hit.fallbackReason,
                };
            }
        }

        this.providerClient ??= createEmbeddingProvider(provider, { model, ollamaHost });
        const embedding = await this.providerClient.embed(text);

        if (!skipCache && isStableEmbeddingBackend(embedding.backend)) {
            const entry: CachedEmbedding = {
                createdAt: new Date().toISOString(),
                provider,
                model,
                vector: embedding.vector,
                backend: embedding.backend,
                fallbackReason: embedding.fallbackReason,
            };
            this.pending[key] = entry;
        }

        return {
            vector: embedding.vector,
            backend: embedding.backend,
            cacheHit: false,
            fallbackReason: embedding.fallbackReason,
        };
    }

    /** Persists buffered embeddings in a single locked cache write. Best-effort. */
    async flush(): Promise<void> {
        if (!Object.keys(this.pending).length) {
            return;
        }

        try {
            await writeCachedEmbeddings(this.cacheFile, this.pending);
            this.pending = {};
        } catch (error) {
            if (isDebug()) {
                console.warn(`Cache write failed: ${(error as Error).message}`);
            }
        }
    }
}

export async function createEmbedding({ text, ...options }: CreateEmbeddingOptions): Promise<EmbeddingResult> {
    const session = new EmbeddingSession(options);
    const result = await session.embed(text);
    await session.flush();
    return result;
}

export async function getCacheEntryCount(cacheDir: string): Promise<number> {
    try {
        const cache = await loadCache(getCacheFile(cacheDir));
        return Object.keys(cache).length;
    } catch {
        return 0;
    }
}
