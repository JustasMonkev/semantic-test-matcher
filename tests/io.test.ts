import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDebug, parseStdinList, readStdinText } from '../src/utils/io.ts';

describe('readStdinText', () => {
    it('resolves empty immediately on an interactive terminal instead of blocking', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        try {
            assert.equal(await readStdinText(), '');
        } finally {
            if (descriptor) {
                Object.defineProperty(process.stdin, 'isTTY', descriptor);
            } else {
                Reflect.deleteProperty(process.stdin, 'isTTY');
            }
        }
    });
});

describe('isDebug', () => {
    it('is enabled only by RBT_DEBUG=1', () => {
        const saved = process.env.RBT_DEBUG;
        try {
            for (const [value, expected] of [['1', true], ['0', false], ['true', false], ['', false]] as const) {
                process.env.RBT_DEBUG = value;
                assert.equal(isDebug(), expected, `RBT_DEBUG=${JSON.stringify(value)}`);
            }
            delete process.env.RBT_DEBUG;
            assert.equal(isDebug(), false);
        } finally {
            if (saved === undefined) {
                delete process.env.RBT_DEBUG;
            } else {
                process.env.RBT_DEBUG = saved;
            }
        }
    });
});

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

    it('treats a JSON object as a plain list', () => {
        assert.deepEqual(parseStdinList('{"file":"tests/a.ts"}'), ['{"file":"tests/a.ts"}']);
    });

    it('handles CRLF line endings', () => {
        assert.deepEqual(parseStdinList('tests/a.ts\r\ntests/b.ts\r\n'), ['tests/a.ts', 'tests/b.ts']);
    });

    it('drops blank and whitespace-only lines', () => {
        assert.deepEqual(parseStdinList('tests/a.ts\n\n   \n\ttests/b.ts\n'), ['tests/a.ts', 'tests/b.ts']);
    });

    it('returns an empty list for an empty JSON array', () => {
        assert.deepEqual(parseStdinList('[]'), []);
    });

    it('stringifies non-string JSON array members', () => {
        assert.deepEqual(parseStdinList('[1, "tests/a.ts", null]'), ['1', 'tests/a.ts', 'null']);
    });

    it('keeps paths containing spaces intact', () => {
        assert.deepEqual(parseStdinList('tests/my dir/a.ts\n'), ['tests/my dir/a.ts']);
    });

    it('keeps a single line without a trailing newline', () => {
        assert.deepEqual(parseStdinList('tests/a.ts'), ['tests/a.ts']);
    });

    it('handles a large list', () => {
        const files = Array.from({ length: 5000 }, (_, index) => `tests/file-${index}.test.ts`);

        assert.deepEqual(parseStdinList(files.join('\n')), files);
    });
});
