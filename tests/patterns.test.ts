import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPatternMatcher, isParentPath, normalizePattern } from '../src/utils/patterns.ts';

describe('normalizePattern', () => {
    it('supports ** across directories', () => {
        const regex = normalizePattern('**/dist/**');
        assert.ok(regex.test('packages/app/dist/index.js'));
        assert.ok(!regex.test('packages/app/src/index.js'));
    });

    it('limits single * to one path segment', () => {
        const regex = normalizePattern('src/*.ts');
        assert.ok(regex.test('src/config.ts'));
        assert.ok(!regex.test('src/utils/io.ts'));
    });

    it('anchors bare names to any directory', () => {
        const regex = normalizePattern('*.test.ts');
        assert.ok(regex.test('a.test.ts'));
        assert.ok(regex.test('deep/nested/a.test.ts'));
        assert.ok(!regex.test('deep/nested/a.test.tsx'));
    });

    it('supports ? as a single character and comma-separated lists', () => {
        const regex = normalizePattern('file?.ts, other.ts');
        assert.ok(regex.test('file1.ts'));
        assert.ok(regex.test('nested/other.ts'));
        assert.ok(!regex.test('file12.ts'));
    });
});

describe('createPatternMatcher', () => {
    it('returns the empty result when no patterns are given', () => {
        assert.equal(createPatternMatcher([], true)('anything'), true);
        assert.equal(createPatternMatcher(undefined, false)('anything'), false);
    });

    it('matches when any pattern matches', () => {
        const matcher = createPatternMatcher(['**/*.ts', '**/*.tsx']);
        assert.ok(matcher('src/app.tsx'));
        assert.ok(!matcher('src/app.css'));
    });

    it('normalizes Windows separators in candidates', () => {
        const matcher = createPatternMatcher(['src/**/*.ts']);
        assert.ok(matcher('src\\utils\\io.ts'));
    });
});

describe('isParentPath', () => {
    it('accepts contained paths and the base itself', () => {
        assert.ok(isParentPath('/repo', '/repo/src/index.ts'));
        assert.ok(isParentPath('/repo', '/repo'));
    });

    it('rejects paths outside the base', () => {
        assert.ok(!isParentPath('/repo', '/repo/../secrets'));
        assert.ok(!isParentPath('/repo', '/other'));
    });
});
