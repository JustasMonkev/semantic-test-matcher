import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    canonicalizeToken,
    diceCoefficient,
    overlapCoefficient,
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
        assert.equal(canonicalizeToken('CLIs'), 'cli');
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
        assert.deepEqual(tokenizeText('parseUris'), ['parse', 'uri']);
        assert.deepEqual(tokenizeText('parseClis'), ['parse', 'cli']);
        assert.deepEqual(tokenizeText('parseApis'), tokenizeText('parseApi'));
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
