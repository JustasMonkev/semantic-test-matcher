import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutations = [
    {
        name: 'accept failed mutation diff generation', file: 'benchmarks/playwright-mutations/prepare.mjs',
        from: 'generatedDiff.error || generatedDiff.status !== 1 || !generatedDiff.stdout?.trim()', to: 'false',
        testFile: 'tests/playwright-benchmark.test.ts', test: 'rejects invalid mutation diffs: missing executable',
    },
    {
        name: 'retry before a long Retry-After expires', file: 'src/services/decisions.ts',
        from: 'retryAfterMs > MAX_RETRY_DELAY_MS', to: 'false',
        testFile: 'tests/decisions.test.ts', test: 'does not retry earlier than an excessive Retry-After: 5',
    },
    {
        name: 'inherit a real Jev key in benchmark tests', file: 'tests/benchmark.test.ts',
        from: 'delete process.env.TYPESAFE_API_KEY;\n        delete process.env.JEF;', to: 'delete process.env.TYPESAFE_API_KEY;',
        testFile: 'tests/playwright-benchmark.test.ts', test: 'benchmark command tests ignore inherited Jev credentials without network access',
    },
    {
        name: 'omit TypeScript stripping from benchmark children', file: 'benchmarks/playwright-mutations/run.mjs',
        from: "['--experimental-strip-types', '--import',", to: "['--import',",
        testFile: 'tests/playwright-benchmark.test.ts', test: 'benchmark children enable TypeScript stripping when disabled by default',
    },
    {
        name: 'omit TypeScript stripping from fallback children', file: 'benchmarks/playwright-mutations/verify-fallback.mjs',
        from: "['--experimental-strip-types', path.join(repositoryRoot, 'src/cli.ts'),", to: "[path.join(repositoryRoot, 'src/cli.ts'),",
        testFile: 'tests/playwright-benchmark.test.ts', test: 'fallback verification requires both compound labels: 2 selected',
    },
    {
        name: 'count unrelated Jev cache after Decisions fallback', file: 'src/commands/match.ts',
        from: "cacheRanker === 'decisions'", to: "reports[0]?.ranker === 'decisions'",
        testFile: 'tests/match-command.test.ts', test: 'reports persisted Decisions cache after decisions falls back to heuristics',
    },
    {
        name: 'hide the missing ripgrep prerequisite', file: 'benchmarks/playwright-mutations/prepare.mjs',
        from: "discovery.error?.code === 'ENOENT'", to: 'false',
        testFile: 'tests/playwright-benchmark.test.ts', test: 'reports the ripgrep prerequisite when the executable is missing',
    },
    {
        name: 'allow duplicate benchmark distractors', file: 'benchmarks/playwright-mutations/prepare.mjs',
        from: 'if (distractors.length < 96)', to: 'if (false)',
        testFile: 'tests/playwright-benchmark.test.ts', test: 'rejects a Playwright corpus with fewer than 96 distinct distractors',
    },
    {
        name: 'accept fallback that misses a compound label', file: 'benchmarks/playwright-mutations/verify-fallback.mjs',
        from: 'if (missing.length)', to: 'if (false)',
        testFile: 'tests/playwright-benchmark.test.ts', test: 'fallback verification requires both compound labels: 1 selected',
    },
    {
        name: 'map all answers to the first candidate', file: 'src/services/decisions.ts',
        from: 'response.probabilities.get(questions[index].name)!', to: 'response.probabilities.get(questions[indices[0]].name)!',
        testFile: 'tests/decisions.test.ts', test: 'uses independent named predicates and maps reordered answers by name, including valid zero',
    },
    {
        name: 'accept invalid predicate probability', file: 'src/services/decisions.ts',
        from: "answer.type !== 'predicate' || !isProbability(answer.probability)", to: "answer.type !== 'predicate'",
        testFile: 'tests/decisions.test.ts', test: 'rejects over-one probability without retrying or caching partial answers',
    },
    {
        name: 'accept a missing candidate answer', file: 'src/services/decisions.ts',
        from: 'probabilities.size !== expected.size', to: 'probabilities.size > expected.size',
        testFile: 'tests/decisions.test.ts', test: 'rejects missing candidate without retrying or caching partial answers',
    },
    {
        name: 'ignore cache expiry', file: 'src/services/decisions.ts',
        from: 'age >= 0 && age < CACHE_TTL_MS', to: 'age >= 0',
        testFile: 'tests/decisions.test.ts', test: 'reuses fresh cache entries, isolates Jev cache, and expires an alias after 24 hours',
    },
    {
        name: 'leak source when diff-only has no hunks', file: 'src/services/model-scorer.ts',
        from: '} else if (!source.diffOnly) {', to: '} else {',
        testFile: 'tests/decisions.test.ts', test: 'honors diff-only disclosure even when no matching hunks exist',
    },
    {
        name: 'stop retrying transient statuses', file: 'src/services/decisions.ts',
        from: 'response.status === 408 || response.status === 429 || response.status >= 500', to: 'response.status === 408',
        testFile: 'tests/decisions.test.ts', test: 'retries transient statuses, counting retry requests',
    },
    {
        name: 'leak Jev upstream error body in fallback reasons', file: 'src/services/jev.ts',
        from: 'describeFailure(response.status);', to: "describeFailure(response.status) + ': ' + await response.text();",
        testFile: 'tests/jev.test.ts', test: 'never exposes an upstream error body in fallback reasons',
    },
    {
        name: 'send an oversized Jev candidate', file: 'src/services/jev.ts',
        from: 'if (size > tokenBudget) {', to: 'if (false) {',
        testFile: 'tests/jev.test.ts', test: 'rejects a single candidate that exceeds the remaining request budget before sending it',
    },
    {
        name: 'accept a Jev refusal carrying a probability', file: 'src/services/jev.ts',
        from: "if (answer?.type !== 'noul' || !isProbability(answer.noul)) {", to: 'if (!isProbability(answer?.noul)) {',
        testFile: 'tests/jev.test.ts', test: 'rejects a non-noul answer even when it carries a probability',
    },
    {
        name: 'retain inherited remote fallback for explicit local ranking', file: 'src/config.ts',
        from: "fallbackRanker = 'heuristics';", to: "fallbackRanker = 'decisions';",
        testFile: 'tests/config.test.ts', test: 'lets an explicit local ranker override an inherited remote fallback',
    },
    {
        name: 'leak Jev transport details in fallback reasons', file: 'src/services/jev.ts',
        from: "failure: 'network, timeout, or body-read error'", to: 'failure: error instanceof Error ? error.message : String(error)',
        testFile: 'tests/jev.test.ts', test: 'never exposes transport error details after retry exhaustion',
    },
    {
        name: 'mix partially completed providers in whole-run fallback', file: 'src/commands/match.ts',
        from: 'const results: ModelScoreResult[] = [];', to: 'const results: ModelScoreResult[] = modelResults;',
        testFile: 'tests/match-command.test.ts', test: 'rescores every source with Decisions when Jev fails after partial success',
    },
    {
        name: 'swallow programming errors as fallback', file: 'src/commands/match.ts',
        from: 'if (!(error instanceof ModelScorerError)) throw error;', to: '',
        testFile: 'tests/match-command.test.ts', test: 'propagates unrelated programming errors instead of disguising them as fallback',
    },
    {
        name: 'disable explicit Decisions fallback', file: 'src/commands/match.ts',
        from: "ranker === 'jev' && config.fallbackRanker === 'decisions' ? ['jev', 'decisions'] : [ranker]",
        to: "[ranker]",
        testFile: 'tests/match-command.test.ts', test: 'falls back from unavailable Jev to Decisions only when explicitly configured',
    },
    {
        name: 'treat Decisions as unavailable for targeted selection', file: 'src/services/match.ts',
        from: "if (ranker === 'heuristics') {", to: "if (ranker !== 'jev') {",
        testFile: 'tests/selection.test.ts', test: 'uses Decisions model evidence for adaptive and targeted selection at the same boundaries',
    },
];

