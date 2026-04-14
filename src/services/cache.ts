import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { EmbeddingBackend } from './embedding-types.ts';

export interface CachedEmbedding {
    createdAt: string;
    provider: string;
    model: string;
    vector: number[];
    backend?: EmbeddingBackend;
    fallbackReason?: string;
}

export interface EmbeddingCache {
    [hash: string]: CachedEmbedding;
}

const LOCK_POLL_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

function sanitizeKey(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
}

function debugCache(message: string): void {
    if (process.env.RBT_DEBUG === '1') {
        console.warn(`Cache: ${message}`);
    }
}

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isMalformedCache(error: unknown): boolean {
    return error instanceof SyntaxError;
}

function getCacheLockFile(filePath: string): string {
    const parsed = path.parse(filePath);
    return path.join(parsed.dir, `${parsed.name}.lock`);
}

function getDelayMs(): number {
    const parsed = Number(process.env.RBT_CACHE_WRITE_DELAY_MS || 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireCacheLock(filePath: string): Promise<{ handle: FileHandle; lockPath: string }> {
    const lockPath = getCacheLockFile(filePath);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    await fs.mkdir(path.dirname(filePath), { recursive: true });

    while (true) {
        try {
            const handle = await fs.open(lockPath, 'wx');
            await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
            return { handle, lockPath };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST') {
                throw error;
            }

            try {
                const stats = await fs.stat(lockPath);
                if ((Date.now() - stats.mtimeMs) > STALE_LOCK_MS) {
                    await fs.unlink(lockPath).catch(() => {});
                    continue;
                }
            } catch (statError) {
                if (!isMissingFile(statError)) {
                    throw statError;
                }
                continue;
            }

            if (Date.now() >= deadline) {
                throw new Error(`Timed out acquiring cache lock for ${lockPath}`);
            }

            await sleep(LOCK_POLL_MS);
        }
    }
}

async function releaseCacheLock(lockPath: string, handle: FileHandle): Promise<void> {
    try {
        await handle.close();
    } finally {
        try {
            await fs.unlink(lockPath);
        } catch (error) {
            if (!isMissingFile(error)) {
                debugCache(`Unable to remove cache lock ${lockPath}: ${(error as Error).message}`);
            }
        }
    }
}

export async function loadCache(filePath: string): Promise<EmbeddingCache> {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw) as EmbeddingCache;
    } catch (error) {
        if (isMissingFile(error)) {
            return {};
        }

        if (isMalformedCache(error)) {
            debugCache(`Ignoring malformed cache file at ${filePath}: ${(error as Error).message}`);
            return {};
        }

        throw error;
    }
}

export async function persistCache(filePath: string, cache: EmbeddingCache): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempFile = path.join(
        path.dirname(filePath),
        `${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    const delayMs = getDelayMs();

    await fs.writeFile(tempFile, JSON.stringify(cache, null, 2), 'utf8');
    if (delayMs > 0) {
        await sleep(delayMs);
    }
    await fs.rename(tempFile, filePath);
}

export function buildCacheKey(provider: string, model: string, text: string): string {
    const normalized = text
        .replace(/\r\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim();
    return sanitizeKey(`${provider}|${model}|${normalized}`);
}

export async function readCachedEmbedding(
    filePath: string,
    provider: string,
    model: string,
    text: string
): Promise<{ vector: number[]; backend: EmbeddingBackend; fallbackReason?: string } | null> {
    const cache = await loadCache(filePath);
    const hit = cache[buildCacheKey(provider, model, text)];
    if (!hit) {
        return null;
    }

    return {
        vector: hit.vector,
        backend: hit.backend ?? (provider === 'hf' ? 'hf' : 'cache-unknown'),
        fallbackReason: hit.fallbackReason,
    };
}

export async function writeCachedEmbedding(
    filePath: string,
    provider: string,
    model: string,
    text: string,
    vector: number[],
    backend: EmbeddingBackend,
    fallbackReason?: string
): Promise<void> {
    const lock = await acquireCacheLock(filePath);
    try {
        const cache = await loadCache(filePath);
        const key = buildCacheKey(provider, model, text);
        cache[key] = {
            createdAt: new Date().toISOString(),
            provider,
            model,
            vector,
            backend,
            fallbackReason,
        };
        await persistCache(filePath, cache);
    } finally {
        await releaseCacheLock(lock.lockPath, lock.handle);
    }
}

export function getCacheFile(cacheDirectory: string): string {
    return path.join(cacheDirectory, 'embeddings.json');
}
