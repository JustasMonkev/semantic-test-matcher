import fs from 'node:fs/promises';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
    const started = performance.now();
    const request = JSON.parse(options.body);
    const response = await originalFetch(url, options);
    let responseBody;
    try {
        responseBody = await response.clone().json();
    } catch (error) {
        responseBody = { parseError: error.message };
    }
    await fs.appendFile(process.env.RBT_BENCH_AUDIT_PATH, `${JSON.stringify({
        url: String(url), model: request.model, questionCount: Object.keys(request.questions).length,
        payloadBytes: Buffer.byteLength(options.body), status: response.status,
        requestId: response.headers.get('x-request-id'), elapsedMs: performance.now() - started, response: responseBody,
    })}\n`);
    return response;
};
