import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'node:test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cleanEnvironment(root: string): NodeJS.ProcessEnv {
    return {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
            'OPENAI_API_KEY', 'OPEN_AI', 'TYPESAFE_API_KEY', 'JEF',
        ].includes(key.toUpperCase()))),
        TMPDIR: root,
    };
}

async function makeCheckout(root: string, distractorCount: number): Promise<string[]> {
    const sources = [
        'packages/playwright-core/src/server/callLog.ts',
        'packages/isomorphic/jsonSchema.ts',
        'packages/isomorphic/timeoutRunner.ts',
        'packages/isomorphic/time.ts',
        'packages/trace-viewer/src/ui/codegen.ts',
    ];
    const specs = ['sequence', 'json-schema', 'timeout-runner', 'codegen']
        .map(name => `tests/library/unit/${name}.spec.ts`);
    const distractors = Array.from({ length: distractorCount }, (_, index) => `tests/distractor-${index}.spec.ts`);
    for (const file of [...sources, ...specs, ...distractors]) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(path.join(root, file), file === sources[0] ? 'count: maxRepeatCount' : '');
    }
    return [...specs, ...distractors];
}

for (const missingRipgrep of [false, true]) {
    it(missingRipgrep ? 'reports the ripgrep prerequisite when the executable is missing' : 'rejects a Playwright corpus with fewer than 96 distinct distractors', async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-small-corpus-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const specs = await makeCheckout(root, 95);
        const output = path.join(root, 'results');
        const env = cleanEnvironment(root);
        env.PATH = root;
        if (!missingRipgrep) {
            const discoveryStub = path.join(root, 'discovery-stub.mjs');
            await fs.writeFile(discoveryStub, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.spawnSync;
childProcess.spawnSync = (command, ...args) => command === 'rg'
    ? { status: 0, stdout: ${JSON.stringify(specs.join('\n'))}, stderr: '' }
    : original(command, ...args);
syncBuiltinESMExports();
`);
            env.NODE_OPTIONS = '--import=' + pathToFileURL(discoveryStub).href;
        }
        const result = spawnSync(process.execPath, [
            path.join(repository, 'benchmarks/playwright-mutations/prepare.mjs'),
            root, path.join(root, 'node_modules/@playwright/test'), output,
        ], { encoding: 'utf8', env, timeout: 10000 });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, missingRipgrep ? /requires ripgrep \(rg\); install it and add it to PATH/ : /requires at least 96 distinct distractor specs; found 95/);
        await assert.rejects(fs.access(path.join(output, 'manifest.json')));
        await assert.rejects(fs.access(path.join(output, 'mutation-baseline.json')));
    });
}

for (const [label, diffResult] of [
    ['missing executable', { status: null, stdout: null, error: { code: 'ENOENT' } }],
    ['unsupported flags', { status: 2, stdout: '' }],
    ['no differences', { status: 0, stdout: '' }],
    ['empty patch', { status: 1, stdout: '' }],
] as const) {
    it(`rejects invalid mutation diffs: ${label}`, async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-invalid-diff-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const specs = await makeCheckout(root, 96);
        const stub = path.join(root, 'subprocess-stub.mjs');
        await fs.writeFile(stub, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.spawnSync;
let runs = 0;
childProcess.spawnSync = (command, ...args) => {
    if (command === 'rg') return { status: 0, stdout: ${JSON.stringify(specs.join('\n'))}, stderr: '' };
    if (command === 'diff') return ${JSON.stringify(diffResult)};
    if (command === process.execPath) {
        const status = runs++ === 0 ? 'passed' : 'failed';
        return { status: status === 'passed' ? 0 : 1, stderr: '', stdout: JSON.stringify({ suites: [{ specs: [{
            file: 'sequence.spec.ts', title: 'fixture', tests: [{ results: [{ status }] }]
        }] }] }) };
    }
    return original(command, ...args);
};
syncBuiltinESMExports();
`);
        const output = path.join(root, 'results');
        const result = spawnSync(process.execPath, [path.join(repository, 'benchmarks/playwright-mutations/prepare.mjs'),
            root, path.join(root, 'node_modules/@playwright/test'), output], {
            encoding: 'utf8', timeout: 10000,
            env: { ...cleanEnvironment(root), PATH: root, NODE_OPTIONS: '--import=' + pathToFileURL(stub).href },
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Could not generate a nonempty mutation diff: call-log-count/);
        await assert.rejects(fs.access(path.join(output, 'manifest.json')));
    });
}

it('benchmark command tests ignore inherited Jev credentials without network access', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-test-credentials-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const guard = path.join(root, 'no-network.mjs');
    await fs.writeFile(guard, "globalThis.fetch = async () => { throw new Error('unexpected network request'); };\n");
    const env: NodeJS.ProcessEnv = { ...cleanEnvironment(root), JEF: 'inherited-test-key', NODE_OPTIONS: '--import=' + pathToFileURL(guard).href };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap',
        '--test-name-pattern', 'fails instead of falling back when the jev ranker has no API key',
        path.join(repository, 'tests/benchmark.test.ts')], {
        encoding: 'utf8', timeout: 10000,
        env,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 1\b/);
});

