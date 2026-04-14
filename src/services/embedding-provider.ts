import { pipeline } from '@huggingface/transformers';
import type { EmbeddingProvider } from '../config.ts';
import type { LiveEmbeddingResult } from './embedding-types.ts';
import { textToVector } from './text-vector.ts';

export interface EmbeddingProviderConfig {
    model: string;
    ollamaHost: string;
}

const pipelineCache = new Map<string, any>();

function isNumericVector(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function collectNumericVectors(value: unknown, output: number[][] = []): number[][] {
    if (!Array.isArray(value)) {
        return output;
    }

    if (isNumericVector(value)) {
        output.push(value);
        return output;
    }

    for (const item of value) {
        collectNumericVectors(item, output);
    }

    return output;
}

function isTensorLikeEmbedding(value: unknown): value is { data: ArrayLike<unknown>; dims: number[] } {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as { data?: ArrayLike<unknown>; dims?: unknown };
    return typeof candidate.data === 'object' &&
        candidate.data !== null &&
        Array.isArray(candidate.dims) &&
        candidate.dims.every((dim) => typeof dim === 'number' && Number.isInteger(dim) && dim > 0);
}

function normalizeTensorLikeEmbedding(value: { data: ArrayLike<unknown>; dims: number[] }): number[] {
    const width = value.dims[value.dims.length - 1];
    const components = Array.from(value.data, (item) => Number(item)).filter(Number.isFinite);
    if (!width || !components.length || components.length % width !== 0) {
        throw new Error('Unable to interpret embedding tensor dimensions');
    }

    const rows = components.length / width;
    const pooled = new Array(width).fill(0);

    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < width; column += 1) {
            pooled[column] += components[(row * width) + column];
        }
    }

    return pooled.map((component) => component / rows);
}

export function normalizeEmbeddingTensor(value: unknown): number[] {
    if (isTensorLikeEmbedding(value)) {
        return normalizeTensorLikeEmbedding(value);
    }

    const vectors = collectNumericVectors(value);
    if (!vectors.length) {
        throw new Error('Unable to interpret embedding response shape');
    }

    const width = Math.max(...vectors.map((vector) => vector.length));
    const pooled = new Array(width).fill(0);

    for (const vector of vectors) {
        for (let index = 0; index < vector.length; index += 1) {
            pooled[index] += vector[index];
        }
    }

    return pooled.map((component) => component / vectors.length);
}

function sanitizeOllamaVector(vector: unknown): number[] {
    if (!Array.isArray(vector)) {
        throw new Error('Ollama embeddings response shape is invalid');
    }

    const numeric = vector.filter((component): component is number => typeof component === 'number' && Number.isFinite(component));
    if (!numeric.length) {
        throw new Error('Ollama embeddings response did not contain numeric values');
    }

    return numeric;
}

async function requestOllamaJson(
    host: string,
    endpoint: string,
    body: object,
    timeoutMs: number
): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${host.replace(/\/$/, '')}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const details = await response.text();
            throw new Error(`Ollama error ${response.status}: ${details}`);
        }

        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

async function ollamaSemanticDigest(model: string, host: string, text: string): Promise<string> {
    const payload = await requestOllamaJson(
        host,
        '/api/generate',
        {
            model,
            prompt: [
                'Normalize the following code into a compact semantic fingerprint.',
                'Return lowercase plain text only.',
                'Include the file purpose, exported symbols, test intent, and key domain terms.',
                'Prefer 8 to 12 comma separated phrases.',
                '',
                text,
            ].join('\n'),
            stream: false,
            options: {
                temperature: 0,
            },
        },
        60000
    ) as { response?: string; error?: string };

    const digest = typeof payload.response === 'string' ? payload.response.trim() : '';
    if (!digest) {
        throw new Error(payload.error || 'Ollama did not return a semantic digest');
    }

    return digest;
}

export interface EmbeddingProviderClient {
    embed(text: string): Promise<LiveEmbeddingResult>;
}

class StubHuggingFaceEmbeddingProvider implements EmbeddingProviderClient {
    async embed(text: string): Promise<LiveEmbeddingResult> {
        return {
            vector: textToVector(text),
            backend: 'hf',
        };
    }
}

class HuggingFaceEmbeddingProvider implements EmbeddingProviderClient {
    private model: string;
    private pipelineCacheKey: string;

    constructor(model: string) {
        this.model = model;
        this.pipelineCacheKey = `hf:${model}`;
    }

    private async getPipeline() {
        const existing = pipelineCache.get(this.pipelineCacheKey);
        if (existing) {
            return existing;
        }

        const extractor = await pipeline('feature-extraction', this.model, {
            dtype: 'fp32',
        });
        pipelineCache.set(this.pipelineCacheKey, extractor);
        return extractor;
    }

    async embed(text: string): Promise<LiveEmbeddingResult> {
        const extractor = await this.getPipeline();
        const extracted = await extractor(text);
        return {
            vector: normalizeEmbeddingTensor(extracted),
            backend: 'hf',
        };
    }
}

class OllamaEmbeddingProvider implements EmbeddingProviderClient {
    private model: string;
    private host: string;

    constructor(model: string, host: string) {
        this.model = model;
        this.host = host;
    }

    async embed(text: string): Promise<LiveEmbeddingResult> {
        let embeddingError: Error | undefined;
        try {
            const payload = await requestOllamaJson(
                this.host,
                '/api/embeddings',
                {
                    model: this.model,
                    prompt: text,
                },
                60000
            ) as { embedding?: number[]; error?: string };

            if (!payload.embedding) {
                throw new Error(payload.error || 'Ollama did not return an embedding');
            }

            return {
                vector: sanitizeOllamaVector(payload.embedding),
                backend: 'ollama-embeddings',
            };
        } catch (error) {
            embeddingError = error as Error;
            if (process.env.RBT_DEBUG === '1') {
                console.warn(
                    `Ollama embeddings failed for ${this.model}; falling back to semantic digest: ${embeddingError.message}`
                );
            }
        }

        try {
            const digest = await ollamaSemanticDigest(this.model, this.host, text);
            return {
                vector: textToVector(digest),
                backend: 'ollama-generate',
                fallbackReason: `ollama embeddings failed: ${embeddingError?.message || 'unknown error'}`,
            };
        } catch (fallbackError) {
            if (process.env.RBT_DEBUG === '1') {
                console.warn(
                    `Ollama semantic digest fallback failed for ${this.model}; using local vectorizer: ${(fallbackError as Error).message}`
                );
            }

            return {
                vector: textToVector(text),
                backend: 'local-text-vector',
                fallbackReason: [
                    `ollama embeddings failed: ${embeddingError?.message || 'unknown error'}`,
                    `ollama semantic digest failed: ${(fallbackError as Error).message}`,
                ].join('; '),
            };
        }
    }
}

export function createEmbeddingProvider(
    provider: EmbeddingProvider,
    { model, ollamaHost }: EmbeddingProviderConfig
): EmbeddingProviderClient {
    if (provider === 'hf' && process.env.RBT_EMBEDDING_TEST_MODE === 'hf-stub') {
        return new StubHuggingFaceEmbeddingProvider();
    }

    if (provider === 'ollama') {
        return new OllamaEmbeddingProvider(model, ollamaHost);
    }

    return new HuggingFaceEmbeddingProvider(model);
}
