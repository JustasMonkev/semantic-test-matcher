import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createEmbeddingProvider } from '../src/services/embedding-provider.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('OllamaEmbeddingProvider', () => {
    it('uses the current embed endpoint with native truncation', async () => {
        let request: { url: string; body: Record<string, unknown> } | undefined;
        globalThis.fetch = async (input, init) => {
            request = {
                url: String(input),
                body: JSON.parse(String(init?.body)) as Record<string, unknown>,
            };
            return new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), { status: 200 });
        };

        const provider = createEmbeddingProvider('ollama', {
            model: 'embeddinggemma',
            ollamaHost: 'http://127.0.0.1:11434',
        });
        const result = await provider.embed('long profile');

        assert.equal(request?.url, 'http://127.0.0.1:11434/api/embed');
        assert.deepEqual(request?.body, {
            model: 'embeddinggemma',
            input: 'long profile',
            truncate: true,
        });
        assert.deepEqual(result.vector, [1, 2, 3]);
        assert.equal(result.backend, 'ollama-embeddings');
    });

    it('surfaces embedding errors instead of mixing vector backends', async () => {
        globalThis.fetch = async () => new Response('model unavailable', { status: 500 });
        const provider = createEmbeddingProvider('ollama', {
            model: 'embeddinggemma',
            ollamaHost: 'http://127.0.0.1:11434',
        });

        await assert.rejects(provider.embed('profile'), /Ollama error 500: model unavailable/);
    });
});
