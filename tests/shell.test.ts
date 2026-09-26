import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandArguments, quoteShellArgument } from '../src/utils/shell.ts';

describe('commandArguments', () => {
    it('preserves empty arguments and literal shell syntax without expansion', () => {
        assert.deepEqual(commandArguments('runner "" \'\' "$HOME" ; |'), ['runner', '', '', '$HOME', ';', '|']);
    });

    it('round-trips quoted paths with spaces, quotes, and backslashes', () => {
        const paths = ['plain.ts', 'a b.ts', "it's.ts", 'a\\b.ts', '$(touch x).ts'];
        assert.deepEqual(commandArguments(`runner ${paths.map(quoteShellArgument).join(' ')}`), ['runner', ...paths]);
    });

    it('retains errors for missing executables and unclosed quotes', () => {
        assert.throws(() => commandArguments('  '), /A test executable is required/);
        assert.throws(() => commandArguments('"" arg'), /A test executable is required/);
        assert.throws(() => commandArguments('runner "oops'), /Unclosed quote in test command/);
    });
});
