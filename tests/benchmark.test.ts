import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerBenchmarkCommand } from '../src/commands/benchmark.ts';
import { getJevCacheEntryCount } from '../src/services/jev.ts';

describe('benchmark command', () => {
    let cwd: string;
    let savedKey: string | undefined;

    beforeEach(() => {
        cwd = process.cwd();
        savedKey = process.env.TYPESAFE_API_KEY;
        delete process.env.TYPESAFE_API_KEY;
    });

    afterEach(() => {
        process.chdir(cwd);
        if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
        else process.env.TYPESAFE_API_KEY = savedKey;
    });

    async function makeWorkspace(): Promise<void> {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-benchmark-'));
        await fs.mkdir(path.join(root, 'src'));
        await fs.mkdir(path.join(root, 'tests'));
        await fs.writeFile(path.join(root, 'src/price.ts'), 'export const price = total => total;');
        await fs.writeFile(path.join(root, 'tests/price.test.ts'), "import { price } from '../src/price'; test('price', () => price(1));");
        await fs.writeFile(path.join(root, 'cases.json'), JSON.stringify([
            { source: 'src/price.ts', expectedTop3: ['tests/price.test.ts'] },
        ]));
        process.chdir(root);
    }

    it('applies the same minimum score as match', async () => {
        await makeWorkspace();

        const output: string[] = [];
        const originalLog = console.log;
        console.log = (value?: unknown) => output.push(String(value));
        try {
            const program = new Command();
            registerBenchmarkCommand(program);
            await program.parseAsync([
                'benchmark', '--cases', 'cases.json', '--candidates', 'tests',
                '--ranker', 'heuristics', '--threshold', '1', '--json',
            ], { from: 'user' });
        } finally {
            console.log = originalLog;
        }

        const result = JSON.parse(output[output.length - 1]) as {
            top1Cases: number;
            top3Cases: number;
            top3Rate: number;
            threshold: number;
            minScore: number;
        };
        assert.deepEqual(
            {
                top1Cases: result.top1Cases,
                top3Cases: result.top3Cases,
                top3Rate: result.top3Rate,
                threshold: result.threshold,
                minScore: result.minScore,
            },
            { top1Cases: 0, top3Cases: 1, top3Rate: 0, threshold: 1, minScore: 1 }
        );
    });

    it('fails instead of falling back when the jev ranker has no API key', async () => {
        await makeWorkspace();
        const program = new Command();
        registerBenchmarkCommand(program);

        await assert.rejects(
            program.parseAsync(['benchmark', '--cases', 'cases.json', '--candidates', 'tests', '--json'], { from: 'user' }),
            /TYPESAFE_API_KEY is required/
        );
    });

    it('keeps Jev answers already received when a later case fails', async (t) => {
        await makeWorkspace();
        process.env.TYPESAFE_API_KEY = 'test-key';
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
            // SAFETY: JevScorer always sends a JSON body with a questions map.
            const { questions } = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
            return Response.json({
                model: 'jev-1.13.0',
                answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.9 }])),
            });
        });
        await fs.writeFile('cases.json', JSON.stringify([
            { source: 'src/price.ts', expectedTop1: 'tests/price.test.ts' },
            { source: 'src/missing.ts' },
        ]));
        const program = new Command();
        registerBenchmarkCommand(program);

        await assert.rejects(
            program.parseAsync(['benchmark', '--cases', 'cases.json', '--candidates', 'tests', '--json'], { from: 'user' }),
            /Benchmark source not found: src\/missing\.ts/
        );
        assert.equal(await getJevCacheEntryCount('.rbt/cache'), 1);
    });

    it('scores a deleted source from its diff and rejects one without a diff', async () => {
        await makeWorkspace();
        await fs.writeFile('tests/reconcile.test.ts', "test('reconciles the ledger balance', () => {});");
        const diffText = [
            'diff --git a/src/gone.ts b/src/gone.ts',
            'deleted file mode 100644',
            '--- a/src/gone.ts',
            '+++ /dev/null',
            '@@ -1,1 +0,0 @@',
            '-export const reconcileLedgerBalance = entries => entries.length;',
        ].join('\n');
        const runBenchmark = async () => {
            const program = new Command();
            registerBenchmarkCommand(program);
            await program.parseAsync([
                'benchmark', '--cases', 'cases.json', '--candidates', 'tests', '--ranker', 'heuristics', '--json',
            ], { from: 'user' });
        };

        await fs.writeFile('cases.json', JSON.stringify([
            { source: 'src/gone.ts', diffText, expectedTop1: 'tests/reconcile.test.ts' },
        ]));
        const output: string[] = [];
        const originalLog = console.log;
        console.log = (value?: unknown) => output.push(String(value));
        try {
            await runBenchmark();
        } finally {
            console.log = originalLog;
        }
        // SAFETY: --json makes the benchmark's last log line its serialized summary.
        assert.equal((JSON.parse(output[output.length - 1]) as { top1Rate: number }).top1Rate, 1);

        for (const missing of [{}, { diffText: '' }, { diffText: diffText.replace(/src\/gone\.ts/g, 'src/other.ts') }]) {
            await fs.writeFile('cases.json', JSON.stringify([{ source: 'src/gone.ts', ...missing }]));
            await assert.rejects(runBenchmark(), {
                message: 'Benchmark source not found: src/gone.ts (add a diffText that deletes it)',
            });
        }
    });
});
