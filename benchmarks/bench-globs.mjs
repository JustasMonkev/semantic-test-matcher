import picomatch from 'picomatch';
import { minimatch } from 'minimatch';
import { createPatternMatcher, normalizePattern } from '../src/utils/patterns.ts';
import { measure, report, section } from './harness.mjs';

// The exact patterns the CLI ships as defaults, plus the shapes users pass via
// --include-file / --exclude-file.
const EXCLUDE_PATTERNS = ['**/dist/**', '**/.git/**', '**/node_modules/**', '**/build/**'];
const INCLUDE_PATTERNS = ['**/*'];
const USER_PATTERNS = ['**/*.test.ts', 'src/**/*.ts', '*.spec.tsx', 'packages/*/tests/**/*.js', 'file?.ts'];

const DIRS = ['src', 'tests', 'packages/app/src', 'packages/app/dist', 'node_modules/foo/lib', 'build/out', '.git/objects', 'deep/nested/a/b/c'];
const NAMES = ['index.ts', 'config.ts', 'app.tsx', 'price-engine.test.ts', 'helper.spec.tsx', 'bundle.js', 'notes.md', 'file1.ts', '.eslintrc.json'];

const PATHS = [];
for (const dir of DIRS) {
    for (const name of NAMES) {
        PATHS.push(`${dir}/${name}`);
    }
}
for (const name of NAMES) PATHS.push(name);
// Scale up to a realistic candidate-set sweep size.
const CORPUS = [];
for (let i = 0; i < 40; i += 1) {
    for (const p of PATHS) CORPUS.push(i === 0 ? p : `repo${i}/${p}`);
}

console.log(`corpus: ${CORPUS.length} paths`);

// ---------------------------------------------------------------- parity ----
// Faithful port of patterns.ts semantics onto picomatch: comma splitting,
// backslash normalisation, "**/" anchoring for bare names, case-insensitive,
// and dotfile matching.
function expandPatterns(patterns) {
    return patterns
        .flatMap((p) => p.split(',').map((t) => t.trim()).filter(Boolean))
        .map((token) => {
            const unix = token.replace(/\\/g, '/');
            return unix.includes('/') ? unix : `**/${unix}`;
        });
}

function picoMatcher(patterns, emptyResult = true) {
    const expanded = expandPatterns(patterns);
    if (!expanded.length) return () => emptyResult;
    const isMatch = picomatch(expanded, { dot: true, nocase: true });
    return (candidate) => isMatch(candidate.replace(/\\/g, '/'));
}

function checkParity(patterns, label) {
    const custom = createPatternMatcher(patterns, true);
    const pico = picoMatcher(patterns, true);
    const mismatches = [];
    for (const candidate of CORPUS) {
        const a = custom(candidate);
        const b = pico(candidate);
        if (a !== b) mismatches.push({ candidate, custom: a, picomatch: b });
    }
    console.log(`  ${label}: ${mismatches.length} disagreement(s) over ${CORPUS.length} paths`);
    for (const m of mismatches.slice(0, 6)) {
        console.log(`    ${m.candidate}  custom=${m.custom} picomatch=${m.picomatch}`);
    }
    if (mismatches.length > 6) console.log(`    ... ${mismatches.length - 6} more`);
    return mismatches.length;
}

section('GLOB MATCHING — behaviour parity (custom regex builder vs picomatch)');
let totalMismatch = 0;
totalMismatch += checkParity(EXCLUDE_PATTERNS, 'default excludePatterns');
totalMismatch += checkParity(INCLUDE_PATTERNS, 'default includePatterns');
totalMismatch += checkParity(USER_PATTERNS, 'user-style patterns');
totalMismatch += checkParity(['**/*.ts,**/*.tsx'], 'comma list (custom extension)');

// Cases the custom implementation cannot express at all.
section('GLOB MATCHING — expressiveness gap');
const GAP_CASES = [
    ['**/*.{ts,tsx}', 'src/app.tsx', 'brace expansion'],
    ['src/[a-c]*.ts', 'src/app.ts', 'character class'],
    ['!(node_modules)/**', 'src/app.ts', 'extglob negation'],
    ['**/*.ts', 'src/app.ts', 'control (supported by both)'],
];
for (const [pattern, candidate, label] of GAP_CASES) {
    let customResult;
    try {
        customResult = normalizePattern(pattern).test(candidate);
    } catch (error) {
        customResult = `throw: ${error.message}`;
    }
    const picoResult = picomatch(pattern, { dot: true, nocase: true })(candidate);
    console.log(`  ${label.padEnd(28)} "${pattern}" vs "${candidate}"  custom=${String(customResult).padEnd(6)} picomatch=${picoResult}`);
}

// ------------------------------------------------------------ benchmarks ----
section('GLOB MATCHING — compile cost (build a matcher from the default exclude set)');
report('compile matcher (4 exclude patterns)', [
    {
        name: 'custom (patterns.ts)',
        baseline: true,
        ...(await measure(() => { for (let i = 0; i < 100; i += 1) createPatternMatcher(EXCLUDE_PATTERNS, false); }, { innerOps: 100 })),
    },
    {
        name: 'picomatch',
        ...(await measure(() => { for (let i = 0; i < 100; i += 1) picomatch(EXCLUDE_PATTERNS, { dot: true, nocase: true }); }, { innerOps: 100 })),
    },
    {
        name: 'minimatch',
        ...(await measure(() => {
            for (let i = 0; i < 100; i += 1) EXCLUDE_PATTERNS.map((p) => new minimatch.Minimatch(p, { dot: true, nocase: true }));
        }, { innerOps: 100 })),
    },
]);

section('GLOB MATCHING — match throughput (pre-compiled matcher, per path tested)');

async function matchBench(patterns, label) {
    const custom = createPatternMatcher(patterns, false);
    const pico = picomatch(expandPatterns(patterns), { dot: true, nocase: true });
    const mm = expandPatterns(patterns).map((p) => new minimatch.Minimatch(p, { dot: true, nocase: true }));

    // Sequential: concurrent measure() calls would interleave their timed regions.
    const a = await measure(() => { let n = 0; for (const c of CORPUS) if (custom(c)) n += 1; return n; }, { innerOps: CORPUS.length });
    const b = await measure(() => { let n = 0; for (const c of CORPUS) if (pico(c)) n += 1; return n; }, { innerOps: CORPUS.length });
    const c = await measure(() => { let n = 0; for (const p of CORPUS) if (mm.some((m) => m.match(p))) n += 1; return n; }, { innerOps: CORPUS.length });

    return report(label, [
        { name: 'custom (patterns.ts)', baseline: true, ...a },
        { name: 'picomatch', ...b },
        { name: 'minimatch', ...c },
    ], { unit: 'path' });
}

await matchBench(EXCLUDE_PATTERNS, 'exclude set (4 patterns)');
await matchBench(INCLUDE_PATTERNS, 'include set (1 pattern: **/*)');
await matchBench(USER_PATTERNS, 'user-style set (5 patterns)');

console.log(`\ntotal parity disagreements: ${totalMismatch}`);
