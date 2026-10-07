import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = path.resolve(process.argv[2]);
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
for (const [id, omittedKeys, expectedRanker] of [
    ['jev-to-decisions-compound', ['TYPESAFE_API_KEY', 'JEF'], 'decisions'],
    ['both-missing-to-heuristics', ['TYPESAFE_API_KEY', 'JEF', 'OPENAI_API_KEY', 'OPEN_AI'], 'heuristics'],
]) {
    const args = ['match', ...manifest.compound.sources, '--diff-file', 'compound.diff', '--selection-policy', 'adaptive', '--candidates', 'tests', '--ranker', 'jev', '--fallback-ranker', 'decisions', '--cache-dir', path.join(manifest.rankingRoot, 'cache-decisions'), '--json'];
    const started = performance.now();
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'src/cli.ts'), ...args], {
        cwd: manifest.rankingRoot, encoding: 'utf8', timeout: 120000,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !omittedKeys.includes(key.toUpperCase()))),
    });
    await fs.writeFile(path.join(directory, `fallback-${id}.json`), JSON.stringify({ id, omittedKeys, args, elapsedMs: performance.now() - started, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }, null, 2));
    if (result.status !== 0) throw new Error(`Fallback check failed: ${id}`);
    const report = JSON.parse(result.stdout);
    if (report.effectiveRanker !== expectedRanker || report.changes.some(change => change.effectiveRanker !== expectedRanker)) throw new Error(`Whole-run fallback attribution failed: ${id}`);
    console.log(JSON.stringify({ id, effectiveRanker: report.effectiveRanker, selectedCount: report.results.length, changes: report.changes.map(change => ({ effectiveRanker: change.effectiveRanker, attempts: change.rankerAttempts, modelScorer: change.modelScorer })) }));
}
