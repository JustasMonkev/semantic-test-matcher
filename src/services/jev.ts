import path from 'node:path';
import { mapWithConcurrency, sleep } from '../utils/async.ts';
import { debugWarn } from '../utils/io.ts';
import { isProbability, readFirstEnv } from '../utils/values.ts';
import { BufferedCache, buildCacheKey, countCacheEntries } from './cache.ts';
import {
    buildCandidateEvidence,
    buildModelEvidence,
    isRetryableStatus,
    ModelScorerError,
    packBatches,
    parseRetryAfterMs,
    type ModelCandidate,
    type ModelScorer,
    type ModelScoreResult,
    type ModelScorerOptions,
    type ModelSource,
} from './model-scorer.ts';

export const JEV_PROVIDER = 'typesafe';
export const JEV_API_KEY_NAMES = ['TYPESAFE_API_KEY', 'JEF'] as const;
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

const JEV_TOKEN_LIMIT_WITH_HEADROOM = 60_000;
const MAX_QUESTIONS_PER_REQUEST = 250;
const REQUEST_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 500;

const QUESTION_WITH_DIFF = 'Should the tests in `test_file` be re-run to check the code change shown in `changed_file`?';
const QUESTION_WITHOUT_DIFF = 'Do the tests in `test_file` exercise the behavior implemented in `changed_file`?';
const CRITERIA = {
    true: 'The tests in `test_file` exercise behavior that `changed_file` implements, so the change could alter whether they pass.',
    false: 'The tests in `test_file` cover other features; `changed_file` does not plausibly affect their outcome.',
};

type JevState = ReturnType<typeof buildModelEvidence>;

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

type JevAttempt = { response: JevResponse } | { failure: string; retryAfterMs: number };

interface CachedJevAnswer {
    createdAt: string;
    provider: string;
    model: string;
    noul: number;
}

export class JevError extends ModelScorerError {
    constructor(message: string) {
        super(message);
        this.name = 'JevError';
    }
}

export function getJevKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return readFirstEnv(JEV_API_KEY_NAMES, env);
}

export function getJevCacheFile(cacheDirectory: string): string {
    return path.join(cacheDirectory, 'jev.json');
}

export function getJevCacheEntryCount(cacheDirectory: string): Promise<number> {
    return countCacheEntries(getJevCacheFile(cacheDirectory));
}

export function buildJevQuestion(source: ModelSource, candidate: ModelCandidate): JevNoulQuestion {
    return {
        type: 'noul',
        instructions: {
            test_file: buildCandidateEvidence(candidate),
            question: source.profile.diffExcerpt ? QUESTION_WITH_DIFF : QUESTION_WITHOUT_DIFF,
        },
        criteria: CRITERIA,
    };
}

export function estimateTokensUpperBound(text: string): number {
    return Buffer.byteLength(text);
}

function questionId(candidateIndex: number): string {
    return `t${candidateIndex}`;
}

function questionTokens(question: JevNoulQuestion, candidateIndex: number): number {
    const keyValueSeparators = 2;
    return estimateTokensUpperBound(JSON.stringify(question))
        + estimateTokensUpperBound(JSON.stringify(questionId(candidateIndex)))
        + keyValueSeparators;
}

function describeFailure(status: number): string {
    const hint = status === 401 || status === 403 ? '; check TYPESAFE_API_KEY or JEF' : '';
    return `HTTP ${status}${hint}`;
}

function retryDelayMs(attempt: number, retryAfterMs: number, retryBaseMs: number): number {
    const cappedRetryAfterMs = Math.min(Number.isFinite(retryAfterMs) ? retryAfterMs : 0, MAX_RETRY_AFTER_MS);
    const backoffMs = retryBaseMs * 2 ** (attempt - 1);
    return Math.max(cappedRetryAfterMs, backoffMs);
}

function isJevResponse(value: unknown): value is JevResponse {
    return typeof value === 'object' && value !== null
        && 'answers' in value && typeof value.answers === 'object' && value.answers !== null
        && 'model' in value && typeof value.model === 'string' && value.model !== '';
}

export class JevScorer implements ModelScorer {
    private readonly options: ModelScorerOptions;
    private readonly cache: BufferedCache<CachedJevAnswer>;
    private readonly fetchImpl: typeof fetch;

    constructor(options: ModelScorerOptions) {
        if (!options.apiKey) {
            throw new JevError('TYPESAFE_API_KEY (or JEF) is required for the jev ranker');
        }
        this.options = options;
        this.cache = new BufferedCache(getJevCacheFile(options.cacheDir), 'Jev', !options.skipCache);
        this.fetchImpl = options.fetch ?? fetch;
    }

