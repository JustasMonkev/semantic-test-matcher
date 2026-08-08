import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.argv[2];
const SCALE = Number(process.argv[3] || 1);

await fs.rm(ROOT, { recursive: true, force: true });

const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const NOISE_EXT = ['.md', '.json', '.css', '.snap', '.png'];

let codeFiles = 0;
let noiseFiles = 0;

async function writeFiles(dir, count, exts) {
    await fs.mkdir(dir, { recursive: true });
    const writes = [];
    for (let i = 0; i < count; i += 1) {
        const ext = exts[i % exts.length];
        writes.push(fs.writeFile(path.join(dir, `mod-${i}${ext}`), `export const value${i} = ${i};\n`));
        if (CODE_EXT.includes(ext)) codeFiles += 1; else noiseFiles += 1;
    }
    await Promise.all(writes);
}

// Realistic shape: a src/tests tree the walker must traverse, plus heavy
// node_modules/dist/.git trees it is supposed to skip entirely.
for (let pkg = 0; pkg < 6 * SCALE; pkg += 1) {
    for (const area of ['src', 'tests']) {
        for (let sub = 0; sub < 5; sub += 1) {
            await writeFiles(path.join(ROOT, `packages/pkg-${pkg}/${area}/group-${sub}`), 10, [...CODE_EXT, ...NOISE_EXT]);
        }
    }
    await writeFiles(path.join(ROOT, `packages/pkg-${pkg}/dist`), 40, CODE_EXT);
}

for (let dep = 0; dep < 40 * SCALE; dep += 1) {
    await writeFiles(path.join(ROOT, `node_modules/dep-${dep}/lib`), 25, [...CODE_EXT, ...NOISE_EXT]);
}
for (let obj = 0; obj < 20; obj += 1) {
    await writeFiles(path.join(ROOT, `.git/objects/${obj}`), 20, ['.pack']);
}
await writeFiles(path.join(ROOT, 'build/out'), 200, CODE_EXT);

console.log(`tree at ${ROOT}: ${codeFiles} code files, ${noiseFiles} non-code files`);
