import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { isDebug } from '../utils/io.ts';

export interface CachedSummary {
    createdAt: string;
    host: string;
    model: string;
    summary: string;
}

export interface SummaryCache {
    [hash: string]: CachedSummary;
}

function sanitizeKey(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
}

export function getSummaryCacheFile(cacheDirectory: string): string {
    return path.join(cacheDirectory, 'summaries.json');
}

export function buildSummaryCacheKey(host: string, model: string, fileText: string, relativePath: string): string {
    const normalized = fileText.replace(/\r\n/g, '\n');
    return sanitizeKey(`${host}|${model}|${relativePath}|${normalized}`);
}

export async function loadSummaryCache(filePath: string): Promise<SummaryCache> {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw) as SummaryCache;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || error instanceof SyntaxError) {
            return {};
        }
        throw error;
    }
}

export async function readCachedSummary(
    filePath: string,
    host: string,
    model: string,
    fileText: string,
    relativePath: string
): Promise<string | null> {
    const cache = await loadSummaryCache(filePath);
    const hit = cache[buildSummaryCacheKey(host, model, fileText, relativePath)];
    return hit?.summary ?? null;
}

export async function writeCachedSummary(
    filePath: string,
    host: string,
    model: string,
    fileText: string,
    relativePath: string,
    summary: string
): Promise<void> {
    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const cache = await loadSummaryCache(filePath);
        cache[buildSummaryCacheKey(host, model, fileText, relativePath)] = {
            createdAt: new Date().toISOString(),
            host,
            model,
            summary,
        };
        await fs.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf8');
    } catch (error) {
        if (isDebug()) {
            console.warn(`Summary cache write failed: ${(error as Error).message}`);
        }
    }
}