    async score(source: ModelSource, candidates: ModelCandidate[]): Promise<ModelScoreResult> {
        const { model } = this.options;
        const state = buildModelEvidence(source);
        const questions = candidates.map((candidate) => buildJevQuestion(source, candidate));
        const keys = questions.map((question) => buildCacheKey(JEV_PROVIDER, model, JSON.stringify({ state, question })));
        const scores = new Map<string, number>();
        const models = new Set<string>();
        const uncached: number[] = [];

        for (const [index, key] of keys.entries()) {
            const hit = await this.cache.get(key);
            if (hit?.model === model && isProbability(hit.noul)) {
                scores.set(candidates[index].file, hit.noul);
                models.add(hit.model);
            } else {
                uncached.push(index);
            }
        }

        let requests = 0;
        let inputTokens = 0;
        try {
            const batches = this.batchQuestions(state, questions, uncached);
            await mapWithConcurrency(batches, REQUEST_CONCURRENCY, async (batch) => {
                const { response, attempts } = await this.request(state, Object.fromEntries(
                    batch.map((index) => [questionId(index), questions[index]])
                ));
                requests += attempts;
                inputTokens += response.usage?.input_tokens ?? 0;
                models.add(response.model);

                for (const index of batch) {
                    const answer = response.answers[questionId(index)];
                    if (answer?.type !== 'noul' || !isProbability(answer.noul)) {
                        throw new JevError(`Jev response has no answer for ${candidates[index].file}`);
                    }
                    scores.set(candidates[index].file, answer.noul);
                    const answeredByPinnedModel = response.model === model;
                    if (answeredByPinnedModel) {
                        this.cache.set(keys[index], {
                            createdAt: new Date().toISOString(),
                            provider: JEV_PROVIDER,
                            model: response.model,
                            noul: answer.noul,
                        });
                    }
                }
            });
        } catch (error) {
            await this.flush();
            throw error;
        }

        return {
            provider: 'jev',
            scores,
            requests,
            cacheHits: candidates.length - uncached.length,
            inputTokens,
            models: [...models].sort(),
        };
    }

    private batchQuestions(state: JevState, questions: JevNoulQuestion[], indices: number[]): number[][] {
        const emptyPayload = JSON.stringify({ model: this.options.model, state, questions: {} });
        const tokenBudget = JEV_TOKEN_LIMIT_WITH_HEADROOM - estimateTokensUpperBound(emptyPayload);
        const tokensOf = new Map(indices.map((index) => [index, questionTokens(questions[index], index)]));
        const fits = (batch: number[]) => batch.length <= MAX_QUESTIONS_PER_REQUEST
            && batch.reduce((sum, index) => sum + tokensOf.get(index)!, 0) <= tokenBudget;

        const batches = packBatches(indices, fits);
        if (!batches) {
            throw new JevError('Jev candidate evidence exceeds the local request budget');
        }
        return batches;
    }

    private async request(
        state: JevState,
        questions: Record<string, JevNoulQuestion>
    ): Promise<{ response: JevResponse; attempts: number }> {
        const payload = JSON.stringify({ model: this.options.model, state, questions });
        const retryBaseMs = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

        for (let attempt = 1; ; attempt += 1) {
            const outcome = await this.attempt(payload);
            if ('response' in outcome) {
                return { response: outcome.response, attempts: attempt };
            }
            if (attempt >= MAX_ATTEMPTS) {
                throw new JevError(`Jev request failed after ${attempt} attempts (${outcome.failure})`);
            }
            debugWarn(`Jev request attempt ${attempt} failed (${outcome.failure}); retrying`);
            await sleep(retryDelayMs(attempt, outcome.retryAfterMs, retryBaseMs));
        }
    }

    private async attempt(payload: string): Promise<JevAttempt> {
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
                const body: unknown = await response.json();
                return isJevResponse(body)
                    ? { response: body }
                    : { failure: 'response has no answers or model', retryAfterMs: 0 };
            }
            const failure = describeFailure(response.status);
            if (!isRetryableStatus(response.status)) {
                throw new JevError(`Jev request failed (${failure})`);
            }
            return { failure, retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), Date.now()) };
        } catch (error) {
            if (error instanceof JevError) {
                throw error;
            }
            return { failure: 'network, timeout, or body-read error', retryAfterMs: 0 };
        }
    }

    flush(): Promise<void> {
        return this.cache.flush();
    }
}
