import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDocumentProfile } from '../src/services/document-profile.ts';
import {
    buildJevState,
    estimateTokens,
    getJevCacheEntryCount,
    getJevCacheFile,
    JEV_ENDPOINT,
    JevError,
    JevScorer,
    type JevCandidate,
    type JevSource,
} from '../src/services/jev.ts';

const CWD = '/workspace';

const TABS_SOURCE = `/**
 * Copyright header that should not reach the model.
 */
export function selectTab(index: number) {
    return tabs[index];
}
`;

const TABS_DIFF = `diff --git a/src/tabs.ts b/src/tabs.ts
--- a/src/tabs.ts
+++ b/src/tabs.ts
@@ -5 +5 @@
-    return index && tabs[index];
+    return tabs[index];
diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-export const other = 1;
+export const other = 2;
`;

type JevRequestBody = {
    model: string;
    state: { changed_file: Record<string, unknown> };
    questions: Record<string, { type: string; instructions: { test_file: { path: string; test_titles: string[] }; question: string } }>;
};

function makeSource(diff?: string): JevSource {
    return { profile: buildDocumentProfile(`${CWD}/src/tabs.ts`, TABS_SOURCE, CWD, diff), text: TABS_SOURCE };
}

function makeCandidate(file: string, text: string): JevCandidate {
    return { file, profile: buildDocumentProfile(`${CWD}/${file}`, text, CWD) };
}

const TABS_TEST = makeCandidate(
    'tests/tabs.spec.ts',
    "test.describe('tabs', () => { test('selects a tab by index', async () => {}); test('selects the first tab', async () => {}); });"
);
const CONSOLE_TEST = makeCandidate('tests/console.spec.ts', "test('lists console messages', async () => {});");
const NETWORK_TEST = makeCandidate('tests/network.spec.ts', "test('lists network requests', async () => {});");

function answer(body: JevRequestBody, noulFor: (testPath: string) => number): Response {
    return Response.json({
        model: 'jev-1.13.0',
        answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [
            key,
            { type: 'noul', noul: noulFor(question.instructions.test_file.path) },
        ])),
        usage: { input_tokens: 100, output_tokens: 1 },
    });
}

function fakeFetch(handler: (body: JevRequestBody, call: number) => Response) {
    const calls: Array<{ url: string; init: RequestInit; body: JevRequestBody }> = [];
    const impl: typeof fetch = async (url, init) => {
        // SAFETY: JevScorer serializes this request; its state and questions are asserted below.
        const body = JSON.parse(String(init?.body)) as JevRequestBody;
        calls.push({ url: String(url), init: init ?? {}, body });
        return handler(body, calls.length - 1);
    };
    return { impl, calls };
}

const byTabs = (testPath: string) => (testPath.includes('tabs') ? 0.9 : 0.1);

describe('buildJevState', () => {
    it('sends only the profiled file\'s diff hunks when a diff is available', () => {
        const state = buildJevState(makeSource(TABS_DIFF));
        assert.equal(state.changed_file.path, 'src/tabs.ts');
        assert.match(String(state.changed_file.diff), /\+    return tabs\[index\];/);
        assert.doesNotMatch(String(state.changed_file.diff), /other/);
        assert.equal(state.changed_file.source_code, undefined);
    });

    it('sends a source excerpt without the leading license block when there is no diff', () => {
        const state = buildJevState(makeSource());
        assert.equal(state.changed_file.diff, undefined);
        assert.match(String(state.changed_file.source_code), /^export function selectTab/);
    });
});

