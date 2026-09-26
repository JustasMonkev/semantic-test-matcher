import path from 'node:path';
import { buildCacheKey, loadCache, writeCacheEntries } from './cache.ts';
import type { DocumentProfile } from './document-profile.ts';
import { mapWithConcurrency } from '../utils/async.ts';
import { isDebug } from '../utils/io.ts';

export const JEV_PROVIDER = 'typesafe';
export const JEV_API_KEY_ENV = 'TYPESAFE_API_KEY';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

const MAX_DIFF_CHARS = 8000;
const MAX_SOURCE_CHARS = 6000;
const MAX_EXPORTED_SYMBOLS = 20;
const MAX_TEST_TITLES = 40;
// One request must stay inside Jev's 64k-token budget (state plus every question).
// Code-heavy JSON runs at roughly 3-5 characters per token, so these caps leave headroom.
const MAX_QUESTIONS_PER_REQUEST = 250;
const MAX_QUESTION_CHARS_PER_REQUEST = 160_000;
const REQUEST_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;

const QUESTION_WITH_DIFF = 'Should the tests in `test_file` be re-run to check the code change shown in `changed_file`?';
const QUESTION_WITHOUT_DIFF = 'Do the tests in `test_file` exercise the behavior implemented in `changed_file`?';
const CRITERIA = {
    true: 'The tests in `test_file` exercise behavior that `changed_file` implements, so the change could alter whether they pass.',
    false: 'The tests in `test_file` cover other features; `changed_file` does not plausibly affect their outcome.',
};

export interface JevSource {
    profile: DocumentProfile;
    text: string;
}

export interface JevCandidate {
    file: string;
    profile: DocumentProfile;
}

export interface JevScorerOptions {
    apiKey: string;
    model: string;
    cacheDir: string;
    skipCache?: boolean;
    fetch?: typeof fetch;
    retryBaseMs?: number;
}

export interface JevScoreResult {
    scores: Map<string, number>;
    requests: number;
    cacheHits: number;
    inputTokens: number;
    /** Versioned model that answered, when any request was made. */
    model?: string;
}

interface JevNoulQuestion {
    type: 'noul';
    instructions: { test_file: { path: string; test_titles: string[] }; question: string };
    criteria: typeof CRITERIA;
}

interface JevResponse {
    model: string;
    answers: Record<string, { type: string; noul?: number }>;
    usage?: { input_tokens?: number; output_tokens?: number };
}

interface CachedJevAnswer {
    createdAt: string;
    provider: string;
    model: string;
    noul: number;
}

export class JevError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JevError';
    }
}

export function getJevCacheFile(cacheDirectory: string): string {
    return path.join(cacheDirectory, 'jev.json');
}

