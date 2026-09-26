import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerMatchCommand } from '../src/commands/match.ts';

interface MatchOutput {
    ranker: string;
    rankerFallback?: string;
    selectionPolicy?: string;
    selectionFallback?: string;
    selectionLimit?: number | null;
    eligibleCount?: number;
    selectionTruncated?: boolean;
    model?: string;
    jev?: { requests: number; cacheHits: number; models: string[] };
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

    const runMatch = (...args: string[]) => runMatchOn('src/price.ts', ...args);
    const execFileAsync = promisify(execFile);

    async function runCli(...args: string[]): Promise<{ lines: string[]; warnings: string[] }> {
        const lines: string[] = [];
        const warnings: string[] = [];
        const originalLog = console.log;
        const originalWarn = console.warn;
        console.log = (value?: unknown) => lines.push(String(value));
        console.warn = (value?: unknown) => warnings.push(String(value));
        try {
            const program = new Command();
            registerMatchCommand(program);
            await program.parseAsync(['match', '--candidates', 'tests', '--cache-dir', '.cache', ...args], { from: 'user' });
        } finally {
            console.log = originalLog;
            console.warn = originalWarn;
        }
        return { lines, warnings };
    }

    async function runMatchOn(file: string, ...args: string[]): Promise<{ output: MatchOutput; warnings: string[] }> {
        const { lines, warnings } = await runCli(file, '--json', ...args);
        // SAFETY: --json makes the command's last log line its serialized result.
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
        globalThis.fetch = async (_url, init) => {
            requests += 1;
            // SAFETY: the match command's JevScorer serializes the request with this questions map.
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
        };

        const { output, warnings } = await runMatch('--ranker', 'jev');

        assert.deepEqual(warnings, []);
        assert.equal(output.ranker, 'jev');
        assert.equal(output.rankerFallback, undefined);
        assert.equal(output.model, 'jev-1.13.0');
        assert.equal(requests, 1);
        assert.equal(output.results[0].file, 'tests/price.test.ts');
        assert.equal(output.results[0].jevScore, 0.95);
        for (const result of output.results) {
            assert.ok(Math.abs(result.score - ((result.jevScore! * 0.6) + (result.structuralScore * 0.4))) < 1e-12);
        }

        // A repeat run is answered from the cache without calling the API.
        const repeat = await runMatch('--ranker', 'jev');
        assert.equal(requests, 1);
        assert.deepEqual(repeat.output.jev, { requests: 0, cacheHits: 2, inputTokens: 0, models: ['jev-1.13.0'] });
    });

    it('lists every answering version when cached and fresh answers differ', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        let model = 'jev-1.13.0';
        globalThis.fetch = async (_url, init) => {
            // SAFETY: the match command's JevScorer serializes the request with this questions map.
            const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
            return Response.json({
                model,
                answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: 'noul', noul: 0.5 }])),
            });
        };
        await runMatch('--ranker', 'jev');
        await fs.writeFile('tests/extra.test.ts', "test('extra', () => {});");
        model = 'jev-1.13.1';

        const { output } = await runMatch('--ranker', 'jev');

        assert.equal(output.model, 'jev-1.13.0');
        assert.deepEqual(output.jev?.models, ['jev-1.13.0', 'jev-1.13.1']);
    });

    it('ranks with heuristics only when asked, without calling the API', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        globalThis.fetch = async () => {
            throw new Error('heuristics ranking must not call the API');
        };
        const { output, warnings } = await runMatch('--ranker', 'heuristics');

        assert.deepEqual(warnings, []);

        assert.equal(output.ranker, 'heuristics');
        assert.equal(output.results[0].file, 'tests/price.test.ts');
        assert.equal(output.results[0].score, output.results[0].structuralScore);
    });

    it('offers adaptive selection by default and preserves explicit legacy policies', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
            // SAFETY: this test supplies the match command's own serialized Jev request body.
            const body = JSON.parse(String(init?.body)) as {
                questions: Record<string, { instructions: { test_file: { path: string } } }>;
            };
            return Response.json({
                model: 'jev-1.13.0',
                answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [
                    key,
                    { type: 'noul', noul: question.instructions.test_file.path.includes('price') ? 0.95 : 0.1 },
                ])),
            });
        };

        const adaptive = await runMatch('--ranker', 'jev');
        const conservative = await runMatch('--ranker', 'jev', '--selection-policy', 'conservative');
        const targeted = await runMatch('--ranker', 'jev', '--selection-policy', 'targeted');

        assert.equal(adaptive.output.selectionPolicy, 'adaptive');
        assert.equal(adaptive.output.selectionLimit, null);
        assert.equal(adaptive.output.selectionTruncated, false);
        assert.equal(adaptive.output.eligibleCount, 1);
        assert.deepEqual(adaptive.output.results.map(x => x.file), ['tests/price.test.ts']);
        assert.equal(conservative.output.selectionPolicy, 'conservative');
        assert.equal(conservative.output.selectionLimit, 5);
        assert.equal(conservative.output.results.length, 2);
        const capped = await runMatch('--ranker', 'jev', '--selection-policy', 'conservative', '--top-k', '1');
        assert.equal(capped.output.selectionLimit, 1);
        assert.equal(capped.output.selectionTruncated, true);
        assert.equal(capped.output.eligibleCount, 2);
        assert.equal(targeted.output.selectionPolicy, 'targeted');
        assert.deepEqual(targeted.output.results.map(x => x.file), ['tests/price.test.ts']);
        assert.equal(targeted.output.selectionFallback, undefined);
    });

    it('matches a deleted file from its diff', async () => {
        await fs.writeFile('tests/ledger.test.ts', "test('reconciles the ledger balance', () => {});");
        await fs.writeFile('gone.diff', [
            'diff --git a/src/gone.ts b/src/gone.ts',
            'deleted file mode 100644',
            '--- a/src/gone.ts',
            '+++ /dev/null',
            '@@ -1,3 +0,0 @@',
            '-export function reconcileLedgerBalance(entries: number[]) {',
            '-    return entries.reduce((sum, entry) => sum + entry, 0);',
            '-}',
        ].join('\n'));

        const { output } = await runMatchOn('src/gone.ts', '--ranker', 'heuristics', '--diff-file', 'gone.diff');

        assert.equal(output.results[0].file, 'tests/ledger.test.ts');
        assert.ok(output.results[0].score > output.results[1].score);
    });

    it('matches the deletion of an empty file, which has no hunks', async () => {
        await fs.writeFile('empty.diff', [
            'diff --git a/src/removed.ts b/src/removed.ts',
            'deleted file mode 100644',
            'index e69de29..0000000',
            '',
        ].join('\n'));

        const { lines } = await runCli('--diff-file', 'empty.diff', '--diff-root', '.', '--ranker', 'heuristics', '--json');
        // SAFETY: --json makes the command's last log line its serialized result.
        assert.equal((JSON.parse(lines[lines.length - 1]) as { file: string }).file, path.join('src', 'removed.ts'));
    });

    it('matches a deleted file from a plain diff with a/ and /dev/null labels', async () => {
        await fs.writeFile('tests/ledger.test.ts', "test('reconciles the ledger balance', () => {});");
        await fs.writeFile('gone.diff', [
            '--- a/src/gone.ts',
            '+++ /dev/null',
            '@@ -1,3 +0,0 @@',
            '-export function reconcileLedgerBalance(entries: number[]) {',
            '-    return entries.reduce((sum, entry) => sum + entry, 0);',
            '-}',
        ].join('\n'));

        const { lines } = await runCli('--diff-file', 'gone.diff', '--diff-root', '.', '--ranker', 'heuristics', '--json');
        // SAFETY: --json makes the command's last log line its serialized result.
        const output = JSON.parse(lines[lines.length - 1]) as MatchOutput & { file: string };

        assert.equal(output.file, path.join('src', 'gone.ts'));
        assert.equal(output.results[0].file, 'tests/ledger.test.ts');
    });

    it('rejects a missing changed file without a diff and keeps other read errors', async () => {
        await assert.rejects(
            runMatchOn('src/gone.ts', '--ranker', 'heuristics'),
            { message: 'Changed file not found: src/gone.ts (pass a --diff-file that deletes it)' }
        );
        await fs.writeFile('empty.diff', '');
        await fs.writeFile('other.diff', [
            'diff --git a/src/price.ts b/src/price.ts',
            '--- a/src/price.ts',
            '+++ b/src/price.ts',
            '@@ -1 +1 @@',
            '-export const price = 1;',
            '+export const price = 2;',
            '',
        ].join('\n'));
        for (const diffFile of ['empty.diff', 'other.diff']) {
            await assert.rejects(
                runMatchOn('src/gone.ts', '--ranker', 'heuristics', '--diff-file', diffFile),
                { message: 'Changed file not found: src/gone.ts (pass a --diff-file that deletes it)' }
            );
        }
        await assert.rejects(runMatchOn('src', '--ranker', 'heuristics'), { code: 'EISDIR' });
    });

    describe('several changed files', () => {
        const priceDiff = [
            'diff --git a/src/price.ts b/src/price.ts',
            '--- a/src/price.ts',
            '+++ b/src/price.ts',
            '@@ -1 +1 @@',
            '-export function applyDiscount(total: number) { return total; }',
            '+export function applyDiscount(total: number) { return total * 0.9; }',
            'diff --git a/src/socket.ts b/src/socket.ts',
            '--- a/src/socket.ts',
            '+++ b/src/socket.ts',
            '@@ -1 +1 @@',
            '-export function reconnect() {}',
            '+export function reconnect(timeout: number) {}',
            'diff --git a/README.md b/README.md',
            '--- a/README.md',
            '+++ b/README.md',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '',
        ].join('\n');

        beforeEach(async () => {
            await fs.writeFile('src/socket.ts', 'export function reconnect(timeout: number) {}');
            await fs.writeFile('README.md', 'new');
            await fs.writeFile('change.diff', priceDiff);
        });

        it('reads the changed source files from --diff-file and merges their tests', async () => {
            const { lines } = await runCli('--diff-file', 'change.diff', '--diff-root', '.', '--ranker', 'heuristics', '--json');
            // SAFETY: --json makes the command's last log line its serialized result.
            const output = JSON.parse(lines[lines.length - 1]) as {
                files: string[];
                results: Array<{ file: string }>;
                changes: MatchOutput[];
            };

            assert.deepEqual(output.files, ['src/price.ts', 'src/socket.ts']);
            assert.equal(output.changes.length, 2);
            assert.deepEqual(
                output.results.map((result) => result.file).sort(),
                ['tests/price.test.ts', 'tests/socket.test.ts']
            );
        });

        it('keeps the best score for a test selected by several files', async () => {
            const { lines } = await runCli('src/price.ts', 'src/socket.ts', '--ranker', 'heuristics', '--json');
            // SAFETY: --json makes the command's last log line its serialized result.
            const output = JSON.parse(lines[lines.length - 1]) as {
                results: Array<{ file: string; score: number }>;
                changes: MatchOutput[];
            };

            for (const result of output.results) {
                const best = Math.max(...output.changes.flatMap((change) =>
                    change.results.filter((match) => match.file === result.file).map((match) => match.score)
                ));
                assert.equal(result.score, best);
            }
        });

        it('ranks every file with heuristics when Jev fails on a later file', async () => {
            process.env.TYPESAFE_API_KEY = 'test-key';
            let requests = 0;
            globalThis.fetch = async (_url, init) => {
                requests += 1;
                if (requests > 1) {
                    return new Response('bad request', { status: 400 });
                }
                // SAFETY: the match command's JevScorer serializes the request with this questions map.
                const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
                return Response.json({
                    model: 'jev-1.13.0',
                    answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: 'noul', noul: 0.9 }])),
                });
            };
            const { lines, warnings } = await runCli('src/price.ts', 'src/socket.ts', '--json');
            // SAFETY: --json makes the command's last log line its serialized result.
            const output = JSON.parse(lines[lines.length - 1]) as { results: MatchOutput['results']; changes: MatchOutput[] };

            assert.equal(requests, 2);
            assert.equal(warnings.length, 1);
            assert.deepEqual(output.changes.map((change) => change.ranker), ['heuristics', 'heuristics']);
            assert.ok(output.changes.every((change) => /HTTP 400/.test(change.rankerFallback ?? '')));
            assert.ok(output.results.every((result) => result.jevScore === undefined && result.score === result.structuralScore));
        });

        it('accepts a repository-root --diff-file path whose name starts with two dots', async () => {
            await fs.writeFile('..price.ts', 'export function applyDiscount(total: number) { return total * 0.9; }');
            await fs.writeFile('dots.diff', [
                '--- ..price.ts',
                '+++ ..price.ts',
                '@@ -1 +1 @@',
                '-export function applyDiscount(total: number) { return total; }',
                '+export function applyDiscount(total: number) { return total * 0.9; }',
                '',
            ].join('\n'));
            const { lines } = await runCli('--diff-file', 'dots.diff', '--diff-root', '.', '--ranker', 'heuristics', '--json');
            // SAFETY: --json makes the command's last log line its serialized result.
            assert.equal((JSON.parse(lines[lines.length - 1]) as { file: string }).file, '..price.ts');
        });

        it('rejects --diff-file paths outside the diff root', async () => {
            const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-outside-'));
            await fs.writeFile(path.join(outside, 'secret.ts'), 'export const secret = 1;');
            const escaping = path.relative(process.cwd(), path.join(outside, 'secret.ts'));
            await fs.symlink(outside, 'linked');
            for (const target of [escaping, path.join(outside, 'secret.ts'), 'linked/secret.ts']) {
                await fs.writeFile('escape.diff', [
                    `--- ${target}`,
                    `+++ ${target}`,
                    '@@ -1 +1 @@',
                    '-export const secret = 0;',
                    '+export const secret = 1;',
                    '',
                ].join('\n'));
                await assert.rejects(
                    runCli('--diff-file', 'escape.diff', '--diff-root', '.', '--ranker', 'heuristics', '--json'),
                    /outside its diff root/,
                    target
                );
            }
            await fs.rm(outside, { recursive: true, force: true });
        });

        it('warns once when Jev is unavailable for several files', async () => {
            const { warnings } = await runCli('src/price.ts', 'src/socket.ts', '--json');

            assert.equal(warnings.length, 1);
        });

        it('prints only selected paths with --paths-only', async () => {
            const { lines } = await runCli('src/price.ts', 'src/socket.ts', '--ranker', 'heuristics', '--paths-only');

            assert.deepEqual([...lines].sort(), ['tests/price.test.ts', 'tests/socket.test.ts']);
        });

        it('suggests the detected test command and hides previews unless verbose', async () => {
            await fs.writeFile('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
            const { lines } = await runCli('src/price.ts', 'src/socket.ts', '--ranker', 'heuristics');
            const run = lines.find((line) => line.startsWith('\nRun: '));

            assert.ok(run, lines.join('\n'));
            assert.match(run, /^\nRun: npx vitest run tests\/\S+\.test\.ts tests\/\S+\.test\.ts$/);
            assert.ok(!lines.some((line) => line.startsWith('  test file about')), lines.join('\n'));
        });

        it('explains a fallback selection in text output', async () => {
            const { lines } = await runCli('src/price.ts', '--ranker', 'heuristics');

            assert.ok(lines.some((line) => /^ {2}Why: /.test(line)), lines.join('\n'));
        });

        it('never selects another changed source module, but keeps changed tests', async () => {
            await fs.appendFile('tests/price.test.ts', '\n// updated discount assertion');
            const explicit = await runCli('src/price.ts', 'src/socket.ts', 'tests/price.test.ts', '--candidates', '.', '--ranker', 'heuristics', '--paths-only');
            const fromDiff = await runCli('--diff-file', 'change.diff', '--diff-root', '.', '--candidates', '.', '--ranker', 'heuristics', '--paths-only');

            for (const { lines } of [explicit, fromDiff]) {
                assert.ok(lines.includes('tests/price.test.ts'), lines.join('\n'));
                assert.ok(!lines.includes('src/price.ts') && !lines.includes('src/socket.ts'), lines.join('\n'));
            }
        });

        it('lists pure renames and custom-prefix paths from --diff-file', async () => {
            await fs.writeFile('rename.diff', [
                'diff --git a/src/sockets.ts b/src/socket.ts',
                'similarity index 100%',
                'rename from src/sockets.ts',
                'rename to src/socket.ts',
                'diff --git old/src/price.ts new/src/price.ts',
                '--- old/src/price.ts',
                '+++ new/src/price.ts',
                '@@ -1 +1 @@',
                '-export function applyDiscount(total: number) { return total; }',
                '+export function applyDiscount(total: number) { return total * 0.9; }',
                '',
            ].join('\n'));
            const { lines } = await runCli('--diff-file', 'rename.diff', '--diff-root', '.', '--ranker', 'heuristics', '--json');
            // SAFETY: --json makes the command's last log line its serialized result.
            const output = JSON.parse(lines[lines.length - 1]) as { files: string[] };

            assert.deepEqual(output.files, ['src/socket.ts', 'src/price.ts']);
        });

        it('caps the merged selection at --top-k', async () => {
            const { lines } = await runCli('src/price.ts', 'src/socket.ts', '--ranker', 'heuristics', '--top-k', '1', '--paths-only');

            assert.equal(lines.length, 1);
        });

        it('rejects runs without a changed source file', async () => {
            await assert.rejects(runCli('--ranker', 'heuristics'), /not a git repository/);
            await fs.writeFile('docs.diff', priceDiff.slice(priceDiff.indexOf('diff --git a/README.md')));
            await assert.rejects(
                runCli('--diff-file', 'docs.diff', '--diff-root', '.', '--ranker', 'heuristics'),
                { message: 'The --diff-file changes no source files' }
            );
        });
    });

    describe('automatic local changes', () => {
        beforeEach(async () => {
            await execFileAsync('git', ['init']);
            await execFileAsync('git', ['add', '.']);
            await execFileAsync('git', ['-c', 'user.name=RBT test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial']);
        });

        it('detects changes without file arguments and keeps JSON and paths-only non-interactive', async () => {
            await fs.appendFile('src/price.ts', '\nexport const discountRate = 0.2;');
            const { lines } = await runCli('--ranker', 'heuristics', '--json');
            // SAFETY: the command's --json output uses the MatchOutput result schema.
            const output = JSON.parse(lines[0]) as MatchOutput;
            assert.equal(output.results[0].file, 'tests/price.test.ts');
            const paths = await runCli('--ranker', 'heuristics', '--paths-only');
            assert.deepEqual(paths.lines, output.results.map(match => match.file));
        });

        it('never selects changed source modules, even from a broad candidate root', async () => {
            await fs.appendFile('src/price.ts', '\nexport const discountRate = 0.2;');
            const { lines } = await runCli('--candidates', '.', '--ranker', 'heuristics', '--paths-only');

            assert.ok(lines.includes('tests/price.test.ts'), lines.join('\n'));
            assert.ok(!lines.includes('src/price.ts'), lines.join('\n'));
        });

        it('selects an edited test itself', async () => {
            await fs.appendFile('tests/price.test.ts', '\n// updated discount assertion');
            const { lines } = await runCli('--ranker', 'heuristics', '--paths-only');
            assert.ok(lines.includes('tests/price.test.ts'));
        });

        it('skips an untracked symlink that resolves outside the repository', async () => {
            const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-outside-'));
            await fs.writeFile(path.join(outside, 'secret.ts'), 'export const secret = 1;');
            await fs.symlink(path.join(outside, 'secret.ts'), 'src/linked.ts');
            await fs.appendFile('src/price.ts', '\nexport const discountRate = 0.2;');
            const { lines, warnings } = await runCli('--ranker', 'heuristics', '--json');
            // SAFETY: --json makes the command's last log line its serialized result.
            const output = JSON.parse(lines[lines.length - 1]) as { file: string };

            assert.equal(output.file, path.join('src', 'price.ts'));
            assert.deepEqual(warnings, [`Warning: skipping ${path.join('src', 'linked.ts')}, which resolves outside the repository`]);
            await fs.rm(outside, { recursive: true, force: true });
        });

        it('only offers test-like files to run from a broad candidate root', async () => {
            await fs.writeFile('src/tax.ts', 'export function applyTax(total: number) { return total * 1.2; }');
            await fs.mkdir('e2e');
            await fs.writeFile('e2e/checkout.ts', "test('applies the discount at checkout', () => {});");
            await execFileAsync('git', ['add', '.']);
            await execFileAsync('git', ['-c', 'user.name=RBT test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'more files']);
            await fs.appendFile('src/price.ts', '\nexport const discountRate = 0.2;');
            const { lines } = await runCli(
                '--candidates', '.', '--ranker', 'heuristics', '--selection-policy', 'conservative', '--top-k', '50', '--paths-only'
            );

            assert.ok(lines.includes('e2e/checkout.ts'), lines.join('\n'));
            assert.ok(lines.includes('tests/price.test.ts'), lines.join('\n'));
            assert.ok(lines.every((line) => !line.startsWith('src/')), lines.join('\n'));
        });

        it('counts only runnable tests toward the candidate cap', async () => {
            await fs.mkdir('src/generated');
            await Promise.all(Array.from({ length: 1000 }, (_, index) =>
                fs.writeFile(`src/generated/module-${index}.ts`, `export const value${index} = ${index};`)
            ));
            await execFileAsync('git', ['add', '.']);
            await execFileAsync('git', ['-c', 'user.name=RBT test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'generated']);
            await fs.mkdir('e2e');
            await fs.writeFile('e2e/checkout.test.ts', "test('applies the discount at checkout', () => {});");
            await fs.appendFile('src/price.ts', '\nexport const discountRate = 0.2;');
            // Candidates are scanned in order: tests, then 1,000 sources in src, then e2e.
            const { lines } = await runCli(
                '--candidates', 'src', 'e2e', '--ranker', 'heuristics', '--selection-policy', 'conservative', '--top-k', '50', '--paths-only'
            );

            assert.ok(lines.includes('e2e/checkout.test.ts'), lines.join('\n'));
        });

        it('selects an edited __tests__ file itself from a broad candidate root', async () => {
            await fs.mkdir('__tests__');
            await fs.writeFile('__tests__/checkout.ts', "test('checks out a cart', () => {});");
            const { lines } = await runCli('--candidates', '.', '--ranker', 'heuristics', '--paths-only');
            assert.ok(lines.includes('__tests__/checkout.ts'), lines.join('\n'));
        });

        it('skips execution for a clean tree and an empty selection', async () => {
            const clean = await runCli('--ranker', 'heuristics');
            assert.deepEqual(clean.lines, ['No local source changes. Tests not run.']);
            const cleanJson = await runCli('--ranker', 'heuristics', '--json');
            assert.deepEqual(JSON.parse(cleanJson.lines[0]).results, []);
            assert.deepEqual((await runCli('--ranker', 'heuristics', '--paths-only')).lines, []);
            await fs.appendFile('src/price.ts', '\nexport const changed = true;');
            const empty = await runCli('--ranker', 'heuristics', '--min-score', '1');
            assert.ok(empty.lines.includes('No matches reached minimum score 1'));
        });

        it('gives non-interactive callers a selection-only alternative', async () => {
            await fs.appendFile('src/price.ts', '\nexport const changed = true;');
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                await assert.rejects(runCli('--ranker', 'heuristics'), /interactive terminal.*--json or --paths-only/);
            }
        });
    });
});
