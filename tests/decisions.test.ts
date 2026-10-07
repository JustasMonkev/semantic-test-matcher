import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDocumentProfile } from '../src/services/document-profile.ts';
import {
    buildDecisionsInput, DECISIONS_ENDPOINT, DECISIONS_MODEL, DecisionsError, DecisionsScorer,
    getDecisionsCacheEntryCount, getDecisionsCacheFile, getOpenAIKey,
} from '../src/services/decisions.ts';
import type { DecisionsScorerOptions } from '../src/services/decisions.ts';
import type { ModelCandidate, ModelSource } from '../src/services/model-scorer.ts';
import { ModelScorerError } from '../src/services/model-scorer.ts';
import { getJevKey, JevError } from '../src/services/jev.ts';
import { createModelScorer } from '../src/services/model-scorer-factory.ts';

const text = '/** license omitted */\nexport function chooseTab(index: number) { return tabs[index]; }';
const diff = 'diff --git a/src/tabs.ts b/src/tabs.ts\n--- a/src/tabs.ts\n+++ b/src/tabs.ts\n@@ -1 +1 @@\n- return index && tabs[index];\n+ return tabs[index];\n';
function source(change?: string): ModelSource {
    return { profile: buildDocumentProfile('/workspace/src/tabs.ts', text, '/workspace', change), text };
}
function candidate(file: string): ModelCandidate {
    return { file, profile: buildDocumentProfile(`/workspace/${file}`, "test('selects tab', () => { const secretTestBody = true; });", '/workspace') };
}
const candidates = [candidate('tests/tabs.spec.ts'), candidate('tests/network.spec.ts')];

interface RequestBody {
    model: string;
    input: string;
    questions: Array<{ type: string; name: string; instructions: string }>;
}

function fakeFetch(handler: (body: RequestBody, count: number) => Response) {
    const calls: Array<{ url: string; init?: RequestInit; body: RequestBody }> = [];
    const impl: typeof fetch = async (url, init) => {
        const body = JSON.parse(String(init?.body)) as RequestBody;
        calls.push({ url: String(url), init, body });
        return handler(body, calls.length);
    };
    return { impl, calls };
}

function answer(body: RequestBody, probability = 0.85): Response {
    return Response.json({
        model: body.model,
        answers: body.questions.map(question => ({ type: 'predicate', name: question.name, probability })),
        usage: { input_tokens: 101, output_tokens: 0 },
    });
}

