import { createEmbeddingProvider } from './embedding-provider.ts';
import type { EmbeddingResult } from './embedding-types.ts';
import {
    buildCacheKey,
    getCacheFile,
    loadCache,
    writeCachedEmbeddings,
    type CachedEmbedding,
    type EmbeddingCache,
} from './cache.ts';
import { isDebug } from '../utils/io.ts';

export const EMBEDDING_BACKEND = 'node-llama-cpp';

export interface EmbeddingSessionOptions {
    model: string;
    cacheDir: string;
    skipCache?: boolean;
}

export interface CreateEmbeddingOptions extends EmbeddingSessionOptions {
    text: string;
}

/**
 * Embeds texts against a single model/cache configuration.
 *
 * The on-disk cache is read once per session and new embeddings are buffered
 * in memory, so callers embedding many documents pay for one cache read and
 * one locked cache write (on flush) instead of one of each per document.
 */
export class EmbeddingSession {
    private cachePromise?: Promise<EmbeddingCache>;
    private pending: EmbeddingCache = {};
    private providerClient?: ReturnType<typeof createEmbeddingProvider>;
    private readonly options: EmbeddingSessionOptions;
    private readonly cacheFile: string;

    constructor(options: EmbeddingSessionOptions) {
        if (!options.model) {
            throw new Error('A local GGUF embedding model path is required');
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
        const { model, skipCache } = this.options;
        const key = buildCacheKey(EMBEDDING_BACKEND, model, text);

        if (!skipCache) {
            const cache = await this.getCache();
            const hit = this.pending[key] ?? cache[key];
            if (hit?.backend === EMBEDDING_BACKEND) {
                return {
                    vector: hit.vector,
                    backend: hit.backend,
                    cacheHit: true,
                };
            }
        }

        this.providerClient ??= createEmbeddingProvider(model);
        const embedding = await this.providerClient.embed(text);

        if (!skipCache) {
            const entry: CachedEmbedding = {
                createdAt: new Date().toISOString(),
                provider: EMBEDDING_BACKEND,
                model,
                vector: embedding.vector,
                backend: embedding.backend,
            };
            this.pending[key] = entry;
        }

        return {
            vector: embedding.vector,
            backend: embedding.backend,
            cacheHit: false,
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
