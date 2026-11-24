import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDocumentProfile } from '../src/services/document-profile.ts';
import type { MatchCandidate } from '../src/services/match.ts';
import { selectRepresentatives } from '../src/services/representative-selection.ts';

function fixture(entries: Array<[string, number, string[]]>) {
    const matches: MatchCandidate[] = entries.map(([file, score]) => ({
        file, score, preview: '', structuralScore: score, stemScore: 0, basenameScore: 0,
        semanticScore: 0, anchorScore: 0, interfaceScore: 0, phraseScore: 0, pathFamilyScore: 0, changeScore: 0,
    }));
    const profiles = new Map(entries.map(([file, , testNames]) => [file, {
        ...buildDocumentProfile(`/repo/${file}`, '', '/repo'), testNames,
    }]));
    return (topK: number | undefined) => selectRepresentatives(matches, profiles, topK);
}

describe('representative selection', () => {
    it('chooses the medoid by summed nearest Jaccard distances, ahead of relevance', () => {
        const select = fixture([
            ['left.test.ts', 0.9, ['left']],
            ['right.test.ts', 0.8, ['right']],
            ['middle.test.ts', 0.1, ['left', 'right']],
        ]);
        const result = select(1);
        assert.deepEqual(result.results.map((match) => match.file), ['middle.test.ts']);
        assert.equal(result.selectionObjective.value, 1);
        assert.equal(result.eligibleCount, 3);
        assert.equal(result.selectionLimit, 1);
        assert.equal(result.selectionTruncated, true);
        assert.equal(result.selectionObjective.metric, 'jaccard');
    });

    it('matches dense row sums exactly for single representatives with fractional distances and ties', () => {
        const vocabulary = ['a', 'b', 'c', 'd', 'e'];
        let seed = 43;
        function nextMask(): number {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed >>> 27;
        }
        for (let size = 2; size <= 24; size += 1) {
            const entries: Array<[string, number, string[]]> = Array.from({ length: size }, (_, index) => {
                const mask = nextMask();
                return [`test-${String(index).padStart(2, '0')}.ts`, 1, vocabulary.filter((_, bit) => mask & (1 << bit))];
            });
            // Input order is reversed; ties must go to the first path in the original sorted order.
            const result = fixture([...entries].reverse())(1);
            const costs = entries.map(([, , left]) => entries.reduce((cost, [, , right]) => {
                const union = new Set([...left, ...right]).size;
                const shared = left.filter((token) => right.includes(token)).length;
                return cost + (union === 0 ? 0 : 1 - shared / union);
            }, 0));
            const minimum = Math.min(...costs);
            assert.equal(result.selectionObjective.value, minimum, `objective for size ${size}`);
            assert.deepEqual(result.results.map((match) => match.file), [entries[costs.indexOf(minimum)][0]], `winner for size ${size}`);
        }
    });

    it('covers a second behaviour cluster instead of filling the budget with duplicates', () => {
        const result = fixture([
            ['alpha.test.ts', 0.9, ['alpha']],
            ['alpha-copy.test.ts', 0.8, ['alpha']],
            ['alpha-again.test.ts', 0.7, ['alpha']],
            ['beta.test.ts', 0.2, ['beta']],
            ['beta-copy.test.ts', 0.1, ['beta']],
        ])(2);
        assert.deepEqual(result.results.map((match) => match.file), ['alpha.test.ts', 'beta.test.ts']);
        assert.equal(result.selectionObjective.value, 0);
        assert.match(result.selectionWarning, /can miss relevant or failing tests/);
    });

    it('breaks equal objectives by relevance then path, regardless of input order', () => {
        const entries: Array<[string, number, string[]]> = [
            ['z.test.ts', 0.9, ['same']], ['b.test.ts', 1, ['same']], ['a.test.ts', 1, ['same']],
        ];
        for (const input of [entries, [...entries].reverse()]) {
            assert.deepEqual(fixture(input)(2).results.map((match) => match.file), ['a.test.ts', 'b.test.ts']);
        }
    });

    it('treats two empty token sets as distance zero and an empty/nonempty pair as one', () => {
        const select = fixture([
            ['a.test.ts', 1, []], ['b.test.ts', 0.9, []], ['c.test.ts', 0.8, ['value']],
        ]);
        assert.equal(select(1).selectionObjective.value, 1);
        assert.equal(select(1).selectionObjective.emptyProfileCount, 2);
        assert.deepEqual(select(2).results.map((match) => match.file), ['a.test.ts', 'c.test.ts']);
        assert.equal(select(2).selectionObjective.value, 0);
    });

    it('returns all candidates within the budget and handles no eligible candidates', () => {
        const all = fixture([['a.test.ts', 1, ['a']], ['b.test.ts', 0.5, ['b']]])(3);
        assert.equal(all.results.length, 2);
        assert.equal(all.selectionTruncated, false);
        assert.equal(all.selectionObjective.value, 0);
        const empty = fixture([])(1);
        assert.deepEqual(empty.results, []);
        assert.equal(empty.selectionObjective.value, 0);
        assert.equal(empty.selectionTruncated, false);
    });

    it('bounds behaviour profiles and reports truncation', () => {
        const values = Array.from({ length: 300 }, (_, index) => `token-${index}`);
        const result = fixture([['a.test.ts', 1, values], ['b.test.ts', 0.5, values]])(1);
        assert.equal(result.selectionObjective.tokenLimit, 256);
        assert.equal(result.selectionObjective.truncatedProfileCount, 2);
        assert.equal(result.selectionObjective.value, 0);
    });

    it('rejects invalid budgets and missing profiles at the service boundary', () => {
        for (const budget of [undefined, 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => fixture([])(budget), /explicit positive integer --top-k/);
        }
        const match: MatchCandidate = {
            file: 'missing.test.ts', score: 1, preview: '', structuralScore: 1, stemScore: 0, basenameScore: 0,
            semanticScore: 0, anchorScore: 0, interfaceScore: 0, phraseScore: 0, pathFamilyScore: 0, changeScore: 0,
        };
        assert.throws(() => selectRepresentatives([match], new Map(), 1), /Missing document profile/);
    });
});
