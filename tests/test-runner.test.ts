import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { detectTestCommand, quoteShellArgument, runSelectedTests } from '../src/services/test-runner.ts';

describe('selected test execution', () => {
    let root: string;
    let command: string;

    beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-runner-')));
        await fs.writeFile(path.join(root, 'runner script.mjs'), [
            "import fs from 'node:fs';",
            "fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));",
            "process.exitCode = Number(process.env.RBT_FIXTURE_EXIT ?? 0);",
        ].join('\n'));
        command = `"${process.execPath}" "runner script.mjs"`;
    });

    afterEach(async () => {
        delete process.env.RBT_FIXTURE_EXIT;
        await fs.rm(root, { recursive: true, force: true });
    });

    it('appends deduplicated paths as separate arguments and does not evaluate shell syntax', async () => {
        const files = ['tests/a b.test.ts', 'tests/$(touch injected).test.ts', 'tests/a b.test.ts', '-option.test.ts'];
        const status = await runSelectedTests(`${command} --flag 'two words' ""`, files, root);
        assert.equal(status, 0);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'args.json'), 'utf8')), [
            '--flag', 'two words', '', path.join(root, files[0]), path.join(root, files[1]), path.join(root, files[3]),
        ]);
        await assert.rejects(fs.stat(path.join(root, 'injected')), { code: 'ENOENT' });
    });

    it('preserves a failing runner exit status and removes signal listeners', async () => {
        process.env.RBT_FIXTURE_EXIT = '7';
        const interrupts = process.listenerCount('SIGINT');
        const terminations = process.listenerCount('SIGTERM');
        assert.equal(await runSelectedTests(command, ['tests/price.test.ts'], root), 7);
        assert.equal(process.listenerCount('SIGINT'), interrupts);
        assert.equal(process.listenerCount('SIGTERM'), terminations);
    });

    it('does not pass the Jev API key to the test runner', async () => {
        await fs.writeFile(path.join(root, 'env.mjs'), [
            "import fs from 'node:fs';",
            "fs.writeFileSync('env.json', JSON.stringify({ key: process.env.TYPESAFE_API_KEY ?? null, path: Boolean(process.env.PATH) }));",
        ].join('\n'));
        const savedKey = process.env.TYPESAFE_API_KEY;
        process.env.TYPESAFE_API_KEY = 'secret-key';
        try {
            assert.equal(await runSelectedTests(`"${process.execPath}" env.mjs`, ['tests/price.test.ts'], root), 0);
        } finally {
            if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
            else process.env.TYPESAFE_API_KEY = savedKey;
        }
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'env.json'), 'utf8')), { key: null, path: true });
        assert.equal(process.env.TYPESAFE_API_KEY, savedKey);
    });

    it('never launches a command with an empty selection', async () => {
        assert.equal(await runSelectedTests(command, [], root), 0);
        await assert.rejects(fs.stat(path.join(root, 'args.json')), { code: 'ENOENT' });
    });

    it('rejects invalid commands and missing executables', async () => {
        for (const invalid of ['', '""', '"unterminated']) {
            await assert.rejects(runSelectedTests(invalid, ['tests/price.test.ts'], root));
        }
        await assert.rejects(runSelectedTests('rbt-nonexistent-test-executable', ['tests/price.test.ts'], root), { code: 'ENOENT' });
    });

    it('reports signal termination as a nonzero exit', async () => {
        await fs.writeFile(path.join(root, 'signal.mjs'), "process.kill(process.pid, 'SIGTERM');");
        const status = await runSelectedTests(`"${process.execPath}" signal.mjs`, ['test.ts'], root);
        assert.equal(status, 128 + os.constants.signals.SIGTERM);
    });
});

describe('test command detection', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-detect-'));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    const detect = async (manifest: {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    }) => {
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
        return detectTestCommand(root);
    };

    it('reuses the test script, keeping its flags', async () => {
        assert.equal(await detect({ scripts: { test: 'vitest run' } }), 'npx vitest run');
        assert.equal(await detect({ scripts: { test: 'jest --ci' } }), 'npx jest --ci');
        assert.equal(
            await detect({ scripts: { test: 'playwright test --config=tests/library/playwright.config.ts' } }),
            'npx playwright test --config=tests/library/playwright.config.ts'
        );
    });

    it('runs Vitest once instead of starting watch mode', async () => {
        assert.equal(await detect({ scripts: { test: 'vitest' } }), 'npx vitest run');
        assert.equal(await detect({ scripts: { test: 'vitest --coverage' } }), 'npx vitest run --coverage');
    });

    it('prefers the test script over installed runners', async () => {
        assert.equal(
            await detect({ scripts: { test: 'vitest run' }, dependencies: { playwright: '1' }, devDependencies: { jest: '1' } }),
            'npx vitest run'
        );
    });

    it('falls back to an installed runner when the script cannot take file arguments', async () => {
        assert.equal(await detect({ scripts: { test: 'tsc && vitest run' }, devDependencies: { vitest: '1' } }), 'npx vitest run');
        assert.equal(await detect({ devDependencies: { '@playwright/test': '1' } }), 'npx playwright test');
        assert.equal(await detect({ devDependencies: { mocha: '1' } }), 'npx mocha');
    });

    it('does not reuse a script that already selects test paths', async () => {
        assert.equal(await detect({ scripts: { test: "mocha 'tests/**/*.test.js'" }, devDependencies: { mocha: '1' } }), 'npx mocha');
        assert.equal(await detect({ scripts: { test: 'jest tests' }, devDependencies: { jest: '1' } }), 'npx jest');
        assert.equal(
            await detect({ scripts: { test: 'playwright test tests/e2e' }, devDependencies: { '@playwright/test': '1' } }),
            'npx playwright test'
        );
        assert.equal(await detect({ scripts: { test: 'vitest run src' } }), undefined);
    });

    it('gives no guess when the runner is unknown or package.json is missing or invalid', async () => {
        assert.equal(await detect({ scripts: { test: 'node --test "tests/**/*.test.ts"' } }), undefined);
        assert.equal(await detect({ scripts: { test: 'vitest run $FILTER' } }), undefined);
        await fs.writeFile(path.join(root, 'package.json'), '{');
        assert.equal(await detectTestCommand(root), undefined);
        await fs.rm(path.join(root, 'package.json'));
        assert.equal(await detectTestCommand(root), undefined);
    });
});

describe('quoteShellArgument', () => {
    it('leaves plain paths alone and quotes anything a shell would interpret', () => {
        assert.equal(quoteShellArgument('tests/a-b_c.test.ts'), 'tests/a-b_c.test.ts');
        assert.equal(quoteShellArgument('tests/a b.test.ts'), "'tests/a b.test.ts'");
        assert.equal(quoteShellArgument('tests/$(touch x).ts'), "'tests/$(touch x).ts'");
        assert.equal(quoteShellArgument("tests/it's.ts"), "'tests/it'\\''s.ts'");
    });
});
