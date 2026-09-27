import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstFiniteNumber, isProbability, parseBoolean, parseLogLevel, readEnv } from '../src/utils/values.ts';

describe('parseBoolean', () => {
    it('accepts true and the supported string forms', () => {
        for (const value of [true, '1', 'true', 'yes']) {
            assert.equal(parseBoolean(value), true);
        }
    });

    it('does not coerce other values or normalize strings', () => {
        for (const value of [false, '0', 'false', 'no', '', 'TRUE', ' true ', 'unknown', 1, 0, null, undefined, {}, []]) {
            assert.equal(parseBoolean(value), false);
        }
    });
});

describe('isProbability', () => {
    it('accepts only numbers in the inclusive unit interval', () => {
        for (const value of [0, 0.5, 1]) assert.equal(isProbability(value), true);
        for (const value of [-0.1, 1.1, NaN, Infinity, -Infinity, '0.5', null, undefined, false]) {
            assert.equal(isProbability(value), false);
        }
    });
});

describe('firstFiniteNumber', () => {
    it('skips unset, invalid, and non-finite values in precedence order', () => {
        assert.equal(firstFiniteNumber(undefined, null, '', ' ', 'oops', NaN, Infinity, -Infinity, '0.4', 0.8), 0.4);
        assert.equal(firstFiniteNumber(), undefined);
        assert.equal(firstFiniteNumber(null, '', 'oops', Infinity), undefined);
    });

    it('preserves zero and existing numeric coercion', () => {
        assert.equal(firstFiniteNumber(0, 5), 0);
        assert.equal(firstFiniteNumber('0', 5), 0);
        assert.equal(firstFiniteNumber(' 2 ', 5), 2);
        assert.equal(firstFiniteNumber(false, 5), 0);
        assert.equal(firstFiniteNumber(true, 5), 1);
    });
});

describe('readEnv', () => {
    it('treats missing and blank values as unset without trimming nonblank values', (t) => {
        const name = 'RBT_TEST_READ_ENV';
        const saved = process.env[name];
        t.after(() => {
            if (saved === undefined) delete process.env[name];
            else process.env[name] = saved;
        });

        delete process.env[name];
        assert.equal(readEnv(name), undefined);
        for (const value of ['', ' \t ']) {
            process.env[name] = value;
            assert.equal(readEnv(name), undefined);
        }
        for (const value of ['  debug  ', '0', 'false']) {
            process.env[name] = value;
            assert.equal(readEnv(name), value);
        }
    });
});

describe('parseLogLevel', () => {
    it('defaults blank values and normalizes supported levels', () => {
        assert.equal(parseLogLevel(), 'info');
        assert.equal(parseLogLevel(''), 'info');
        assert.equal(parseLogLevel(' \t '), 'info');
        assert.equal(parseLogLevel(' DEBUG '), 'debug');
        assert.equal(parseLogLevel('info'), 'info');
        assert.equal(parseLogLevel('Warn'), 'warn');
        assert.equal(parseLogLevel('error'), 'error');
    });

    it('rejects unsupported levels with the original input in the error', () => {
        assert.throws(() => parseLogLevel(' trace '), {
            message: 'Invalid log level " trace ". Expected "debug", "info", "warn", or "error".',
        });
    });
});
