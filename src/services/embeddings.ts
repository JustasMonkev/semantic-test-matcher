import { createEmbeddingProvider, type EmbeddingProviderClient } from './embedding-provider.ts';
import { isStableEmbeddingBackend, type EmbeddingResult } from './embedding-types.ts';
import { EmbeddingCacheStore, getCacheFile, loadCache } from './cache.ts';
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
 * Shares one provider client and one cache store across many embed calls so
 * a batch of embeddings loads the cache file once and flushes it once.
 * Call flush() when done (also safe to call after a partial failure — it
 * persists whatever was computed so far).
 */
export class EmbeddingSession {
    private readonly store: EmbeddingCacheStore;
    private readonly providerClient: EmbeddingProviderClient;
    private readonly options: EmbeddingSessionOptions;

    constructor(options: EmbeddingSessionOptions) {
        if (options.provider === 'ollama' && !options.model) {
            throw new Error('Ollama model is required when using --provider ollama');
        }

        this.options = options;
        this.store = new EmbeddingCacheStore(getCacheFile(options.cacheDir));
        this.providerClient = createEmbeddingProvider(options.provider, {
            model: options.model,
            ollamaHost: options.ollamaHost,
        });
    }

    async embed(text: string): Promise<EmbeddingResult> {
        const { provider, model, skipCache } = this.options;

        if (!skipCache) {
            const cached = await this.store.get(provider, model, text);
            if (cached && cached.backend && isStableEmbeddingBackend(cached.backend)) {
                return {
                    vector: cached.vector,
                    backend: cached.backend,
                    cacheHit: true,
                    fallbackReason: cached.fallbackReason,
                };
            }
        }

        const embedding = await this.providerClient.embed(text);

        if (!skipCache && isStableEmbeddingBackend(embedding.backend)) {
            this.store.set(provider, model, text, embedding.vector, embedding.backend, embedding.fallbackReason);
        }

        return {
            vector: embedding.vector,
            backend: embedding.backend,
            cacheHit: false,
            fallbackReason: embedding.fallbackReason,
        };
    }

    async flush(): Promise<void> {
        try {
            await this.store.flush();
        } catch (error) {
            if (isDebug()) {
                console.warn(`Cache write failed: ${(error as Error).message}`);
            }
        }
    }

    async cacheEntryCount(): Promise<number> {
        return this.store.entryCount();
    }
}

export async function createEmbedding({ text, ...options }: CreateEmbeddingOptions): Promise<EmbeddingResult> {
    const session = new EmbeddingSession(options);
    try {
        return await session.embed(text);
    } finally {
        await session.flush();
    }
}

const DEFAULT_HF_CONCURRENCY = 8;
const DEFAULT_OLLAMA_CONCURRENCY = 4;

export function resolveEmbedConcurrency(provider: EmbeddingProvider): number {
    const fromEnv = Number(process.env.RBT_EMBED_CONCURRENCY);
    if (Number.isFinite(fromEnv) && fromEnv >= 1) {
        return Math.floor(fromEnv);
    }
    return provider === 'ollama' ? DEFAULT_OLLAMA_CONCURRENCY : DEFAULT_HF_CONCURRENCY;
}

export async function getCacheEntryCount(cacheDir: string): Promise<number> {
    try {
        const cache = await loadCache(getCacheFile(cacheDir));
        return Object.keys(cache).length;
    } catch {
        return 0;
    }
}
