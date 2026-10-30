import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const matcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [sourceArgument, outputArgument, resumeFlag] = process.argv.slice(2);
assert.ok(sourceArgument && outputArgument, 'Usage: node scripts/benchmark-lazy-clean.mjs <lazy-clean-checkout> <output-directory>');
const source = path.resolve(sourceArgument);
const output = path.resolve(outputArgument);
const sha = '71c2d8c2923c28db41bb38899d4773ac3ca5d110';
const cases = JSON.parse(readFileSync(path.join(matcher, 'benchmarks/lazy-clean-representative/cases.json'), 'utf8'));
const scratch = mkdtempSync(path.join(tmpdir(), 'rbt-lazy-clean-'));
const checkout = path.join(scratch, 'repo');
mkdirSync(output, { recursive: true });
const benchmarkEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RBT_') && !['TYPESAFE_API_KEY', 'JEF', 'OPENAI_API_KEY', 'OPEN_AI'].includes(key)));
const sourceFiles = checked('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], matcher).trim().split('\n').sort();
const sourceHash = createHash('sha256');
for (const file of sourceFiles) sourceHash.update(file + '\0').update(readFileSync(path.join(matcher, file)));
const fingerprint = sourceHash.digest('hex');
const result = resumeFlag === '--resume' ? JSON.parse(readFileSync(path.join(output, 'results.json'), 'utf8')) : { matcherSourceSha256: fingerprint, targetSha: sha, matcherSha: command('git', ['rev-parse', 'HEAD'], matcher).stdout.trim(), node: process.version, npm: command('npm', ['--version'], matcher).stdout.trim(), evaluatedOn: new Date().toISOString().slice(0, 10),
    platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
    selectorRepetitions: 3, cleanSelectionRepetitions: 3, fullSuiteRepetitions: 1, ranker: 'heuristics', scheduling: 'package.json sequential entrypoints, fail fast, original node flags',
    completed: false, baseline: [], cases: [], cleanSelections: [], limitations: ['Mutation full-suite detection inferred from a failing constituent; full mutant npm test is not rerun.', 'Small hand-authored sample; selected suites can miss failures outside measured witnesses.', 'Working matcher source, including uncommitted implementation, is executed.'] };

assert.ok(result.matcherSourceSha256 === fingerprint || result.sourceRevalidation?.matcherSourceSha256 === fingerprint, 'matcher source changed since checkpoint');

function command(binary, args, cwd, input) {
    const started = performance.now();
    const child = spawnSync(binary, args, { cwd, env: benchmarkEnv, encoding: 'utf8', input, timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
    return { status: child.status, signal: child.signal, error: child.error?.code, ms: performance.now() - started, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}
function save() { writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n'); }
function checked(binary, args, cwd) {
    const run = command(binary, args, cwd);
    assert.equal(run.status, 0, run.stderr.slice(-2000));
    return run.stdout;
}
function summary(run) {
    return { status: run.status, signal: run.signal, error: run.error, ms: run.ms,
        failures: (run.stdout + '\n' + run.stderr).split('\n').filter(line => /FAIL |not ok|AssertionError|test\(s\) failed|error:/.test(line)).map(line => line.slice(0, 300)).slice(0, 12) };
}
function suite(files, entries) {
    const started = performance.now();
    const tests = [];
    for (const entry of entries.filter(entry => files.includes(entry.file))) {
        const run = command(process.execPath, entry.args, checkout);
        assert.ok(!run.error && !run.signal && (run.status === 0 || run.status === 1), `test infrastructure failure: ${entry.file}/${run.error ?? run.signal ?? run.status}`);
        tests.push({ file: entry.file, ...summary(run) });
        if (run.status !== 0) break;
    }
    return { ms: performance.now() - started, status: tests.every(test => test.status === 0) ? 0 : 1, tests };
}

try {
    checked('git', ['clone', '--quiet', '--shared', source, checkout], matcher);
    checked('git', ['checkout', '--quiet', '--detach', sha], checkout);
    const script = JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8')).scripts.test;
    const entries = script.split(' && ').map(part => {
        assert.match(part, /^node (?:--test )?[\w/.-]+$/);
        const args = part.split(' ').slice(1);
        return { file: args.at(-1), args };
    });
    const files = entries.map(entry => entry.file);
    assert.equal(new Set(files).size, 11);
    result.testEntrypoints = entries;
    for (const scenario of cases) {
        if (result.cases.some(row => row.id === scenario.id && row.restoredWitnessRuns?.every(run => run.status === 0))) continue;
        result.cases = result.cases.filter(row => row.id !== scenario.id);
        const originals = scenario.edits.map(edit => readFileSync(path.join(checkout, edit.file), 'utf8'));
        for (const [index, edit] of scenario.edits.entries()) {
            assert.equal(originals[index].split(edit.from).length - 1, 1, `mutation drift: ${scenario.id}/${edit.file}`);
            writeFileSync(path.join(checkout, edit.file), originals[index].replace(edit.from, edit.to));
        }
        const diffPath = path.join(scratch, 'change.diff');
        writeFileSync(diffPath, checked('git', ['diff', '--', ...scenario.edits.map(edit => edit.file)], checkout));
        const row = { id: scenario.id, description: scenario.description, files: scenario.edits.map(edit => edit.file), witnesses: scenario.witnesses, policies: {} };
        for (const [name, flags] of [
            ['adaptive', ['--selection-policy', 'adaptive']],
            ['ranked-k3', ['--selection-policy', 'adaptive', '--top-k', '3']],
            ['representative-k3', ['--selection-policy', 'representative', '--top-k', '3']],
        ]) {
            const runs = [];
            let report;
            for (let repetition = 0; repetition < 3; repetition += 1) {
                const run = command(process.execPath, ['--experimental-strip-types', path.join(matcher, 'src/cli.ts'), 'match', ...row.files,
                    '--diff-file', diffPath, '--diff-root', checkout, '--candidates-from-stdin', '--ranker', 'heuristics', '--json', ...flags], checkout, JSON.stringify(files));
                assert.equal(run.status, 0, run.stderr);
                report = JSON.parse(run.stdout);
                const selected = report.results.map(match => match.file);
                assert.ok(selected.every(file => files.includes(file)));
                if (runs.length) assert.deepEqual(selected, runs[0].selected);
                runs.push({ ms: run.ms, selected });
            }
            row.policies[name] = { selected: runs[0].selected, selectorMs: runs.map(run => run.ms), eligibleCount: report.eligibleCount,
                selectionMethod: report.selectionMethod, selectionTruncated: report.selectionTruncated, selectionObjective: report.selectionObjective };
        }
        result.cases.push(row);
        row.witnessRuns = scenario.witnesses.map(file => ({ file, ...suite([file], entries) }));
        save();
        assert.ok(row.witnessRuns.every(run => run.status !== 0 && run.tests.some(test => test.failures.length)), `surviving mutation: ${scenario.id}`);
        const executions = new Map();
        for (const policy of Object.values(row.policies)) {
            const key = files.filter(file => policy.selected.includes(file)).join('\n');
            if (!executions.has(key)) executions.set(key, suite(policy.selected, entries));
            policy.mutantExecution = executions.get(key);
            policy.detected = policy.mutantExecution.status !== 0;
            policy.witnessesSelected = scenario.witnesses.filter(file => policy.selected.includes(file));
        }
        for (const [index, edit] of scenario.edits.entries()) writeFileSync(path.join(checkout, edit.file), originals[index]);
        row.restoredWitnessRuns = scenario.witnesses.map(file => ({ file, ...suite([file], entries) }));
        save();
        assert.ok(row.restoredWitnessRuns.every(run => run.status === 0), `restored witness failed: ${scenario.id}/${JSON.stringify(row.restoredWitnessRuns)}`);
        save();
        console.log(JSON.stringify({ phase: 'mutation', id: row.id, policies: Object.fromEntries(Object.entries(row.policies).map(([key, value]) => [key, { selected: value.selected, detected: value.detected }])) }));
    }
    if (!result.baseline.length) {
        const baseline = command('npm', ['test'], checkout);
        result.baseline.push(summary(baseline));
        save();
        assert.equal(baseline.status, 0, baseline.stderr.slice(-2000));
        console.log(JSON.stringify({ phase: 'full-baseline', ms: baseline.ms, status: baseline.status }));
    }
    assert.equal(result.baseline[0].status, 0, 'full baseline failed');
    const sets = new Map();
    for (const scenario of result.cases) for (const [name, policy] of Object.entries(scenario.policies)) {
        const selected = files.filter(file => policy.selected.includes(file));
        const key = selected.join('\n');
        if (!sets.has(key)) sets.set(key, { selected, uses: [], runs: [] });
        sets.get(key).uses.push(`${scenario.id}/${name}`);
    }
    for (const entry of sets.values()) {
        if (result.cleanSelections.some(previous => previous.selected.join('\n') === entry.selected.join('\n'))) continue;
        if (entry.selected.length === files.length) {
            entry.runs = result.baseline;
            entry.reusedFullBaseline = true;
        }
        for (let repetition = 0; repetition < (entry.reusedFullBaseline ? 0 : 3); repetition += 1) {
            const run = suite(entry.selected, entries);
            entry.runs.push(run);
            if (run.status !== 0) {
                result.failedCleanSelection = entry;
                save();
                assert.fail(`clean selected suite failed: ${JSON.stringify(run)}`);
            }
        }
        result.cleanSelections.push(entry);
        save();
        console.log(JSON.stringify({ phase: 'clean-selection', selected: entry.selected, ms: entry.runs.map(run => run.ms) }));
    }
    checked('git', ['diff', '--exit-code'], checkout);
    result.completed = true;
    save();
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
