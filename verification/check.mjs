import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocumentProfile } from '../src/services/document-profile.ts';
import { selectRepresentatives } from '../src/services/representative-selection.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), 'representative-lean-'));
const cases = [];
// Exhaust every ordered profile list over a two-token universe, up to four
// candidates. Distances are 0, 1/2 or 1: exact in both Nat/2 and binary64.
const vocabulary = [[], ['a'], ['b'], ['a', 'b']];
for (let count = 0; count <= 4; count += 1) {
    for (let encoded = 0; encoded < 4 ** count; encoded += 1) {
        const tokens = Array.from({ length: count }, (_, index) => vocabulary[Math.floor(encoded / 4 ** index) % 4]);
        const matrix = tokens.map(left => tokens.map(right => {
            const union = new Set([...left, ...right]).size;
            const intersection = left.filter(token => right.includes(token)).length;
            return union === 0 ? 0 : 2 * (union - intersection) / union;
        }));
        for (let budget = 1; budget <= count + 1; budget += 1) {
            cases.push({ tokens, matrix, budget });
        }
    }
}

try {
    const output = execFileSync('lean', ['-DwarningAsError=true', '-o', path.join(directory, 'Selection.olean'), 'verification/Selection.lean'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.doesNotMatch(output, /sorryAx|Lean\.ofReduceBool|Lean\.trustCompiler/);
    process.stdout.write(output);
    const source = 'import Selection\n' + cases.map(({ matrix, budget }) =>
        '#eval Representative.run ' + JSON.stringify(matrix) + ' 2 ' + budget
    ).join('\n') + '\n';
    const fixtures = path.join(directory, 'Fixtures.lean');
    writeFileSync(fixtures, source);
    const results = execFileSync('lean', ['-DwarningAsError=true', fixtures], {
        cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LEAN_PATH: directory },
    }).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(results.length, cases.length);
    for (const [index, { tokens, matrix, budget }] of cases.entries()) {
        const matches = tokens.map((_, id) => ({
            file: 'candidate-' + id + '.test.ts', score: 1, preview: '', structuralScore: 0,
            stemScore: 0, basenameScore: 0, semanticScore: 0, anchorScore: 0,
            interfaceScore: 0, phraseScore: 0, pathFamilyScore: 0, changeScore: 0,
        }));
        const profiles = new Map(matches.map((match, id) => [match.file, {
            ...buildDocumentProfile('/repo/' + match.file, '', '/repo'),
            testNames: tokens[id], imports: [], commandTokens: [], optionTokens: [],
            lateCallTokens: [], contentTokens: [],
        }]));
        // Reverse the input to exercise production's relevance/path sorting.
        const actual = selectRepresentatives([...matches].reverse(), profiles, budget);
        const ids = actual.results.map(match => matches.findIndex(candidate => candidate.file === match.file));
        const label = 'case ' + index + ': ' + JSON.stringify({ tokens, budget });
        assert.deepEqual(ids, results[index], label);
        assert.equal(ids.length, Math.min(budget, tokens.length), label);
        assert.equal(new Set(ids).size, ids.length, label);
        const objective = matrix.reduce((sum, row) =>
            sum + Math.min(2, ...ids.map(id => row[id])) / 2, 0);
        assert.equal(actual.selectionObjective.value, objective, label);
    }
    console.log('Lean differential checks passed: ' + cases.length + ' cases.');
} catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
} finally {
    rmSync(directory, { recursive: true, force: true });
}
