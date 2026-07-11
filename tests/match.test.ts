import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cosineSimilarity, filterMatches, rankMatches, type RankedMatchCandidate } from '../src/services/match.ts';
import { buildDocumentProfile } from '../src/services/document-profile.ts';
import { textToVector } from '../src/services/text-utils.ts';

const PRICE_ENGINE_SOURCE = `
export function applyDiscount(order: Order, coupon: Coupon): number {
    return order.total - coupon.amount;
}

export function calculateTax(order: Order, region: Region): number {
    return order.total * region.taxRate;
}
`;

const PRICE_ENGINE_TEST = `
import { applyDiscount, calculateTax } from '../src/price-engine.ts';

describe('price engine', () => {
    it('applies coupon discounts to the order total', () => {
        expect(applyDiscount(order, coupon)).toBe(90);
    });

    it('calculates regional tax for the order', () => {
        expect(calculateTax(order, region)).toBeCloseTo(8.25);
    });
});
`;

const UNRELATED_TEST = `
import { reconnectSocket } from '../src/socket-client.ts';

describe('socket client', () => {
    it('reconnects after a heartbeat timeout', () => {
        expect(reconnectSocket(session)).toBe(true);
    });
});
`;

function makeCandidate(file: string, text: string, cwd: string): RankedMatchCandidate {
    const profile = buildDocumentProfile(`${cwd}/${file}`, text, cwd);
    return {
        file,
        vector: textToVector(profile.embeddingText),
        preview: profile.preview,
        profile,
    };
}

describe('cosineSimilarity', () => {
    it('returns 1 for identical unit vectors and 0 for orthogonal ones', () => {
        assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
        assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    });

    it('rejects empty and mismatched-length vectors', () => {
        assert.equal(cosineSimilarity([], [1, 2]), 0);
        assert.equal(cosineSimilarity([1, 0, 0.5], [1, 0]), 0);
    });
});

describe('rankMatches', () => {
    const cwd = '/repo';
    const sourceProfile = buildDocumentProfile(`${cwd}/src/price-engine.ts`, PRICE_ENGINE_SOURCE, cwd);
    const source = { profile: sourceProfile, vector: textToVector(sourceProfile.embeddingText) };

    it('ranks the related test above an unrelated test', () => {
        const matches = rankMatches(source, [
            makeCandidate('tests/socket-client.test.ts', UNRELATED_TEST, cwd),
            makeCandidate('tests/price-engine.test.ts', PRICE_ENGINE_TEST, cwd),
        ]);

        assert.equal(matches[0].file, 'tests/price-engine.test.ts');
        assert.ok(matches[0].score > matches[1].score);
    });

    it('separates a related test from an unrelated test at the default threshold', () => {
        const matches = rankMatches(source, [
            makeCandidate('tests/socket-client.test.ts', UNRELATED_TEST, cwd),
            makeCandidate('tests/price-engine.test.ts', PRICE_ENGINE_TEST, cwd),
        ]);

        assert.deepEqual(filterMatches(matches, 0.45).map((match) => match.file), [
            'tests/price-engine.test.ts',
        ]);
    });

    it('returns scores and component scores within [0, 1]', () => {
        const matches = rankMatches(source, [
            makeCandidate('tests/price-engine.test.ts', PRICE_ENGINE_TEST, cwd),
        ]);

        const [match] = matches;
        for (const value of [match.score, match.structuralScore, match.anchorScore, match.phraseScore]) {
            assert.ok(value >= 0 && value <= 1, `score out of range: ${value}`);
        }
    });

    it('breaks score ties by file name for stable output', () => {
        const candidateA = makeCandidate('tests/a.test.ts', UNRELATED_TEST, cwd);
        const candidateB = { ...candidateA, file: 'tests/b.test.ts' };
        const matches = rankMatches(source, [candidateB, candidateA]);
        assert.deepEqual(matches.map((match) => match.file), ['tests/a.test.ts', 'tests/b.test.ts']);
    });

    it('returns an empty list for no candidates', () => {
        assert.deepEqual(rankMatches(source, []), []);
    });
});