describe('JevScorer', () => {
    let cacheDir: string;

    beforeEach(async () => {
        cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-jev-'));
    });

    function makeScorer(impl: typeof fetch, options: { skipCache?: boolean; model?: string } = {}): JevScorer {
        return new JevScorer({ apiKey: 'test-key', model: 'jev-1.13.0', cacheDir, fetch: impl, retryBaseMs: 1, ...options });
    }

    it('asks one Noul per candidate in a single request and maps answers back to files', async () => {
        const { impl, calls } = fakeFetch((body) => answer(body, byTabs));
        const result = await makeScorer(impl).score(makeSource(TABS_DIFF), [TABS_TEST, CONSOLE_TEST]);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, JEV_ENDPOINT);
        assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer test-key');
        assert.equal(calls[0].body.model, 'jev-1.13.0');
        const questions = Object.values(calls[0].body.questions);
        assert.deepEqual(questions.map((question) => question.type), ['noul', 'noul']);
        assert.deepEqual(questions[0].instructions.test_file, {
            path: 'tests/tabs.spec.ts',
            test_titles: ['tabs', 'selects a tab by index', 'selects the first tab'],
        });
        assert.match(questions[0].instructions.question, /re-run to check the code change/);
        assert.deepEqual([...result.scores], [['tests/tabs.spec.ts', 0.9], ['tests/console.spec.ts', 0.1]]);
        assert.deepEqual(
            { requests: result.requests, cacheHits: result.cacheHits, inputTokens: result.inputTokens, models: result.models },
            { requests: 1, cacheHits: 0, inputTokens: 100, models: ['jev-1.13.0'] }
        );
    });

    it('reuses cached answers across runs and only asks about new candidates', async () => {
        const first = fakeFetch((body) => answer(body, byTabs));
        const firstScorer = makeScorer(first.impl);
        await firstScorer.score(makeSource(TABS_DIFF), [TABS_TEST, CONSOLE_TEST]);
        await firstScorer.flush();
        assert.ok(await fs.stat(getJevCacheFile(cacheDir)));

        const second = fakeFetch((body) => answer(body, () => 0.5));
        const result = await makeScorer(second.impl).score(makeSource(TABS_DIFF), [TABS_TEST, CONSOLE_TEST, NETWORK_TEST]);

        assert.equal(second.calls.length, 1);
        assert.deepEqual(
            Object.values(second.calls[0].body.questions).map((question) => question.instructions.test_file.path),
            ['tests/network.spec.ts']
        );
        assert.equal(result.cacheHits, 2);
        assert.deepEqual([...result.scores.values()].sort(), [0.1, 0.5, 0.9]);
    });

    it('never caches answers from a moving model alias', async () => {
        const aliasAnswer = (body: JevRequestBody) => Response.json({
            model: 'jev-1.14.0',
            answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: 'noul', noul: 0.9 }])),
        });
        for (let run = 0; run < 2; run += 1) {
            const { impl, calls } = fakeFetch(aliasAnswer);
            const scorer = makeScorer(impl, { model: 'jev-latest' });
            const result = await scorer.score(makeSource(TABS_DIFF), [TABS_TEST]);
            await scorer.flush();

            assert.equal(calls.length, 1);
            assert.equal(result.cacheHits, 0);
            assert.deepEqual(result.models, ['jev-1.14.0']);
        }
        assert.equal(await getJevCacheEntryCount(cacheDir), 0);
    });

    it('treats a different change as a cache miss', async () => {
        const first = fakeFetch((body) => answer(body, byTabs));
        const firstScorer = makeScorer(first.impl);
        await firstScorer.score(makeSource(TABS_DIFF), [TABS_TEST]);
        await firstScorer.flush();

        const second = fakeFetch((body) => answer(body, byTabs));
        await makeScorer(second.impl).score(makeSource(), [TABS_TEST]);
        assert.equal(second.calls.length, 1);
    });

    it('splits large candidate lists across requests', async () => {
        const { impl, calls } = fakeFetch((body) => answer(body, () => 0.3));
        const candidates = Array.from({ length: 600 }, (_, index) => ({
            file: `tests/generated-${index}.spec.ts`,
            profile: TABS_TEST.profile,
        }));
        const result = await makeScorer(impl, { skipCache: true }).score(makeSource(TABS_DIFF), candidates);

        assert.deepEqual(calls.map((call) => Object.keys(call.body.questions).length).sort((a, b) => a - b), [100, 250, 250]);
        assert.equal(result.scores.size, 600);
        assert.equal(result.requests, 3);
    });

    it('sizes batches by estimated tokens, so non-ASCII test titles split sooner', async () => {
        assert.equal(estimateTokens('abcdef'), 2);
        assert.equal(estimateTokens('日本'), 6);
        const title = '日本語のテスト'.repeat(20);
        const text = Array.from({ length: 40 }, (_, index) => `test('${title} ${index}', () => {});`).join('\n');
        const candidates = Array.from({ length: 10 }, (_, index) => makeCandidate(`tests/cjk-${index}.spec.ts`, text));
        const { impl, calls } = fakeFetch((body) => answer(body, () => 0.3));
        const result = await makeScorer(impl, { skipCache: true }).score(makeSource(TABS_DIFF), candidates);

        assert.equal(result.scores.size, 10);
        assert.ok(calls.length > 1);
        for (const call of calls) {
            assert.ok(estimateTokens(String(call.init.body)) < 64_000);
        }
    });

    it('reports every version that answered the batches of one change', async () => {
        const { impl } = fakeFetch((body, call) => Response.json({
            model: call % 2 ? 'jev-1.14.0' : 'jev-1.15.0',
            answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: 'noul', noul: 0.3 }])),
        }));
        const candidates = Array.from({ length: 300 }, (_, index) => ({
            file: `tests/generated-${index}.spec.ts`,
            profile: TABS_TEST.profile,
        }));
        const result = await makeScorer(impl, { model: 'jev-latest' }).score(makeSource(TABS_DIFF), candidates);

        assert.deepEqual(result.models, ['jev-1.14.0', 'jev-1.15.0']);
    });

    it('reports every model version whose answers were used', async () => {
        const first = fakeFetch((body) => answer(body, byTabs));
        const firstScorer = makeScorer(first.impl);
        assert.deepEqual((await firstScorer.score(makeSource(TABS_DIFF), [TABS_TEST])).models, ['jev-1.13.0']);
        await firstScorer.flush();

        const cached = await makeScorer(fakeFetch((body) => answer(body, byTabs)).impl).score(makeSource(TABS_DIFF), [TABS_TEST]);
        assert.deepEqual({ requests: cached.requests, models: cached.models }, { requests: 0, models: ['jev-1.13.0'] });
    });

    it('retries rate limits and overloads before succeeding', async () => {
        const { impl, calls } = fakeFetch((body, call) => (
            call === 0 ? new Response('slow down', { status: 429 })
                : call === 1 ? new Response('overloaded', { status: 529 })
                    : answer(body, byTabs)
        ));
        const result = await makeScorer(impl).score(makeSource(TABS_DIFF), [TABS_TEST]);

        assert.equal(calls.length, 3);
        assert.equal(result.requests, 3);
        assert.equal(result.scores.get('tests/tabs.spec.ts'), 0.9);
    });

    it('retries network errors and unreadable response bodies', async () => {
        const { impl, calls } = fakeFetch((body, call) => {
            if (call === 0) {
                throw new TypeError('fetch failed');
            }
            return call === 1 ? new Response('not json', { status: 200 }) : answer(body, byTabs);
        });
        const result = await makeScorer(impl).score(makeSource(TABS_DIFF), [TABS_TEST]);

        assert.equal(calls.length, 3);
        assert.equal(result.scores.get('tests/tabs.spec.ts'), 0.9);
    });

    it('caps a long retry-after', async (t) => {
        const delays: number[] = [];
        const realSetTimeout = globalThis.setTimeout;
        t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
            delays.push(ms);
            return realSetTimeout(callback, 0);
        });
        const { impl, calls } = fakeFetch((body, call) => (
            call === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } })
                : answer(body, byTabs)
        ));
        await makeScorer(impl, { skipCache: true }).score(makeSource(TABS_DIFF), [TABS_TEST]);

        assert.equal(calls.length, 2);
        assert.deepEqual(delays, [30_000]);
    });

    it('waits until an HTTP-date retry-after', async (t) => {
        const delays: number[] = [];
        const realSetTimeout = globalThis.setTimeout;
        t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
            delays.push(ms);
            return realSetTimeout(callback, 0);
        });
        const retryAt = new Date(Date.now() + 20_000).toUTCString();
        const { impl } = fakeFetch((body, call) => (
            call === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': retryAt } })
                : answer(body, byTabs)
        ));
        await makeScorer(impl, { skipCache: true }).score(makeSource(TABS_DIFF), [TABS_TEST]);

        // HTTP dates have one-second precision.
        assert.ok(delays[0] > 18_000 && delays[0] <= 20_000, String(delays));
    });

    it('stops sending batches after one fails and caches the answers already received', async () => {
        const { impl, calls } = fakeFetch((body, call) => (
            call === 0 ? new Response('bad request', { status: 400 }) : answer(body, () => 0.3)
        ));
        const candidates = Array.from({ length: 1250 }, (_, index) => ({
            file: `tests/generated-${index}.spec.ts`,
            profile: TABS_TEST.profile,
        }));
        await assert.rejects(makeScorer(impl).score(makeSource(TABS_DIFF), candidates), JevError);

        assert.equal(calls.length, 4);
        assert.equal(await getJevCacheEntryCount(cacheDir), 750);
    });

    it('fails fast with a key hint on authentication errors', async () => {
        const { impl, calls } = fakeFetch(() => new Response('{"detail":"invalid key"}', { status: 401 }));
        await assert.rejects(
            makeScorer(impl).score(makeSource(TABS_DIFF), [TABS_TEST]),
            (error: Error) => error instanceof JevError && /TYPESAFE_API_KEY/.test(error.message)
        );
        assert.equal(calls.length, 1);
    });

    it('gives up after repeated transient failures', async () => {
        const { impl, calls } = fakeFetch(() => new Response('unavailable', { status: 503 }));
        await assert.rejects(makeScorer(impl).score(makeSource(TABS_DIFF), [TABS_TEST]), JevError);
        assert.equal(calls.length, 5);
    });

    it('retries a successful response without answers or a model and fails as a JevError', async () => {
        const recovered = fakeFetch((body, call) => (
            call === 0 ? Response.json(null)
                : call === 1 ? Response.json({ answers: { t0: { type: 'noul', noul: 0.9 } } })
                    : answer(body, byTabs)
        ));
        const result = await makeScorer(recovered.impl).score(makeSource(TABS_DIFF), [TABS_TEST]);
        assert.equal(recovered.calls.length, 3);
        assert.equal(result.scores.get('tests/tabs.spec.ts'), 0.9);

        const { impl, calls } = fakeFetch(() => Response.json(null));
        await assert.rejects(
            makeScorer(impl).score(makeSource(TABS_DIFF), [TABS_TEST]),
            (error: Error) => error instanceof JevError && /response has no answers or model/.test(error.message)
        );
        assert.equal(calls.length, 5);
    });

    it('rejects responses that are missing an answer', async () => {
        const { impl } = fakeFetch(() => Response.json({ model: 'jev-1.13.0', answers: {} }));
        await assert.rejects(makeScorer(impl).score(makeSource(TABS_DIFF), [TABS_TEST]), /no answer for tests\/tabs\.spec\.ts/);
    });

    it('rejects answers that are not probabilities', async () => {
        for (const noul of [-0.1, 1.5]) {
            const { impl } = fakeFetch((body) => answer(body, () => noul));
            await assert.rejects(
                makeScorer(impl, { skipCache: true }).score(makeSource(TABS_DIFF), [TABS_TEST]),
                /no answer for tests\/tabs\.spec\.ts/
            );
        }
    });

    it('requires an API key', () => {
        assert.throws(() => new JevScorer({ apiKey: '', model: 'jev-1.13.0', cacheDir }), JevError);
    });
});
