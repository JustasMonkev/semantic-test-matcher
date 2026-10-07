import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const [checkout, runnerPackage, outputDirectory] = process.argv.slice(2);
if (!checkout || !runnerPackage || !outputDirectory) {
    throw new Error('Usage: node prepare.mjs <playwright-checkout> <installed-@playwright/test> <output-directory>');
}
const executionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-playwright-mutations-'));
const rankingRoot = path.join(executionRoot, 'ranking');
const specPaths = ['sequence', 'json-schema', 'timeout-runner', 'codegen'].map(name => `tests/library/unit/${name}.spec.ts`);
const sourcePaths = [
    'packages/playwright-core/src/server/callLog.ts',
    'packages/isomorphic/jsonSchema.ts',
    'packages/isomorphic/timeoutRunner.ts',
    'packages/isomorphic/time.ts',
    'packages/trace-viewer/src/ui/codegen.ts',
];
const mutations = [
    { id: 'call-log-count', source: sourcePaths[0], before: 'count: maxRepeatCount', after: 'count: 1' },
    { id: 'schema-required', source: sourcePaths[1], before: 'schema.required || []', after: '[]' },
    { id: 'schema-pattern', source: sourcePaths[1], before: '!cachedRegex(schema.pattern).test(value)', after: 'cachedRegex(schema.pattern).test(value)' },
    { id: 'deadline-result', source: sourcePaths[2], before: 'resolve({ timedOut: true })', after: 'resolve({ timedOut: false })' },
    { id: 'request-headers', source: sourcePaths[4], before: 'if (request.headers.length)\n      options.headers', after: 'if (false)\n      options.headers' },
];
await fs.mkdir(outputDirectory, { recursive: true });
await fs.mkdir(path.join(executionRoot, 'specs'));
const runnerRoot = path.dirname(path.dirname(runnerPackage));
await fs.symlink(runnerRoot, path.join(executionRoot, 'node_modules'));
await fs.writeFile(path.join(executionRoot, 'playwright.config.cjs'), `module.exports = { testDir: './specs', workers: 1, retries: 0, timeout: 10000, outputDir: './test-results', reporter: 'json' };\n`);
const originals = new Map();
for (const relative of sourcePaths) {
    const text = await fs.readFile(path.join(checkout, relative), 'utf8');
    originals.set(relative, text);
    for (const root of [executionRoot, rankingRoot]) {
        await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        await fs.writeFile(path.join(root, relative), text);
    }
}
for (const relative of specPaths) {
    let text = await fs.readFile(path.join(checkout, relative), 'utf8');
    if (relative.includes('sequence.spec')) {
        text = text.replace("import { server as coreServer } from '../../../packages/playwright-core/lib/coreBundle';\nconst { findRepeatedSubsequencesForTest: findRepeatedSubsequences } = coreServer;", "import { findRepeatedSubsequencesForTest as findRepeatedSubsequences } from '../packages/playwright-core/src/server/callLog.ts';");
    } else if (relative.includes('json-schema.spec')) {
        text = text.replace("import type { iso } from '../../../packages/playwright-core/lib/coreBundle';\nimport { iso as _iso } from '../../../packages/playwright-core/lib/coreBundle';\n\nconst { validate } = _iso;\ntype JsonSchema = iso.JsonSchema;", "import { validate, type JsonSchema } from '../packages/isomorphic/jsonSchema.ts';");
    } else {
        text = text.replaceAll('../../../packages/', '../packages/');
    }
    await fs.writeFile(path.join(executionRoot, 'specs', path.basename(relative)), text);
}
const allSpecs = spawnSync('rg', ['--files', 'tests', '-g', '*.spec.ts'], { cwd: checkout, encoding: 'utf8' }).stdout.trim().split('\n').sort();
const distractors = allSpecs.filter(relative => !specPaths.includes(relative));
const candidates = [...specPaths, ...Array.from({ length: 96 }, (_, index) => distractors[Math.floor(index * distractors.length / 96)])].sort();
for (const relative of candidates) {
    await fs.mkdir(path.dirname(path.join(rankingRoot, relative)), { recursive: true });
    await fs.copyFile(path.join(checkout, relative), path.join(rankingRoot, relative));
}
function runTests(id) {
    const result = spawnSync(process.execPath, [path.join(runnerPackage, 'cli.js'), 'test', '--config', path.join(executionRoot, 'playwright.config.cjs')], {
        cwd: executionRoot, encoding: 'utf8', timeout: 120000,
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !['OPENAI_API_KEY', 'OPEN_AI', 'TYPESAFE_API_KEY', 'JEF'].includes(name.toUpperCase()))),
    });
    return { id, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
}
function outcomes(raw) {
    const report = JSON.parse(raw.stdout);
    const tests = [];
    const visit = suite => {
        for (const spec of suite.specs ?? []) {
            for (const test of spec.tests) {
                tests.push({ file: `tests/library/unit/${path.basename(spec.file)}`, title: spec.title, status: test.results.at(-1)?.status });
            }
        }
        for (const child of suite.suites ?? []) visit(child);
    };
    for (const suite of report.suites) visit(suite);
    return tests;
}
const baseline = runTests('baseline');
await fs.writeFile(path.join(outputDirectory, 'mutation-baseline.json'), JSON.stringify(baseline, null, 2));
const baselineTests = outcomes(baseline);
if (baseline.status !== 0 || baselineTests.some(test => test.status !== 'passed')) throw new Error('Baseline did not pass; refusing to label mutations');
const cases = [];
for (const mutation of mutations) {
    const original = originals.get(mutation.source);
    if (original.split(mutation.before).length !== 2) throw new Error(`Mutation anchor is not unique: ${mutation.id}`);
    const changed = original.replace(mutation.before, mutation.after);
    await fs.writeFile(path.join(executionRoot, mutation.source), changed);
    const raw = runTests(mutation.id);
    await fs.writeFile(path.join(outputDirectory, `mutation-${mutation.id}.json`), JSON.stringify(raw, null, 2));
    const failedTests = outcomes(raw).filter(test => test.status === 'failed');
    if (!failedTests.length) throw new Error(`Mutation survived: ${mutation.id}`);
    await fs.writeFile(path.join(executionRoot, mutation.source), original);
    const beforePath = path.join(executionRoot, 'before.ts');
    const afterPath = path.join(executionRoot, 'after.ts');
    await fs.writeFile(beforePath, original);
    await fs.writeFile(afterPath, changed);
    const patch = spawnSync('diff', ['-u', '--label', `a/${mutation.source}`, '--label', `b/${mutation.source}`, beforePath, afterPath], { encoding: 'utf8' }).stdout;
    const diffText = `diff --git a/${mutation.source} b/${mutation.source}\n${patch}`;
    await fs.writeFile(path.join(rankingRoot, `${mutation.id}.diff`), diffText);
    cases.push({ ...mutation, diffText, relevantTests: [...new Set(failedTests.map(test => test.file))], failedTests });
}
const restored = runTests('restored');
await fs.writeFile(path.join(outputDirectory, 'mutation-restored.json'), JSON.stringify(restored, null, 2));
const restoredTests = outcomes(restored);
if (restored.status !== 0 || restoredTests.length !== baselineTests.length || restoredTests.some(test => test.status !== 'passed')) throw new Error('Restored baseline failed');
const compoundMutations = [mutations[0], mutations[1]];
for (const mutation of compoundMutations) {
    await fs.writeFile(path.join(executionRoot, mutation.source), originals.get(mutation.source).replace(mutation.before, mutation.after));
}
const compoundRaw = runTests('compound');
await fs.writeFile(path.join(outputDirectory, 'mutation-compound.json'), JSON.stringify(compoundRaw, null, 2));
const compoundFailedTests = outcomes(compoundRaw).filter(test => test.status === 'failed');
const compound = { id: 'compound', sources: compoundMutations.map(mutation => mutation.source), relevantTests: [...new Set(compoundFailedTests.map(test => test.file))], failedTests: compoundFailedTests };
if (compound.relevantTests.length !== 2) throw new Error('Compound mutation did not kill both expected files');
await fs.writeFile(path.join(rankingRoot, 'compound.diff'), cases.slice(0, 2).map(entry => entry.diffText).join('\n'));
for (const mutation of compoundMutations) await fs.writeFile(path.join(executionRoot, mutation.source), originals.get(mutation.source));
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim();
const manifest = { checkout, commit, runnerVersion: JSON.parse(await fs.readFile(path.join(runnerPackage, 'package.json'), 'utf8')).version, executionRoot, rankingRoot, candidates, baselineTests, cases, compound };
await fs.writeFile(path.join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2));
await fs.writeFile(path.join(rankingRoot, 'cases.json'), JSON.stringify(cases.map(({ source, diffText, relevantTests }) => ({ source, diffText, relevantTests, expectedTop10Includes: relevantTests })), null, 2));
console.log(JSON.stringify({ rankingRoot, candidateCount: candidates.length, baselineTests: baselineTests.length, killedMutations: cases.length }));