describe('DecisionsScorer', () => {
    let cacheDir: string;
    beforeEach(async () => { cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-decisions-')); });
    afterEach(async () => { await fs.rm(cacheDir, { recursive: true, force: true }); });
    function scorer(impl: typeof fetch, options: Partial<DecisionsScorerOptions> = {}): DecisionsScorer {
        return new DecisionsScorer({ apiKey: 'test-key', model: DECISIONS_MODEL, cacheDir, fetch: impl, retryBaseMs: 1, ...options });
    }

    it('uses independent named predicates and maps reordered answers by name, including valid zero', async () => {
        const { impl, calls } = fakeFetch(body => Response.json({ model: body.model, answers: [
            { type: 'predicate', name: body.questions[1].name, probability: 0 },
            { type: 'predicate', name: body.questions[0].name, probability: 1 },
        ], usage: { input_tokens: 101, output_tokens: 0 } }));
        const result = await scorer(impl).score(source(diff), candidates);
        assert.deepEqual([...result.scores], [[candidates[0].file, 1], [candidates[1].file, 0]]);
        assert.equal(result.provider, 'decisions');
        assert.equal(result.inputTokens, 101);
        assert.equal(result.outputTokens, 0);
        assert.deepEqual(result.models, [DECISIONS_MODEL]);
        assert.equal(calls[0].url, DECISIONS_ENDPOINT);
        assert.equal(calls[0].init?.method, 'POST');
        assert.deepEqual(calls[0].init?.headers, { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' });
        assert.ok(calls[0].body.questions.every(question => question.type === 'predicate'));
        assert.match(calls[0].body.questions[0].instructions, /tests\/tabs.spec.ts/);
        assert.match(calls[0].body.questions[0].instructions, /selects tab/);
        assert.doesNotMatch(JSON.stringify(calls[0].body), /secretTestBody|license omitted|source_code/);
        assert.match(calls[0].body.input, /diff/);
    });

    it('reports unavailable usage as undefined, not zero', async () => {
        const { impl } = fakeFetch(body => Response.json({ answers: body.questions.map(q => ({ type: 'predicate', name: q.name, probability: 0.4 })) }));
        const result = await scorer(impl).score(source(), candidates);
        assert.equal(result.inputTokens, undefined);
        assert.equal(result.outputTokens, undefined);
        assert.deepEqual(result.models, [DECISIONS_MODEL]);
        assert.equal(result.modelIdentity, 'requested');
        assert.equal(await getDecisionsCacheEntryCount(cacheDir), 0);
    });

    const invalidAnswers: Array<[string, (body: RequestBody) => unknown]> = [
        ['missing answers', () => ({})],
        ['null', () => null],
        ['object answers', () => ({ answers: {} })],
        ['missing candidate', body => ({ answers: [{ type: 'predicate', name: body.questions[0].name, probability: 0.5 }] })],
        ['duplicate names', body => ({ answers: body.questions.map(() => ({ type: 'predicate', name: body.questions[0].name, probability: 0.5 })) })],
        ['unknown name', body => ({ answers: body.questions.map(q => ({ type: 'predicate', name: `${q.name}-unknown`, probability: 0.5 })) })],
        ['missing name', body => ({ answers: body.questions.map(() => ({ type: 'predicate', probability: 0.5 })) })],
        ['wrong type', body => ({ answers: body.questions.map(q => ({ type: 'score', name: q.name, probability: 0.5 })) })],
        ['string probability', body => ({ answers: body.questions.map(q => ({ type: 'predicate', name: q.name, probability: '0.5' })) })],
        ['negative probability', body => ({ answers: body.questions.map(q => ({ type: 'predicate', name: q.name, probability: -0.01 })) })],
        ['over-one probability', body => ({ answers: body.questions.map(q => ({ type: 'predicate', name: q.name, probability: 1.01 })) })],
        ['null probability', body => ({ answers: body.questions.map(q => ({ type: 'predicate', name: q.name, probability: null })) })],
        ['refusal', body => ({ answers: body.questions.map(q => ({ type: 'refusal', name: q.name })) })],
        ['empty model', body => ({ model: '', answers: body.questions.map(q => ({ type: 'predicate', name: q.name, probability: 0.5 })) })],
    ];
    for (const [label, makeBody] of invalidAnswers) {
        it(`rejects ${label} without retrying or caching partial answers`, async () => {
            const { impl, calls } = fakeFetch(body => Response.json(makeBody(body)));
            const instance = scorer(impl);
            await assert.rejects(instance.score(source(), candidates), DecisionsError);
            await instance.flush();
            assert.equal(calls.length, 1);
            assert.equal(await getDecisionsCacheEntryCount(cacheDir), 0);
        });
    }

    it('rejects invalid JSON without retrying', async () => {
        const { impl, calls } = fakeFetch(() => new Response('{', { status: 200 }));
        await assert.rejects(scorer(impl).score(source(), candidates), /not valid JSON/);
        assert.equal(calls.length, 1);
    });

    it('splits candidate questions into bounded requests and sums usage', async () => {
        const { impl, calls } = fakeFetch(body => answer(body));
        const many = Array.from({ length: 130 }, (_, index) => candidate(`tests/tab-${index}.spec.ts`));
        const result = await scorer(impl).score(source(), many);
        assert.equal(result.scores.size, 130);
        assert.equal(calls.length, 3);
        assert.equal(result.requests, 3);
        assert.equal(result.inputTokens, 303);
        assert.ok(calls.every(call => call.body.questions.length <= 64 && Buffer.byteLength(String(call.init?.body)) <= 60_000));
    });

    it('rejects oversized candidate metadata without making a request', async () => {
        const { impl, calls } = fakeFetch(body => answer(body));
        await assert.rejects(scorer(impl).score(source(), [candidate(`tests/${'x'.repeat(61_000)}.spec.ts`)]), /request budget/);
        assert.equal(calls.length, 0);
    });

    it('retries transient statuses, counting retry requests', async () => {
        const { impl, calls } = fakeFetch((body, count) => count < 3 ? new Response('busy', { status: count === 1 ? 429 : 503 }) : answer(body));
        const result = await scorer(impl).score(source(), candidates);
        assert.equal(calls.length, 3);
        assert.equal(result.requests, 3);
        assert.equal(result.inputTokens, 101);
    });

    it('stops retrying after three failed requests', async () => {
        const { impl, calls } = fakeFetch(() => new Response('down', { status: 500 }));
        await assert.rejects(scorer(impl).score(source(), candidates), /after 3 attempts \(HTTP 500\)/);
        assert.equal(calls.length, 3);
    });

    for (const retryAfter of ['5', 'Wed, 07 Oct 2026 12:00:05 GMT']) {
        it(`does not retry earlier than an excessive Retry-After: ${retryAfter}`, async () => {
            const { impl, calls } = fakeFetch((body, count) => count === 1
                ? new Response('busy', { status: 429, headers: { 'Retry-After': retryAfter } })
                : answer(body));
            await assert.rejects(scorer(impl, { now: () => Date.parse('2026-10-07T12:00:00Z') }).score(source(), candidates),
                /Retry-After exceeds the local retry delay limit/);
            assert.equal(calls.length, 1);
        });
    }

    it('does not retry credential errors or expose upstream text', async () => {
        const { impl, calls } = fakeFetch(() => new Response('secret test-key repository content', { status: 401 }));
        await assert.rejects(scorer(impl).score(source(), candidates), error => {
            assert.ok(error instanceof ModelScorerError);
            assert.match(error.message, /HTTP 401/);
            assert.doesNotMatch(error.message, /secret|test-key|repository/);
            return true;
        });
        assert.equal(calls.length, 1);
    });

    it('retries network errors without leaking their messages', async () => {
        let calls = 0;
        const impl: typeof fetch = async () => { calls += 1; throw new TypeError('secret test-key'); };
        await assert.rejects(scorer(impl).score(source(), candidates), /after 3 attempts \(network or timeout error\)/);
        assert.equal(calls, 3);
    });

    it('preserves unrelated implementation errors for callers instead of treating them as availability failures', async () => {
        const bug = new Error('programming bug');
        const impl: typeof fetch = async () => { throw bug; };
        await assert.rejects(scorer(impl).score(source(), candidates), error => error === bug);
    });

    it('aborts a slow request and exhausts bounded timeout retries', async () => {
        let calls = 0;
        const impl: typeof fetch = async (_url, init) => {
            calls += 1;
            const signal = init?.signal;
            assert.ok(signal);
            return new Promise<Response>((_resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('request was not aborted')), 100);
                signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
            });
        };
        await assert.rejects(scorer(impl, { timeoutMs: 5 }).score(source(), candidates), /after 3 attempts/);
        assert.equal(calls, 3);
    });

    it('reuses fresh cache entries, isolates Jev cache, and expires an alias after 24 hours', async () => {
        let now = Date.parse('2026-10-07T00:00:00Z');
        const { impl, calls } = fakeFetch(body => answer(body));
        const first = scorer(impl, { now: () => now });
        await first.score(source(diff), candidates);
        await first.flush();
        assert.equal(await getDecisionsCacheEntryCount(cacheDir), 2);
        assert.equal(path.basename(getDecisionsCacheFile(cacheDir)), 'decisions.json');
        await fs.writeFile(path.join(cacheDir, 'jev.json'), '{}');
        const warm = await scorer(impl, { now: () => now }).score(source(diff), candidates);
        assert.equal(warm.requests, 0);
        assert.equal(warm.cacheHits, 2);
        assert.equal(warm.inputTokens, 0);
        assert.equal(calls.length, 1);
        now += 24 * 60 * 60 * 1000;
        const expired = await scorer(impl, { now: () => now }).score(source(diff), candidates);
        assert.equal(expired.cacheHits, 0);
        assert.equal(calls.length, 2);
    });

    it('invalidates cache when source evidence, candidate titles, or requested model changes', async () => {
        const { impl, calls } = fakeFetch(body => answer(body));
        const first = scorer(impl);
        await first.score(source(), candidates);
        await first.flush();
        const changed = source(); changed.text += '\nexport const altered = true;';
        assert.equal((await scorer(impl).score(changed, candidates)).cacheHits, 0);
        const renamedTitle = { ...candidates[0], profile: { ...candidates[0].profile, testTitles: ['new behavior'] } };
        assert.equal((await scorer(impl).score(source(), [renamedTitle])).cacheHits, 0);
        assert.equal((await scorer(impl, { model: 'different-model' }).score(source(), candidates)).cacheHits, 0);
        assert.equal(calls.length, 4);
    });

    it('reuses candidate cache independently of candidate order and request-local names', async () => {
        const { impl, calls } = fakeFetch(body => answer(body));
        const first = scorer(impl);
        await first.score(source(), candidates);
        await first.flush();
        const reordered = await scorer(impl).score(source(), [...candidates].reverse());
        assert.equal(reordered.cacheHits, 2);
        assert.equal(reordered.requests, 0);
        assert.equal(calls.length, 1);
    });

    it('rejects cached entries with invalid probabilities, provider, prompt, or creation time', async () => {
        const { impl, calls } = fakeFetch(body => answer(body));
        const first = scorer(impl);
        await first.score(source(), candidates);
        await first.flush();
        const file = getDecisionsCacheFile(cacheDir);
        const original: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
        assert.ok(typeof original === 'object' && original !== null);
        for (const corrupt of [
            { probability: -1 }, { provider: 'typesafe' }, { promptVersion: 'old' },
            { createdAt: 'invalid date' }, { createdAt: '2099-01-01T00:00:00Z' },
        ]) {
            await fs.writeFile(file, JSON.stringify(Object.fromEntries(Object.entries(original)
                .map(([key, entry]) => [key, { ...entry, ...corrupt }]))));
            const result = await scorer(impl).score(source(), candidates);
            assert.equal(result.cacheHits, 0);
        }
        assert.equal(calls.length, 6);
    });

    it('does not cache a different model returned for a moving alias', async () => {
        const { impl } = fakeFetch(body => Response.json({ model: 'gpt-6-luna-pinned-version', answers: body.questions.map(q => ({ type: 'predicate', name: q.name, probability: 0.5 })) }));
        const instance = scorer(impl);
        assert.deepEqual((await instance.score(source(), candidates)).models, ['gpt-6-luna-pinned-version']);
        await instance.flush();
        assert.equal(await getDecisionsCacheEntryCount(cacheDir), 0);
    });

    it('skip-cache bypasses persistent and pending entries and performs no cache write', async () => {
        const { impl, calls } = fakeFetch(body => answer(body));
        const instance = scorer(impl, { skipCache: true });
        await instance.score(source(), candidates);
        await instance.score(source(), candidates);
        await instance.flush();
        assert.equal(calls.length, 2);
        assert.equal(await getDecisionsCacheEntryCount(cacheDir), 0);
    });

    it('retains completed cache work when a later batch fails', async () => {
        const { impl } = fakeFetch((body, count) => count === 1 ? answer(body) : new Response('unauthorized', { status: 401 }));
        const many = Array.from({ length: 70 }, (_, index) => candidate(`tests/tab-${index}.spec.ts`));
        await assert.rejects(scorer(impl).score(source(), many), DecisionsError);
        assert.equal(await getDecisionsCacheEntryCount(cacheDir), 64);
    });

    it('empty candidate list makes no request', async () => {
        const { impl, calls } = fakeFetch(body => answer(body));
        const result = await scorer(impl).score(source(), []);
        assert.equal(result.scores.size, 0);
        assert.equal(calls.length, 0);
    });

    it('requires credentials through the shared typed provider failure', () => {
        assert.throws(() => scorer(fetch, { apiKey: '' }), ModelScorerError);
        assert.ok(new JevError('failure') instanceof ModelScorerError);
        assert.throws(() => createModelScorer('decisions', { apiKey: '', cacheDir, model: DECISIONS_MODEL }), DecisionsError);
    });
});

describe('shared evidence and credentials', () => {
    it('honors diff-only disclosure even when no matching hunks exist', () => {
        const input = buildDecisionsInput({ ...source(), diffOnly: true });
        assert.doesNotMatch(input, /source_code|chooseTab\(index|license omitted/);
        assert.match(input, /src\/tabs.ts/);
    });
    it('bounds source, exports, diff, and titles without transmitting test bodies', () => {
        const large = source();
        large.text = 'x'.repeat(20_000);
        large.profile.exports = Array.from({ length: 30 }, (_, index) => `symbol${index}`);
        const input = buildDecisionsInput(large);
        assert.ok(input.length < 6500);
        assert.match(input, /symbol19/);
        assert.doesNotMatch(input, /symbol20/);
        large.profile.diffExcerpt = 'y'.repeat(20_000);
        const diffInput = buildDecisionsInput(large);
        assert.ok(diffInput.length < 8500);
        assert.doesNotMatch(diffInput, /source_code/);
    });
    it('resolves canonical environment keys before explicit aliases, treating blanks as unset', () => {
        assert.equal(getOpenAIKey({ OPENAI_API_KEY: 'canonical', OPEN_AI: 'alias' }), 'canonical');
        assert.equal(getOpenAIKey({ OPENAI_API_KEY: ' ', OPEN_AI: 'alias' }), 'alias');
        assert.equal(getOpenAIKey({}), undefined);
        assert.equal(getJevKey({ TYPESAFE_API_KEY: 'canonical', JEF: 'alias' }), 'canonical');
        assert.equal(getJevKey({ TYPESAFE_API_KEY: '', JEF: 'alias' }), 'alias');
    });
});
