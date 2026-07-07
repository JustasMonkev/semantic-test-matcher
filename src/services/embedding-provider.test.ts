import test from 'node:test';
import assert from 'node:assert/strict';
import { requestOllamaJson } from './embedding-provider.ts';

type FetchStub = (calls: number) => Response | Promise<Response>;

function withStubbedFetch(stub: FetchStub): { calls: () => number; restore: () => void } {
    const original = globalThis.fetch;
    let count = 0;
    globalThis.fetch = (async () => {
        count += 1;
        return stub(count);
    }) as typeof fetch;
    return {
        calls: () => count,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

function jsonResponse(body: object, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

test('retries transient 5xx errors and succeeds', async () => {
    const stub = withStubbedFetch((calls) =>
        calls < 3 ? new Response('busy', { status: 503 }) : jsonResponse({ embedding: [1, 2] })
    );
    try {
        const payload = await requestOllamaJson('http://127.0.0.1:11434', '/api/embeddings', {}, 1000);
        assert.deepEqual(payload.embedding, [1, 2]);
        assert.equal(stub.calls(), 3);
    } finally {
        stub.restore();
    }
});

test('does not retry permanent 4xx errors', async () => {
    const stub = withStubbedFetch(() => new Response('no such model', { status: 404 }));
    try {
        await assert.rejects(
            requestOllamaJson('http://127.0.0.1:11434', '/api/embeddings', {}, 1000),
            /Ollama error 404/
        );
        assert.equal(stub.calls(), 1);
    } finally {
        stub.restore();
    }
});

test('gives up after exhausting retries', async () => {
    const stub = withStubbedFetch(() => new Response('down', { status: 500 }));
    try {
        await assert.rejects(
            requestOllamaJson('http://127.0.0.1:11434', '/api/embeddings', {}, 1000),
            /Ollama error 500/
        );
        assert.equal(stub.calls(), 3);
    } finally {
        stub.restore();
    }
});

test('retries network-level failures', async () => {
    const stub = withStubbedFetch((calls) => {
        if (calls === 1) {
            throw new TypeError('fetch failed');
        }
        return jsonResponse({ embedding: [3] });
    });
    try {
        const payload = await requestOllamaJson('http://127.0.0.1:11434', '/api/embeddings', {}, 1000);
        assert.deepEqual(payload.embedding, [3]);
        assert.equal(stub.calls(), 2);
    } finally {
        stub.restore();
    }
});