function truncate(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…(truncated)`;
}

export function buildJevState(source: JevSource): { changed_file: Record<string, unknown> } {
    const changedFile: Record<string, unknown> = {
        path: source.profile.relativePath,
        exported_symbols: source.profile.exports.slice(0, MAX_EXPORTED_SYMBOLS),
    };
    if (source.profile.diffExcerpt) {
        changedFile.diff = truncate(source.profile.diffExcerpt, MAX_DIFF_CHARS);
    } else {
        // Drop a leading license/doc block so the excerpt spends its budget on code.
        changedFile.source_code = truncate(source.text.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''), MAX_SOURCE_CHARS);
    }
    return { changed_file: changedFile };
}

export function buildJevQuestion(source: JevSource, candidate: JevCandidate): JevNoulQuestion {
    return {
        type: 'noul',
        instructions: {
            test_file: {
                path: candidate.file,
                test_titles: candidate.profile.testTitles.slice(0, MAX_TEST_TITLES),
            },
            question: source.profile.diffExcerpt ? QUESTION_WITH_DIFF : QUESTION_WITHOUT_DIFF,
        },
        criteria: CRITERIA,
    };
}

function batchQuestions(indices: number[], questions: JevNoulQuestion[]): number[][] {
    const batches: number[][] = [];
    let current: number[] = [];
    let currentChars = 0;

    for (const index of indices) {
        const size = JSON.stringify(questions[index]).length;
        if (
            current.length &&
            (current.length >= MAX_QUESTIONS_PER_REQUEST || currentChars + size > MAX_QUESTION_CHARS_PER_REQUEST)
        ) {
            batches.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(index);
        currentChars += size;
    }

    if (current.length) {
        batches.push(current);
    }
    return batches;
}

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

function describeFailure(status: number, body: string): string {
    const hint = status === 401 || status === 403 ? `; check ${JEV_API_KEY_ENV}` : '';
    return `HTTP ${status}${hint}: ${body.slice(0, 200)}`;
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scores candidate test files against a changed file with TypeSafe's Jev model.
 *
 * Each candidate is one Noul question ("should this test file be re-run?") evaluated
 * against a shared state describing the change, so a whole candidate list usually
 * costs one request. Answers are cached per question; like EmbeddingSession, the
 * cache is read once and new answers are written on flush().
 */
export class JevScorer {
    private cachePromise?: Promise<Record<string, CachedJevAnswer>>;
    private pending: Record<string, CachedJevAnswer> = {};
    private readonly options: JevScorerOptions;
    private readonly cacheFile: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: JevScorerOptions) {
        if (!options.apiKey) {
            throw new JevError(`${JEV_API_KEY_ENV} is required for the jev ranker`);
        }
        this.options = options;
        this.cacheFile = getJevCacheFile(options.cacheDir);
        this.fetchImpl = options.fetch ?? fetch;
    }

    private getCache(): Promise<Record<string, CachedJevAnswer>> {
        this.cachePromise ??= loadCache<CachedJevAnswer>(this.cacheFile).catch((error) => {
            if (isDebug()) {
                console.warn(`Jev cache read failed: ${(error as Error).message}`);
            }
            return {};
        });
        return this.cachePromise;
    }

    async score(source: JevSource, candidates: JevCandidate[]): Promise<JevScoreResult> {
        const state = buildJevState(source);
        const questions = candidates.map((candidate) => buildJevQuestion(source, candidate));
        const keys = questions.map((question) =>
            buildCacheKey(JEV_PROVIDER, this.options.model, JSON.stringify({ state, question }))
        );
        const cache = this.options.skipCache ? {} : await this.getCache();
        const scores = new Map<string, number>();
        const uncached: number[] = [];

        keys.forEach((key, index) => {
            const hit = this.pending[key] ?? cache[key];
            if (typeof hit?.noul === 'number') {
                scores.set(candidates[index].file, hit.noul);
            } else {
                uncached.push(index);
            }
        });

        const result: JevScoreResult = {
            scores,
            requests: 0,
            cacheHits: candidates.length - uncached.length,
            inputTokens: 0,
        };

        await mapWithConcurrency(batchQuestions(uncached, questions), REQUEST_CONCURRENCY, async (batch) => {
            const response = await this.request({
                state,
                questions: Object.fromEntries(batch.map((index) => [`t${index}`, questions[index]])),
            });
            result.requests += 1;
            result.inputTokens += response.usage?.input_tokens ?? 0;
            result.model = response.model;

            for (const index of batch) {
                const noul = response.answers?.[`t${index}`]?.noul;
                if (typeof noul !== 'number' || !Number.isFinite(noul)) {
                    throw new JevError(`Jev response has no answer for ${candidates[index].file}`);
                }
                scores.set(candidates[index].file, noul);
                if (!this.options.skipCache) {
                    this.pending[keys[index]] = {
                        createdAt: new Date().toISOString(),
                        provider: JEV_PROVIDER,
                        model: response.model,
                        noul,
                    };
                }
            }
        });

        return result;
    }

    private async request(body: object): Promise<JevResponse> {
        const payload = JSON.stringify({ model: this.options.model, ...body });
        const retryBaseMs = this.options.retryBaseMs ?? 500;

        for (let attempt = 1; ; attempt += 1) {
            let failure: string;
            let retryAfterMs = 0;
            try {
                const response = await this.fetchImpl(JEV_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.options.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: payload,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
                if (response.ok) {
                    return await response.json() as JevResponse;
                }
                failure = describeFailure(response.status, await response.text());
                if (!isRetryableStatus(response.status)) {
                    throw new JevError(`Jev request failed (${failure})`);
                }
                retryAfterMs = Number(response.headers.get('retry-after') ?? 0) * 1000;
            } catch (error) {
                if (error instanceof JevError) {
                    throw error;
                }
                failure = (error as Error).message;
            }

            if (attempt >= MAX_ATTEMPTS) {
                throw new JevError(`Jev request failed after ${attempt} attempts (${failure})`);
            }
            if (isDebug()) {
                console.warn(`Jev request attempt ${attempt} failed (${failure}); retrying`);
            }
            await sleep(Math.max(Number.isFinite(retryAfterMs) ? retryAfterMs : 0, retryBaseMs * 2 ** (attempt - 1)));
        }
    }

    /** Persists buffered answers in a single locked cache write. Best-effort. */
    async flush(): Promise<void> {
        if (!Object.keys(this.pending).length) {
            return;
        }

        try {
            await writeCacheEntries(this.cacheFile, this.pending);
            this.pending = {};
        } catch (error) {
            if (isDebug()) {
                console.warn(`Jev cache write failed: ${(error as Error).message}`);
            }
        }
    }
}
