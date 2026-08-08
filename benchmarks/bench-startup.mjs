// A CLI pays module-load cost on every invocation, so measure each candidate
// dependency's cold import in a fresh process.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { section, formatNs } from './harness.mjs';

const run = promisify(execFile);
const LIBS = ['picomatch', 'minimatch', 'fast-glob', 'tinyglobby', 'fdir', 'p-map', 'p-limit', 'proper-lockfile', 'write-file-atomic', 'cosmiconfig', 'zod'];
const RUNS = 7;

const script = (specifier) => `
const start = process.hrtime.bigint();
await import(${JSON.stringify(specifier)});
process.stdout.write(String(Number(process.hrtime.bigint() - start)));
`;

async function coldImportNs(specifier) {
    const samples = [];
    for (let i = 0; i < RUNS; i += 1) {
        const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script(specifier)], {
            cwd: import.meta.dirname,
        });
        samples.push(Number(stdout));
    }
    samples.sort((a, b) => a - b);
    return samples[samples.length >> 1];
}

section('COLD IMPORT COST — added to every CLI invocation');

// node:path is already loaded by the CLI; it is the "free" reference point.
const referenceNs = await coldImportNs('node:path');
console.log(`reference: import 'node:path' = ${formatNs(referenceNs)}\n`);
console.log(`${'package'.padEnd(20)}  ${'median cold import'.padStart(18)}  ${'install size'.padStart(12)}`);
console.log('-'.repeat(56));

const sizes = JSON.parse(
    (await run('sh', ['-c', 'du -sb node_modules/* 2>/dev/null | while read s p; do printf \'{"p":"%s","s":%s}\\n\' "$(basename $p)" "$s"; done | paste -sd, - | sed "s/^/[/;s/$/]/"'], { cwd: import.meta.dirname })).stdout
);
const sizeByName = new Map(sizes.map((entry) => [entry.p, entry.s]));

for (const lib of LIBS) {
    const ns = await coldImportNs(lib);
    const bytes = sizeByName.get(lib);
    console.log(
        `${lib.padEnd(20)}  ${formatNs(ns).padStart(18)}  ${(bytes ? `${(bytes / 1024).toFixed(0)} KB` : '?').padStart(12)}`
    );
}
