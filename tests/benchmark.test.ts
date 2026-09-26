import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerBenchmarkCommand } from '../src/commands/benchmark.ts';

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
});
