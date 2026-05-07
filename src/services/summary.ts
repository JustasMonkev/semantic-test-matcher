import {
    getSummaryCacheFile,
    readCachedSummary,
    writeCachedSummary,
} from './summary-cache.ts';
import type { DocumentProfile } from './document-profile.ts';
import { isDebug } from '../utils/io.ts';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_FILE_CHARS = 6_000;

export interface IntentSummaryOptions {
    profile: DocumentProfile;
    fileText: string;
    cacheDir: string;
    ollamaHost: string;
    summaryModel: string;
    skipCache?: boolean;
}

export interface IntentSummaryResult {
    summary: string;
    cacheHit: boolean;
    fallbackReason?: string;
}

function clipFileText(text: string): string {
    if (text.length <= MAX_FILE_CHARS) {
        return text;
    }
    return `${text.slice(0, MAX_FILE_CHARS)}\n... [truncated]`;
}

function buildPrompt(profile: DocumentProfile, fileText: string): string {
    return [
        'You are indexing a code file for a semantic test matcher.',
        'Write ONE compact paragraph (40-90 words) that captures the file\'s intent.',
        'Focus on: the behaviour or feature it implements (or tests), the domain concepts it deals with, and the public surface it exposes or exercises.',
        'Do NOT list paths, imports, or framework boilerplate. Do NOT use bullet points.',
        'Plain text only. No preamble like "This file...". Start with the subject.',
        '',
        `File: ${profile.relativePath}`,
        `Kind: ${profile.kind}`,
        '',
        '--- BEGIN FILE ---',
        clipFileText(fileText),
        '--- END FILE ---',
    ].join('\n');
}

async function requestOllamaGenerate(
    host: string,
    model: string,
    prompt: string
): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(`${host.replace(/\/$/, '')}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt,
                stream: false,
                options: { temperature: 0 },
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const details = await response.text();
            throw new Error(`Ollama error ${response.status}: ${details}`);
        }

        const payload = await response.json() as { response?: string; error?: string };
        const text = typeof payload.response === 'string' ? payload.response.trim() : '';
        if (!text) {
            throw new Error(payload.error || 'Ollama returned an empty summary');
        }
        return text;
    } finally {
        clearTimeout(timeout);
    }
}

export async function getIntentSummary({
    profile,
    fileText,
    cacheDir,
    ollamaHost,
    summaryModel,
    skipCache,
}: IntentSummaryOptions): Promise<IntentSummaryResult> {
    const cacheFile = getSummaryCacheFile(cacheDir);

    if (!skipCache) {
        const cached = await readCachedSummary(
            cacheFile,
            ollamaHost,
            summaryModel,
            fileText,
            profile.relativePath
        );
        if (cached) {
            return { summary: cached, cacheHit: true };
        }
    }

    try {
        const prompt = buildPrompt(profile, fileText);
        const summary = await requestOllamaGenerate(ollamaHost, summaryModel, prompt);

        if (!skipCache) {
            await writeCachedSummary(
                cacheFile,
                ollamaHost,
                summaryModel,
                fileText,
                profile.relativePath,
                summary
            );
        }

        return { summary, cacheHit: false };
    } catch (error) {
        const reason = (error as Error).message;
        if (isDebug()) {
            console.warn(`Intent summary failed for ${profile.relativePath}: ${reason}`);
        }
        return {
            summary: profile.summary,
            cacheHit: false,
            fallbackReason: reason,
        };
    }
}