const outputFlag = process.argv.indexOf('--output');
const outputFile = outputFlag < 0 ? undefined : process.argv[outputFlag + 1];
if (outputFlag >= 0 && !outputFile) throw new Error('--output requires a path');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-mutation-'));
const testFiles = [...new Set(mutations.map(mutation => mutation.testFile))];
const report = { generatedAt: new Date().toISOString(), command: 'node scripts/mutation-check.mjs', baseline: undefined, mutants: [], restored: undefined };

function executeTests(pattern, files) {
    const args = ['--experimental-strip-types', '--test', '--test-reporter=tap'];
    if (pattern) args.push('--test-name-pattern', pattern);
    args.push(...files);
    const result = spawnSync(process.execPath, args, { cwd: temporary, encoding: 'utf8', timeout: 60_000 });
    if (result.error) throw result.error;
    return { exitCode: result.status, output: `${result.stdout}${result.stderr}` };
}

const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

try {
    await fs.cp(path.join(root, 'src'), path.join(temporary, 'src'), { recursive: true });
    await fs.cp(path.join(root, 'tests'), path.join(temporary, 'tests'), { recursive: true });
    await fs.cp(path.join(root, 'benchmarks/playwright-mutations'), path.join(temporary, 'benchmarks/playwright-mutations'), { recursive: true });
    await fs.copyFile(path.join(root, 'package.json'), path.join(temporary, 'package.json'));
    await fs.symlink(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), 'dir');
    report.baseline = executeTests(undefined, testFiles);
    if (report.baseline.exitCode !== 0) throw new Error('Unmutated baseline failed; no mutation claims are valid');
    for (const mutation of mutations) {
        const file = path.join(temporary, mutation.file);
        const original = await fs.readFile(file, 'utf8');
        if (original.split(mutation.from).length !== 2) throw new Error(`Mutation anchor is not unique: ${mutation.name}`);
        try {
            await fs.writeFile(file, original.replace(mutation.from, mutation.to));
            const result = executeTests(escaped(mutation.test), [mutation.testFile]);
            const expectedTestFailed = new RegExp(`not ok \\d+ - ${escaped(mutation.test)}(?:\\n|\\r)`).test(result.output);
            const killed = result.exitCode !== 0 && expectedTestFailed;
            report.mutants.push({ name: mutation.name, file: mutation.file, from: mutation.from, to: mutation.to,
                testCommand: [process.execPath, '--experimental-strip-types', '--test', '--test-reporter=tap', '--test-name-pattern', escaped(mutation.test), mutation.testFile],
                expectedTest: mutation.test, expectedTestFailed, killed, ...result });
            console.log(`${killed ? 'KILLED' : 'SURVIVED/INVALID'}: ${mutation.name}`);
        } finally {
            await fs.writeFile(file, original);
        }
    }
    report.restored = executeTests(undefined, testFiles);
    if (report.restored.exitCode !== 0 || report.mutants.some(mutant => !mutant.killed)) process.exitCode = 1;
    console.log(`Baseline and restored controls: ${report.baseline.exitCode === 0 && report.restored.exitCode === 0 ? 'passed' : 'failed'}; ${report.mutants.filter(mutant => mutant.killed).length}/${report.mutants.length} mutants killed`);
} finally {
    if (outputFile) await fs.writeFile(path.resolve(root, outputFile), `${JSON.stringify(report, null, 2)}\n`);
    await fs.rm(temporary, { recursive: true, force: true });
}
