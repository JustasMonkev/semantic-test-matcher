import fs from 'node:fs/promises';
import path from 'node:path';
import fastGlob from 'fast-glob';
import { glob as tinyGlob } from 'tinyglobby';
import { fdir } from 'fdir';
import { collectCandidateFilesDetailed } from '../src/utils/files.ts';
import { measure, report, section } from './harness.mjs';

const ROOT = path.resolve(process.argv[2] ?? './tree-small');

// Mirrors src/utils/files.ts
const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'mts', 'cjs', 'cts'];
const SKIP_DIRS = ['.git', 'node_modules', '.idea', 'dist', 'build', 'coverage', '.cache', '.parcel-cache', '.next'];
const IGNORE = SKIP_DIRS.map((dir) => `**/${dir}/**`);
const PATTERN = `**/*.{${EXTENSIONS.join(',')}}`;

async function customWalk() {
    return (await collectCandidateFilesDetailed([ROOT], ['**/*'], [], ROOT)).files;
}

async function fastGlobWalk() {
    return fastGlob(PATTERN, { cwd: ROOT, ignore: IGNORE, absolute: true, onlyFiles: true, followSymbolicLinks: false });
}

async function tinyglobbyWalk() {
    return tinyGlob(PATTERN, { cwd: ROOT, ignore: IGNORE, absolute: true, onlyFiles: true, followSymbolicLinks: false });
}

async function fdirWalk() {
    const skip = new Set(SKIP_DIRS);
    const allowed = new Set(EXTENSIONS.map((ext) => `.${ext}`));
    return new fdir()
        .withFullPaths()
        .exclude((dirName) => skip.has(dirName) || dirName.startsWith('.'))
        .filter((filePath) => allowed.has(path.extname(filePath)))
        .crawl(ROOT)
        .withPromise();
}

async function nodeGlobWalk() {
    const out = [];
    for await (const entry of fs.glob(PATTERN, { cwd: ROOT, exclude: (name) => SKIP_DIRS.includes(name) })) {
        out.push(path.resolve(ROOT, entry));
    }
    return out;
}

// --------------------------------------------------------------- results ----
section(`DIRECTORY WALK — ${ROOT}`);

const implementations = [
    { name: 'custom (files.ts)', run: customWalk, baseline: true },
    { name: 'fast-glob', run: fastGlobWalk },
    { name: 'tinyglobby', run: tinyglobbyWalk },
    { name: 'fdir', run: fdirWalk },
    { name: 'node fs.glob (22+)', run: nodeGlobWalk },
];

console.log('\nresult-set parity (sorted absolute paths):');
const baselineResult = (await customWalk()).slice().sort();
console.log(`  custom (files.ts)  -> ${baselineResult.length} files (MAX_CANDIDATE_FILES cap = 1000)`);
for (const impl of implementations.slice(1)) {
    const result = (await impl.run()).slice().sort();
    const baseSet = new Set(baselineResult);
    const resultSet = new Set(result);
    const onlyCustom = baselineResult.filter((f) => !resultSet.has(f)).length;
    const onlyLib = result.filter((f) => !baseSet.has(f)).length;
    console.log(`  ${impl.name.padEnd(18)} -> ${String(result.length).padStart(5)} files, ${onlyCustom} only-in-custom, ${onlyLib} only-in-lib`);
}

const results = [];
for (const impl of implementations) {
    const stats = await measure(impl.run, { warmup: 3, samples: 9 });
    results.push({ name: impl.name, baseline: impl.baseline, ...stats });
}
report('full crawl (per call)', results, { unit: 'crawl' });
