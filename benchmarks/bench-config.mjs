import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cosmiconfig } from 'cosmiconfig';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { measure, report, section } from './harness.mjs';

const WORK = path.join(os.tmpdir(), 'rbt-config-bench');
await fs.rm(WORK, { recursive: true, force: true });
await fs.mkdir(path.join(WORK, '.rbt'), { recursive: true });

const SAMPLE = {
    model: 'models/embeddinggemma-300M-Q4_0.gguf',
    cacheDir: '.rbt/cache',
    logLevel: 'info',
    match: {
        topK: 5,
        threshold: 0,
        candidatePaths: ['test', 'tests'],
        includePatterns: ['**/*'],
        excludePatterns: ['**/dist/**', '**/.git/**', '**/node_modules/**', '**/build/**'],
    },
};
await fs.writeFile(path.join(WORK, '.rbt', 'config.json'), JSON.stringify(SAMPLE, null, 2));

const originalCwd = process.cwd();
process.chdir(WORK);

section('CONFIG DISCOVERY — find + parse the repo config file');

const explorer = cosmiconfig('rbt', {
    searchPlaces: ['.rbt/config.json', '.rbtconfig'],
    stopDir: WORK,
});

const custom = await measure(() => loadConfig(), { samples: 15 });
// cosmiconfig caches by default; clear it so both do real work each time.
const cosmi = await measure(async () => { explorer.clearCaches(); return explorer.search(WORK); }, { samples: 15 });
const cosmiCached = await measure(() => explorer.search(WORK), { samples: 15 });

report('load .rbt/config.json', [
    { name: 'custom (config.ts loadConfig)', baseline: true, ...custom },
    { name: 'cosmiconfig (cache cleared)', ...cosmi },
    { name: 'cosmiconfig (warm cache)', ...cosmiCached },
], { unit: 'load' });

section('CONFIG VALIDATION — reject a malformed config');

const schema = z.object({
    model: z.string().optional(),
    cacheDir: z.string().optional(),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    quiet: z.boolean().optional(),
    verbose: z.boolean().optional(),
    match: z.object({
        topK: z.number().optional(),
        threshold: z.number().optional(),
        minScore: z.number().optional(),
        candidatePaths: z.array(z.string()).optional(),
        includePatterns: z.array(z.string()).optional(),
        excludePatterns: z.array(z.string()).optional(),
    }).optional(),
});

const validateCustom = await measure(() => {
    // What config.ts effectively does today: a shape-free cast plus coercion.
    const parsed = JSON.parse(JSON.stringify(SAMPLE));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
}, { samples: 15, innerOps: 1 });
const validateZod = await measure(() => schema.parse(JSON.parse(JSON.stringify(SAMPLE))), { samples: 15, innerOps: 1 });

report('validate one config object', [
    { name: 'custom (cast, no validation)', baseline: true, ...validateCustom },
    { name: 'zod schema.parse', ...validateZod },
], { unit: 'config' });

section('CONFIG VALIDATION — what each one catches');
const BAD = { logLevel: 'verbose', match: { topK: 'five', candidatePaths: 'tests' } };
console.log(`  input: ${JSON.stringify(BAD)}`);
const castResult = BAD;
console.log(`  custom cast   -> accepted; match.topK is the string "${castResult.match.topK}", candidatePaths is a ${typeof castResult.match.candidatePaths}`);
try {
    schema.parse(BAD);
    console.log('  zod           -> accepted (unexpected)');
} catch (error) {
    console.log(`  zod           -> rejected: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}

process.chdir(originalCwd);
await fs.rm(WORK, { recursive: true, force: true });
