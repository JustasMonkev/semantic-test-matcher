import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectMatches, TARGETED_JEV_THRESHOLD, type MatchCandidate } from '../src/services/match.ts';

function candidate(file: string, score: number, jevScore?: number, structuralScore = score): MatchCandidate {
    return {
        file, score, jevScore, preview: file, structuralScore,
        stemScore: 0, basenameScore: 0, semanticScore: 0, anchorScore: 0,
        interfaceScore: 0, phraseScore: 0, pathFamilyScore: 0, changeScore: 0,
    };
}

describe('test selection policy', () => {
    const ranked = [
        candidate('structural-only.spec.ts', 0.9, 0.1),
        candidate('direct.spec.ts', 0.8, 0.95),
        candidate('another-structural.spec.ts', 0.7, 0.2),
        candidate('related-beyond-top-k.spec.ts', 0.6, 0.59),
    ];

    it('keeps conservative top-K by default', () => {
        assert.deepEqual(selectMatches(ranked, 2, 'conservative', 'jev').results.map(x => x.file), [
            'structural-only.spec.ts', 'direct.spec.ts',
        ]);
    });

    it('keeps all Jev-positive candidates, even those beyond the structural top-K', () => {
        assert.equal(TARGETED_JEV_THRESHOLD, 0.5);
        assert.deepEqual(selectMatches(ranked, 2, 'targeted', 'jev').results.map(x => x.file), [
            'direct.spec.ts', 'related-beyond-top-k.spec.ts',
        ]);
        assert.deepEqual(selectMatches([
            candidate('boundary.spec.ts', 0.9, 0.5),
            candidate('certain.spec.ts', 0.8, 1),
            candidate('also-certain.spec.ts', 0.7, 1),
        ], 2, 'targeted', 'jev').results.map(x => x.file), [
            'boundary.spec.ts', 'certain.spec.ts',
        ]);
    });

    it('falls back to conservative selection for uncertain Jev answers or a missing API', () => {
        const uncertain = ranked.map(x => ({ ...x, jevScore: 0.49 }));
        assert.deepEqual(selectMatches(uncertain, 2, 'targeted', 'jev').results.map(x => x.file), [
            'structural-only.spec.ts', 'direct.spec.ts',
        ]);
        assert.match(selectMatches(uncertain, 2, 'targeted', 'jev').reason ?? '', /No affirmative/);
        assert.deepEqual(selectMatches(ranked, 2, 'targeted', 'heuristics').results.map(x => x.file), [
            'structural-only.spec.ts', 'direct.spec.ts',
        ]);
    });

    it('ignores non-finite or out-of-range Jev scores', () => {
        const invalid = [
            candidate('nan.spec.ts', 0.9, Number.NaN),
            candidate('too-high.spec.ts', 0.8, 1.5),
            candidate('infinite.spec.ts', 0.7, Number.POSITIVE_INFINITY),
        ];
        assert.match(selectMatches(invalid, 2, 'targeted', 'jev').reason ?? '', /No affirmative/);
        const adaptive = selectMatches(invalid, undefined, 'adaptive', 'jev');
        assert.equal(adaptive.evidence?.affirmativeCount, 0);
        assert.match(adaptive.reason ?? '', /No strong Jev/);
    });

    it('selects Jev-positive tests and strong structural neighbors without a fixed count', () => {
        const matches = [
            candidate('direct.spec.ts', 0.8, 0.9, 0.25),
            candidate('neighbor.spec.ts', 0.6, 0.19, 0.33),
            candidate('another-positive.spec.ts', 0.55, 0.6, 0.12),
            candidate('unrelated.spec.ts', 0.2, 0.1, 0.08),
        ];
        const selection = selectMatches(matches, undefined, 'adaptive', 'jev');
        assert.deepEqual(selection.results.map(x => x.file), [
            'direct.spec.ts', 'neighbor.spec.ts', 'another-positive.spec.ts',
        ]);
        assert.deepEqual(selection.evidence && {
            affirmativeCount: selection.evidence.affirmativeCount,
            structuralNeighborCount: selection.evidence.structuralNeighborCount,
        }, { affirmativeCount: 2, structuralNeighborCount: 1 });
        assert.equal(selection.truncated, false);

        const capped = selectMatches(matches, 2, 'adaptive', 'jev');
        assert.equal(capped.eligibleCount, 3);
        assert.equal(capped.truncated, true);
        assert.deepEqual(capped.results.map(x => x.file), ['direct.spec.ts', 'neighbor.spec.ts']);
    });

    it('widens coverage when Jev is marginal or unavailable', () => {
        const weak = [
            candidate('a.spec.ts', 0.5, 0.51, 0.3),
            candidate('b.spec.ts', 0.4, 0.49, 0.29),
            candidate('c.spec.ts', 0.3, 0.1, 0.18),
            candidate('d.spec.ts', 0.2, 0.1, 0.17),
            candidate('e.spec.ts', 0.1, 0.1, 0.16),
            candidate('f.spec.ts', 0.09, 0.1, 0.15),
            candidate('g.spec.ts', 0.08, 0.1, 0.14),
            candidate('h.spec.ts', 0.07, 0.1, 0.13),
        ];
        const uncertain = selectMatches(weak, undefined, 'adaptive', 'jev');
        assert.deepEqual(uncertain.results.map(x => x.file), ['a.spec.ts', 'b.spec.ts']);
        assert.match(uncertain.reason ?? '', /structural coverage widened/);
        const offline = selectMatches(weak, undefined, 'adaptive', 'heuristics');
        assert.deepEqual(offline.results.map(x => x.file), ['a.spec.ts', 'b.spec.ts']);
        const noEvidence = weak.map(x => ({ ...x, structuralScore: 0.1, jevScore: 0.1 }));
        const broadFallback = selectMatches(noEvidence, undefined, 'adaptive', 'jev');
        assert.equal(broadFallback.results.length, weak.length);
        assert.equal(broadFallback.evidence?.structuralNeighborCount, 0);
        assert.equal(broadFallback.evidence?.uncertaintyRetainedCount, weak.length);
        assert.match(broadFallback.reason ?? '', /all candidates retained/);
    });

    it('uses Decisions model evidence for adaptive and targeted selection at the same boundaries', () => {
        const matches = [
            { ...candidate('neighbor.spec.ts', 0.95, undefined, 0.4), modelScore: 0.499 },
            { ...candidate('boundary.spec.ts', 0.8, undefined, 0.1), modelScore: 0.5 },
            { ...candidate('strong.spec.ts', 0.7, undefined, 0.1), modelScore: 0.7 },
            { ...candidate('unrelated.spec.ts', 0.1, undefined, 0.01), modelScore: 0.01 },
        ];
        assert.deepEqual(selectMatches(matches, undefined, 'adaptive', 'decisions').results.map(x => x.file), [
            'neighbor.spec.ts', 'boundary.spec.ts', 'strong.spec.ts',
        ]);
        assert.deepEqual(selectMatches(matches, undefined, 'targeted', 'decisions').results.map(x => x.file), [
            'boundary.spec.ts', 'strong.spec.ts',
        ]);
        assert.equal(selectMatches(matches, undefined, 'adaptive', 'decisions').reason, undefined);
        const marginal = matches.map(x => ({ ...x, modelScore: 0.699 }));
        assert.match(selectMatches(marginal, undefined, 'adaptive', 'decisions').reason ?? '', /coverage widened/);
    });

    it('expands selection as relevant evidence spreads across candidate files', () => {
        const narrow = Array.from({ length: 20 }, (_, index) =>
            candidate(`test-${index}.spec.ts`, 1 - index / 20, index === 0 ? 0.9 : 0.1, index === 0 ? 0.4 : 0.1)
        );
        const broad = narrow.map((item, index) => index < 6
            ? { ...item, jevScore: 0.8 }
            : item);
        assert.equal(selectMatches(narrow, undefined, 'adaptive', 'jev').results.length, 1);
        assert.equal(selectMatches(broad, undefined, 'adaptive', 'jev').results.length, 6);
    });
});
