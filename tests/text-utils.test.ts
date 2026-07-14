import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    canonicalizeToken,
    diceCoefficient,
    normalizeVector,
    overlapCoefficient,
    textToVector,
    tokenizeText,
    uniqueTokens,
} from '../src/services/text-utils.ts';

describe('canonicalizeToken', () => {
    it('lowercases and strips non-alphanumerics', () => {
        assert.equal(canonicalizeToken('Price-Engine!'), 'priceengine');
    });

    it('rejects short, numeric, and stop-word tokens', () => {
        assert.equal(canonicalizeToken('a'), null);
        assert.equal(canonicalizeToken('1234'), null);
        assert.equal(canonicalizeToken('function'), null);
    });

    it('keeps stop words when skipStopWords is set', () => {
        assert.equal(canonicalizeToken('function', { skipStopWords: true }), 'function');
    });

    it('singularizes plural forms', () => {
        assert.equal(canonicalizeToken('categories'), 'category');
        assert.equal(canonicalizeToken('discounts'), 'discount');
        assert.equal(canonicalizeToken('classes'), 'class');
        assert.equal(canonicalizeToken('menus'), 'menu');
        assert.equal(canonicalizeToken('URIs'), 'uri');
    });

    it('does not strip s from singular words ending in us or is', () => {
        assert.equal(canonicalizeToken('status'), 'status');
        assert.equal(canonicalizeToken('focus'), 'focus');
        assert.equal(canonicalizeToken('campus'), 'campus');
        assert.equal(canonicalizeToken('analysis'), 'analysis');
    });
});

describe('tokenizeText', () => {
    it('splits camelCase, snake_case, and path separators', () => {
        assert.deepEqual(tokenizeText('applyDiscount'), ['apply', 'discount']);
        assert.deepEqual(tokenizeText('coupon_validator'), ['coupon', 'validator']);
        assert.deepEqual(tokenizeText('checkout/pricing'), ['checkout', 'pricing']);
    });

    it('drops stop words and empty parts', () => {
        assert.deepEqual(tokenizeText('the price of the order'), ['price', 'order']);
    });
});

describe('uniqueTokens', () => {
    it('deduplicates while preserving order', () => {
        assert.deepEqual(uniqueTokens(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c']);
    });
});

describe('overlapCoefficient', () => {
    it('returns 0 for empty inputs', () => {
        assert.equal(overlapCoefficient([], ['x']), 0);
        assert.equal(overlapCoefficient(['x'], []), 0);
    });

    it('returns 1 when the smaller set is fully contained', () => {
        assert.equal(overlapCoefficient(['a', 'b'], ['a', 'b', 'c', 'd']), 1);
    });

    it('scores partial overlap against the smaller set', () => {
        assert.equal(overlapCoefficient(['a', 'b'], ['a', 'c', 'd']), 0.5);
    });
});

describe('diceCoefficient', () => {
    it('scores shared tokens against both set sizes', () => {
        assert.equal(diceCoefficient(['a', 'b'], ['a', 'c']), 0.5);
        assert.equal(diceCoefficient(['a'], ['a']), 1);
        assert.equal(diceCoefficient(['a'], ['b']), 0);
    });
});

describe('normalizeVector', () => {
    it('scales a vector to unit length', () => {
        const normalized = normalizeVector([3, 4]);
        assert.ok(Math.abs(normalized[0] - 0.6) < 1e-12);
        assert.ok(Math.abs(normalized[1] - 0.8) < 1e-12);
    });

    it('returns zero vectors unchanged', () => {
        assert.deepEqual(normalizeVector([0, 0, 0]), [0, 0, 0]);
    });
});

describe('textToVector', () => {
    it('is deterministic for the same input', () => {
        assert.deepEqual(textToVector('checkout pricing logic'), textToVector('checkout pricing logic'));
    });

    it('produces unit-length vectors of the requested dimension', () => {
        const vector = textToVector('coupon validation edge cases', 128);
        assert.equal(vector.length, 128);
        const magnitude = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
        assert.ok(Math.abs(magnitude - 1) < 1e-9);
    });

    it('gives similar texts closer vectors than unrelated texts', () => {
        const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
        const source = textToVector('discount and tax calculation');
        const related = textToVector('tax calculation for discounts');
        const unrelated = textToVector('websocket reconnect heartbeat');
        assert.ok(dot(source, related) > dot(source, unrelated));
    });
});
