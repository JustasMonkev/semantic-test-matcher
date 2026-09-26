import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { interleaveUniqueTokens, mergeArrays } from '../src/utils/arrays.ts';

describe('mergeArrays', () => {
    it('keeps the populated array unchanged when the other is empty', () => {
        const values = ['a', 'a'];
        assert.equal(mergeArrays([], values), values);
        assert.equal(mergeArrays(values), values);
        assert.deepEqual(mergeArrays(), []);
    });

    it('merges in order without duplicates or input mutation', () => {
        const left = ['a', 'b', 'a'];
        const right = ['b', 'c'];
        assert.deepEqual(mergeArrays(left, right), ['a', 'b', 'c']);
        assert.deepEqual(left, ['a', 'b', 'a']);
        assert.deepEqual(right, ['b', 'c']);
    });
});

describe('interleaveUniqueTokens', () => {
    it('takes turns across uneven groups and skips duplicates before applying the limit', () => {
        const groups = [['a', 'b', 'c'], ['a', 'd'], [], ['e']];
        assert.deepEqual(interleaveUniqueTokens(groups, 4), ['a', 'e', 'b', 'd']);
        assert.deepEqual(interleaveUniqueTokens(groups, 20), ['a', 'e', 'b', 'd', 'c']);
    });

    it('handles empty groups and a zero limit', () => {
        assert.deepEqual(interleaveUniqueTokens([], 3), []);
        assert.deepEqual(interleaveUniqueTokens([[], []], 3), []);
        assert.deepEqual(interleaveUniqueTokens([['a']], 0), []);
    });
});
