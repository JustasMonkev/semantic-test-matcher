import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerBenchmarkCommand } from '../src/commands/benchmark.ts';

interface BenchmarkSummary {
    cases: number;
    threshold: number;
    minScore: number;
    top1Cases: number;
    top1Rate: number;
    top3Cases: number;
    top3Rate: number;
    top10IncludeCases: number;
    top10IncludeRate: number;
    misses: Array<{
        source: string;
        failedChecks: string[];
        observedTop10: string[];
        observedRanks: Record<string, number | null>;
    }>;
    candidateLimitReached: boolean;
    cacheHitCount: number;
}

async function makeBenchmarkWorkspace(): Promise<string> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-benchmark-')));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.writeFile(
        path.join(root, 'src/price.ts'),
        'export function applyDiscount(order, coupon) { return order.total - coupon.amount; }',
        'utf8'
    );
    await fs.writeFile(
        path.join(root, 'tests/price.test.ts'),
        "import { applyDiscount } from '../src/price.ts';\ndescribe('price', () => { it('applies a coupon discount', () => applyDiscount(order, coupon)); });",
        'utf8'
    );
    await fs.writeFile(
        path.join(root, 'tests/socket.test.ts'),
        "import { reconnectSocket } from '../src/socket.ts';\ndescribe('socket', () => { it('reconnects after a heartbeat timeout', () => reconnectSocket(session)); });",
        'utf8'
    );
    return root;
}

async function runBenchmark(root: string, cases: unknown, extraArgs: string[] = []): Promise<string[]> {
    await fs.writeFile(
        path.join(root, 'cases.json'),
        typeof cases === 'string' ? cases : JSON.stringify(cases),
        'utf8'
    );
    process.chdir(root);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => output.push(String(value));
    try {
        const program = new Command();
        registerBenchmarkCommand(program);
        await program.parseAsync(
            ['benchmark', '--cases', 'cases.json', '--candidates', 'tests', '--model', 'stub', ...extraArgs],
            { from: 'user' }
        );
    } finally {
        console.log = originalLog;
    }
    return output;
}

function parseSummary(output: string[]): BenchmarkSummary {
    return JSON.parse(output[output.length - 1]) as BenchmarkSummary;
}

