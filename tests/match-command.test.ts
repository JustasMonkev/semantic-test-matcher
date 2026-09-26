import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerMatchCommand } from '../src/commands/match.ts';

interface MatchOutput {
    ranker: string;
    rankerFallback?: string;
    model?: string;
    jev?: { requests: number; cacheHits: number };
    results: Array<{ file: string; score: number; structuralScore: number; jevScore?: number }>;
}

describe('match command rankers', () => {
    let cwd: string;
    let savedKey: string | undefined;
    const originalFetch = globalThis.fetch;

    beforeEach(async () => {
        cwd = process.cwd();
        savedKey = process.env.TYPESAFE_API_KEY;
        delete process.env.TYPESAFE_API_KEY;

        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-match-'));
        await fs.mkdir(path.join(root, 'src'));
        await fs.mkdir(path.join(root, 'tests'));
        await fs.writeFile(path.join(root, 'src/price.ts'), 'export function applyDiscount(total: number) { return total * 0.9; }');
        await fs.writeFile(
            path.join(root, 'tests/price.test.ts'),
            "import { applyDiscount } from '../src/price'; test('applies the discount', () => applyDiscount(10));"
        );
        await fs.writeFile(path.join(root, 'tests/socket.test.ts'), "test('reconnects after a timeout', () => {});");
        process.chdir(root);
    });

    afterEach(() => {
        process.chdir(cwd);
        globalThis.fetch = originalFetch;
        if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
        else process.env.TYPESAFE_API_KEY = savedKey;
    });

    async function runMatch(...args: string[]): Promise<{ output: MatchOutput; warnings: string[] }> {
        const lines: string[] = [];
        const warnings: string[] = [];
        const originalLog = console.log;
        const originalWarn = console.warn;
        console.log = (value?: unknown) => lines.push(String(value));
        console.warn = (value?: unknown) => warnings.push(String(value));
        try {
            const program = new Command();
            registerMatchCommand(program);
            await program.parseAsync(
                ['match', 'src/price.ts', '--candidates', 'tests', '--cache-dir', '.cache', '--json', ...args],
                { from: 'user' }
            );
        } finally {
            console.log = originalLog;
            console.warn = originalWarn;
        }
        return { output: JSON.parse(lines[lines.length - 1]) as MatchOutput, warnings };
    }

    it('uses Jev by default and falls back to heuristics, saying so, without an API key', async () => {
        const { output, warnings } = await runMatch();

        assert.equal(output.ranker, 'heuristics');
        assert.match(output.rankerFallback ?? '', /TYPESAFE_API_KEY/);
        assert.equal(output.results[0].file, 'tests/price.test.ts');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /jev ranker unavailable/);
    });

    it('blends Jev scores into the ranking when the API answers', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        let requests = 0;
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            requests += 1;
            const body = JSON.parse(String(init?.body)) as {
                questions: Record<string, { instructions: { test_file: { path: string } } }>;
            };
            return Response.json({
                model: 'jev-1.13.0',
                answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [
                    key,
                    { type: 'noul', noul: question.instructions.test_file.path.includes('price') ? 0.95 : 0.05 },
                ])),
                usage: { input_tokens: 42, output_tokens: 2 },
            });
        }) as typeof fetch;

        const { output, warnings } = await runMatch('--ranker', 'jev');

        assert.deepEqual(warnings, []);
        assert.equal(output.ranker, 'jev');
        assert.equal(output.rankerFallback, undefined);
        assert.equal(output.model, 'jev-1.13.0');
        assert.equal(requests, 1);
        assert.equal(output.results[0].file, 'tests/price.test.ts');
        assert.equal(output.results[0].jevScore, 0.95);
        for (const result of output.results) {
            assert.ok(Math.abs(result.score - ((result.jevScore! * 0.2) + (result.structuralScore * 0.8))) < 1e-12);
        }

        // A repeat run is answered from the cache without calling the API.
        const repeat = await runMatch('--ranker', 'jev');
        assert.equal(requests, 1);
        assert.deepEqual(repeat.output.jev, { requests: 0, cacheHits: 2, inputTokens: 0 });
    });

    it('ranks with heuristics only when asked, without calling the API', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        globalThis.fetch = (async () => {
            throw new Error('heuristics ranking must not call the API');
        }) as typeof fetch;
        const { output, warnings } = await runMatch('--ranker', 'heuristics');

        assert.deepEqual(warnings, []);

        assert.equal(output.ranker, 'heuristics');
        assert.equal(output.results[0].file, 'tests/price.test.ts');
        assert.equal(output.results[0].score, output.results[0].structuralScore);
    });
});
