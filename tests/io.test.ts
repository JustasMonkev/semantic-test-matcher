import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStdinList } from '../src/utils/io.ts';

describe('parseStdinList', () => {
    it('returns an empty list for blank input', () => {
        assert.deepEqual(parseStdinList(''), []);
        assert.deepEqual(parseStdinList('   \n  '), []);
    });

    it('parses a JSON array of paths', () => {
        assert.deepEqual(
            parseStdinList('["tests/a.ts", " tests/b.ts ", ""]'),
            ['tests/a.ts', 'tests/b.ts']
        );
    });

    it('falls back to newline-separated parsing for non-JSON input', () => {
        assert.deepEqual(
            parseStdinList('tests/a.ts\n  tests/b.ts  \n\n'),
            ['tests/a.ts', 'tests/b.ts']
        );
    });

    it('treats non-array JSON as a plain list', () => {
        assert.deepEqual(parseStdinList('"tests/a.ts"'), ['"tests/a.ts"']);
    });
});
