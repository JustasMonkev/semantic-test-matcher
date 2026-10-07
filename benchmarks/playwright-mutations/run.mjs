import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [outputDirectory, ranker] = process.argv.slice(2);
if (!outputDirectory || !['heuristics', 'jev', 'decisions'].includes(ranker)) throw new Error('Usage: node run.mjs <output-directory> <heuristics|jev|decisions>');
const directory = path.resolve(outputDirectory);
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cacheDirectory = path.join(manifest.rankingRoot, `cache-${ranker}`);
const auditPath = path.join(directory, `${ranker}-api.ndjson`);
const runs = [];
async function run(id, args) {
    const started = performance.now();
    const result = spawnSync(process.execPath, ['--import', path.join(repositoryRoot, 'benchmarks/playwright-mutations/audit-fetch.mjs'), path.join(repositoryRoot, 'src/cli.ts'), ...args, '--candidates', 'tests', '--ranker', ranker, '--cache-dir', cacheDirectory, '--json'], {
        cwd: manifest.rankingRoot, env: { ...process.env, RBT_BENCH_AUDIT_PATH: auditPath }, encoding: 'utf8', timeout: 180000,
    });
    const raw = { id, ranker, args, elapsedMs: performance.now() - started, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
    await fs.writeFile(path.join(directory, `${ranker}-${id}.json`), JSON.stringify(raw, null, 2));
    if (result.status !== 0) throw new Error(`${ranker}/${id} failed; see raw artifact`);
    const report = JSON.parse(result.stdout.trim());
    if (report.effectiveRanker !== ranker || report.ranker !== ranker) throw new Error(`Unexpected fallback in ${ranker}/${id}`);
    runs.push({ ...raw, stdout: undefined, stderr: undefined, report });
    console.log(JSON.stringify({ id, ranker, elapsedMs: raw.elapsedMs, matched: report.matched, model: report.model, jev: report.jev }));
}
await run('ranking-cold', ['benchmark', '--cases', 'cases.json', '--threshold', '0']);
await run('ranking-warm', ['benchmark', '--cases', 'cases.json', '--threshold', '0']);
for (const entry of manifest.cases) {
    await run(`selection-${entry.id}`, ['match', entry.source, '--diff-file', `${entry.id}.diff`, '--selection-policy', 'adaptive']);
}
await run('selection-compound', ['match', ...manifest.compound.sources, '--diff-file', 'compound.diff', '--selection-policy', 'adaptive']);
const cold = runs[0].report;
const rankings = cold.observedRanking;
const rows = manifest.cases.map((entry, index) => {
    const selection = runs.find(run => run.id === `selection-${entry.id}`).report;
    const selected = selection.results.map(match => match.file);
    const hits = entry.relevantTests.filter(file => selected.includes(file)).length;
    return {
        id: entry.id, ranker, source: entry.source, labeledRelevant: entry.relevantTests.length, selectedCount: selected.length,
        selected, relevantRecall: hits / entry.relevantTests.length,
        relevantRanks: Object.fromEntries(entry.relevantTests.map(file => [file, rankings[index].results.findIndex(match => match.file === file) + 1 || null])),
        elapsedMs: runs.find(run => run.id === `selection-${entry.id}`).elapsedMs,
    };
});
const compoundRun = runs.find(run => run.id === 'selection-compound');
const compoundSelected = compoundRun.report.results.map(match => match.file);
rows.push({ id: 'compound', ranker, sources: manifest.compound.sources, labeledRelevant: manifest.compound.relevantTests.length, selectedCount: compoundSelected.length, selected: compoundSelected,
    relevantRecall: manifest.compound.relevantTests.filter(file => compoundSelected.includes(file)).length / manifest.compound.relevantTests.length, elapsedMs: compoundRun.elapsedMs });
await fs.writeFile(path.join(directory, `${ranker}-summary.json`), JSON.stringify({ ranker, candidateCount: manifest.candidates.length, selectionPolicy: 'adaptive', rows,
    coldElapsedMs: runs[0].elapsedMs, warmElapsedMs: runs[1].elapsedMs, coldModel: cold.modelScorer, warmModel: runs[1].report.modelScorer }, null, 2));
console.log(JSON.stringify({ ranker, rows }));