for (const selected of [[], ['tests/first.spec.ts'], ['tests/first.spec.ts', 'tests/second.spec.ts']]) {
    it(`fallback verification requires both compound labels: ${selected.length} selected`, async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-fallback-proof-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const scripts = path.join(root, 'benchmarks/playwright-mutations');
        await fs.mkdir(scripts, { recursive: true });
        await fs.mkdir(path.join(root, 'src'));
        await fs.copyFile(path.join(repository, 'benchmarks/playwright-mutations/verify-fallback.mjs'), path.join(scripts, 'verify-fallback.mjs'));
        await fs.writeFile(path.join(root, 'src/cli.ts'), `
const effectiveRanker: string = process.env.OPEN_AI ? 'decisions' : 'heuristics';
console.log(JSON.stringify({ effectiveRanker, changes: [{ effectiveRanker }, { effectiveRanker }],
    results: ${JSON.stringify(selected.map(file => ({ file })))} }));
`);
        await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
            rankingRoot: root,
            compound: { sources: ['first.ts', 'second.ts'], relevantTests: ['tests/first.spec.ts', 'tests/second.spec.ts'] },
        }));
        const env: NodeJS.ProcessEnv = { ...cleanEnvironment(root), OPEN_AI: 'test-key' };
        if (selected.length === 2) env.NODE_OPTIONS = '--no-experimental-strip-types';
        const result = spawnSync(process.execPath, [path.join(scripts, 'verify-fallback.mjs'), root], {
            encoding: 'utf8', env, timeout: 10000,
        });
        if (selected.length === 2) {
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout.trim().split('\n').length, 2);
        } else {
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Fallback missed known failing tests/);
            assert.match(result.stderr, /tests\/second\.spec\.ts/);
        }
    });
}

it('benchmark children enable TypeScript stripping when disabled by default', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-benchmark-node-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const scripts = path.join(root, 'benchmarks/playwright-mutations');
    await fs.mkdir(scripts, { recursive: true });
    await fs.mkdir(path.join(root, 'src'));
    for (const name of ['run.mjs', 'audit-fetch.mjs']) {
        await fs.copyFile(path.join(repository, 'benchmarks/playwright-mutations', name), path.join(scripts, name));
    }
    await fs.writeFile(path.join(root, 'src/cli.ts'), `
const ranker: string = 'heuristics';
console.log(JSON.stringify({ ranker, effectiveRanker: ranker, observedRanking: [], results: [{ file: 'tests/first.spec.ts' }] }));
`);
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
        rankingRoot: root, candidates: ['tests/first.spec.ts'], cases: [],
        compound: { sources: ['first.ts'], relevantTests: ['tests/first.spec.ts'] },
    }));
    const result = spawnSync(process.execPath, [path.join(scripts, 'run.mjs'), root, 'heuristics'], {
        encoding: 'utf8', env: { ...cleanEnvironment(root), NODE_OPTIONS: '--no-experimental-strip-types' }, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    await fs.access(path.join(root, 'heuristics-summary.json'));
});
