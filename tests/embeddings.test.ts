import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmbedding, EmbeddingSession } from '../src/services/embeddings.ts';
import { getCacheFile, loadCache } from '../src/services/cache.ts';

// The hf-stub test mode swaps the Hugging Face pipeline for the deterministic
// local vectorizer so these tests never download a model.
describe('EmbeddingSession (hf-stub)', () => {
    let savedTestMode: string | undefined;
    let cacheDir: string;

    beforeEach(async () => {
        savedTestMode = process.env.RBT_EMBEDDING_TEST_MODE;
        process.env.RBT_EMBEDDING_TEST_MODE = 'hf-stub';
        cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-embed-'));
    });

    afterEach(() => {
        if (savedTestMode === undefined) {
            delete process.env.RBT_EMBEDDING_TEST_MODE;
        } else {
            process.env.RBT_EMBEDDING_TEST_MODE = savedTestMode;
        }
    });

    function makeSession(): EmbeddingSession {
        return new EmbeddingSession({
            provider: 'hf',
            model: 'stub-model',
            cacheDir,
            ollamaHost: 'http://127.0.0.1:11434',
        });
    }

    it('embeds text and reports a miss on first use', async () => {
        const session = makeSession();
        const result = await session.embed('checkout pricing logic');
        assert.equal(result.cacheHit, false);
        assert.equal(result.backend, 'hf');
        assert.ok(result.vector.length > 0);
    });

    it('serves repeated texts from memory within one session', async () => {
        const session = makeSession();
        const first = await session.embed('coupon validation');
        const second = await session.embed('coupon validation');
        assert.equal(first.cacheHit, false);
        assert.equal(second.cacheHit, true);
        assert.deepEqual(second.vector, first.vector);
    });

    it('persists embeddings on flush and hits the disk cache in a new session', async () => {
        const first = makeSession();
        const original = await first.embed('discount and tax edge cases');
        await first.flush();

        const second = makeSession();
        const cached = await second.embed('discount and tax edge cases');
        assert.equal(cached.cacheHit, true);
        assert.deepEqual(cached.vector, original.vector);
    });

    it('writes all buffered embeddings in a single flush', async () => {
        const session = makeSession();
        await session.embed('one');
        await session.embed('two');
        await session.embed('three');

        const cacheFile = getCacheFile(cacheDir);
        await assert.rejects(fs.stat(cacheFile), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

        await session.flush();
        const cache = await loadCache(cacheFile);
        assert.equal(Object.keys(cache).length, 3);
    });

    it('does not touch the cache when skipCache is set', async () => {
        const session = new EmbeddingSession({
            provider: 'hf',
            model: 'stub-model',
            cacheDir,
            ollamaHost: 'http://127.0.0.1:11434',
            skipCache: true,
        });
        await session.embed('uncached text');
        await session.flush();
        await assert.rejects(
            fs.stat(getCacheFile(cacheDir)),
            (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
        );
    });

    it('rejects an ollama session without a model', () => {
        assert.throws(
            () => new EmbeddingSession({ provider: 'ollama', model: '', cacheDir, ollamaHost: 'http://127.0.0.1:11434' }),
            /Ollama model is required/
        );
    });

    it('createEmbedding embeds and persists in one call', async () => {
        const result = await createEmbedding({
            text: 'standalone embedding',
            provider: 'hf',
            model: 'stub-model',
            cacheDir,
            ollamaHost: 'http://127.0.0.1:11434',
        });
        assert.equal(result.cacheHit, false);

        const cache = await loadCache(getCacheFile(cacheDir));
        assert.equal(Object.keys(cache).length, 1);
    });
});