describe('benchmark command', () => {
    let cwd: string;
    let testMode: string | undefined;

    beforeEach(() => {
        cwd = process.cwd();
        testMode = process.env.RBT_EMBEDDING_TEST_MODE;
        process.env.RBT_EMBEDDING_TEST_MODE = 'stub';
    });

    afterEach(() => {
        process.chdir(cwd);
        if (testMode === undefined) delete process.env.RBT_EMBEDDING_TEST_MODE;
        else process.env.RBT_EMBEDDING_TEST_MODE = testMode;
    });

    it('counts a hit when the expected file ranks first', async () => {
        const root = await makeBenchmarkWorkspace();
        const summary = parseSummary(await runBenchmark(
            root,
            [{ source: 'src/price.ts', expectedTop1: 'tests/price.test.ts' }],
            ['--json']
        ));

        assert.equal(summary.cases, 1);
        assert.equal(summary.top1Cases, 1);
        assert.equal(summary.top1Rate, 1);
        assert.equal(summary.top3Cases, 1, 'expectedTop1 also seeds the top3 check');
        assert.equal(summary.top3Rate, 1);
        assert.deepEqual(summary.misses, []);
    });

    it('records a miss with observed ranks when the expectation fails', async () => {
        const root = await makeBenchmarkWorkspace();
        const summary = parseSummary(await runBenchmark(
            root,
            [{ source: 'src/price.ts', expectedTop1: 'tests/socket.test.ts' }],
            ['--json']
        ));

        assert.equal(summary.top1Rate, 0);
        assert.equal(summary.misses.length, 1);
        assert.deepEqual(summary.misses[0].failedChecks, ['top1']);
        assert.equal(summary.misses[0].source, 'src/price.ts');
        assert.equal(summary.misses[0].observedTop10[0], 'tests/price.test.ts');
        assert.equal(summary.misses[0].observedRanks['tests/socket.test.ts'], 2);
    });

    it('reports a null rank for an expected file that never appears', async () => {
        const root = await makeBenchmarkWorkspace();
        const summary = parseSummary(await runBenchmark(
            root,
            [{ source: 'src/price.ts', expectedTop1: 'tests/never-collected.test.ts' }],
            ['--json']
        ));

        assert.equal(summary.misses[0].observedRanks['tests/never-collected.test.ts'], null);
    });

    it('checks that every expectedTop10Includes entry is present', async () => {
        const root = await makeBenchmarkWorkspace();
        const both = parseSummary(await runBenchmark(
            root,
            [{ source: 'src/price.ts', expectedTop10Includes: ['tests/price.test.ts', 'tests/socket.test.ts'] }],
            ['--json']
        ));
        const missing = parseSummary(await runBenchmark(
            root,
            [{ source: 'src/price.ts', expectedTop10Includes: ['tests/price.test.ts', 'tests/absent.test.ts'] }],
            ['--json']
        ));

        assert.equal(both.top10IncludeCases, 1);
        assert.equal(both.top10IncludeRate, 1);
        assert.equal(missing.top10IncludeRate, 0);
        assert.deepEqual(missing.misses[0].failedChecks, ['top10Includes']);
    });

    it('never scores a case against its own source file', async () => {
        const root = await makeBenchmarkWorkspace();
        const summary = parseSummary(await runBenchmark(
            root,
            [{ source: 'tests/price.test.ts', expectedTop1: 'tests/socket.test.ts' }],
            ['--json']
        ));

        assert.ok(!summary.misses.some((miss) => miss.observedTop10.includes('tests/price.test.ts')));
    });

    it('raises the expected rank when a case carries a diff', async () => {
        const root = await makeBenchmarkWorkspace();
        const diffText = [
            '--- src/price.ts',
            '+++ src/price.ts',
            '@@ -1 +1 @@',
            '-return order.total;',
            '+return applyDiscount(order, coupon);',
            '',
        ].join('\n');
        const summary = parseSummary(await runBenchmark(
            root,
            [{ source: 'src/price.ts', expectedTop1: 'tests/price.test.ts', diffText }],
            ['--json', '--diff-root', '.']
        ));

        assert.equal(summary.top1Rate, 1);
    });

    it('reports zeroed metrics for an empty case list', async () => {
        const root = await makeBenchmarkWorkspace();
        const summary = parseSummary(await runBenchmark(root, [], ['--json']));

        assert.deepEqual(
            {
                cases: summary.cases,
                top1Cases: summary.top1Cases,
                top1Rate: summary.top1Rate,
                top3Cases: summary.top3Cases,
                top10IncludeCases: summary.top10IncludeCases,
                misses: summary.misses,
            },
            { cases: 0, top1Cases: 0, top1Rate: 0, top3Cases: 0, top10IncludeCases: 0, misses: [] }
        );
    });

    it('counts a case with no expectations but scores it against nothing', async () => {
        const root = await makeBenchmarkWorkspace();
        const summary = parseSummary(await runBenchmark(root, [{ source: 'src/price.ts' }], ['--json']));

        assert.equal(summary.cases, 1);
        assert.equal(summary.top1Cases, 0);
        assert.equal(summary.top3Cases, 0);
        assert.deepEqual(summary.misses, []);
    });

    it('prints a human-readable miss report without --json', async () => {
        const root = await makeBenchmarkWorkspace();
        const output = await runBenchmark(
            root,
            [{ source: 'src/price.ts', expectedTop1: 'tests/socket.test.ts' }]
        );
        const text = output.join('\n');

        assert.match(text, /^cases: 1$/m);
        assert.match(text, /^top1Rate: 0\.0000$/m);
        assert.match(text, /^misses: 1$/m);
        assert.match(text, /^- src\/price\.ts: top1$/m);
        assert.match(text, /observedTop10: tests\/price\.test\.ts/);
    });

    it('prints "misses: none" when every case passes', async () => {
        const root = await makeBenchmarkWorkspace();
        const output = await runBenchmark(
            root,
            [{ source: 'src/price.ts', expectedTop1: 'tests/price.test.ts' }]
        );

        assert.ok(output.includes('misses: none'));
    });

    it('names the file when the case JSON is malformed', async () => {
        const root = await makeBenchmarkWorkspace();

        await assert.rejects(
            runBenchmark(root, 'not json at all', ['--json']),
            /Failed to parse benchmark case file .*cases\.json/
        );
    });

    it('fails with a clear message when a case file is not an array', async () => {
        const root = await makeBenchmarkWorkspace();

        await assert.rejects(
            runBenchmark(root, { not: 'an array' }, ['--json']),
            /must contain a JSON array of cases/
        );
    });

    it('names the offending index when a case is missing its source', async () => {
        const root = await makeBenchmarkWorkspace();

        await assert.rejects(
            runBenchmark(root, [{ source: 'src/price.ts' }, { expectedTop1: 'tests/price.test.ts' }], ['--json']),
            /Benchmark case 1 in .*cases\.json must be an object with a "source" string/
        );
    });

    it('rejects a non-object case entry', async () => {
        const root = await makeBenchmarkWorkspace();

        await assert.rejects(
            runBenchmark(root, ['src/price.ts'], ['--json']),
            /must be an object with a "source" string/
        );
    });

    it('fails when a case source file does not exist', async () => {
        const root = await makeBenchmarkWorkspace();

        await assert.rejects(
            runBenchmark(root, [{ source: 'src/absent.ts', expectedTop1: 'tests/price.test.ts' }], ['--json']),
            /ENOENT/
        );
    });

    it('fails when the case file itself is missing', async () => {
        const root = await makeBenchmarkWorkspace();
        process.chdir(root);

        const program = new Command();
        registerBenchmarkCommand(program);
        await assert.rejects(
            program.parseAsync(
                ['benchmark', '--cases', 'absent.json', '--candidates', 'tests', '--model', 'stub', '--json'],
                { from: 'user' }
            ),
            /ENOENT/
        );
    });

    it('applies the same minimum score as match', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-benchmark-'));
        await fs.mkdir(path.join(root, 'src'));
        await fs.mkdir(path.join(root, 'tests'));
        await fs.writeFile(path.join(root, 'src/price.ts'), 'export const price = total => total;');
        await fs.writeFile(path.join(root, 'tests/price.test.ts'), "import { price } from '../src/price'; test('price', () => price(1));");
        await fs.writeFile(path.join(root, 'cases.json'), JSON.stringify([
            { source: 'src/price.ts', expectedTop3: ['tests/price.test.ts'] },
        ]));
        process.chdir(root);

        const output: string[] = [];
        const originalLog = console.log;
        console.log = (value?: unknown) => output.push(String(value));
        try {
            const program = new Command();
            registerBenchmarkCommand(program);
            await program.parseAsync([
                'benchmark', '--cases', 'cases.json', '--candidates', 'tests',
                '--model', 'stub', '--threshold', '1', '--json',
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
});
