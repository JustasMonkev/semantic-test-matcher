// Runs every benchmark in a fresh child process so module-load effects and GC
// state from one suite cannot bias the next.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;

const SUITES = [
    ['bench-globs.mjs', []],
    ['bench-walk.mjs', ['./tree-small']],
    ['bench-walk.mjs', ['./tree-big']],
    ['bench-walk.mjs', ['./tree-huge']],
    ['bench-async.mjs', []],
    ['bench-cache.mjs', []],
    ['bench-config.mjs', []],
    ['bench-startup.mjs', []],
    ['bench-pipeline.mjs', ['./tree-small']],
];

const missingTrees = ['tree-small', 'tree-big', 'tree-huge'].filter(
    (tree) => !fs.existsSync(path.join(HERE, tree))
);
if (missingTrees.length) {
    console.error(`Missing generated trees: ${missingTrees.join(', ')}. Run "npm run setup" first.`);
    process.exit(1);
}

function run(script, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ['--experimental-strip-types', '--expose-gc', '--no-warnings', script, ...args],
            { cwd: HERE, stdio: 'inherit' }
        );
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`))));
    });
}

for (const [script, args] of SUITES) {
    await run(script, args);
}
