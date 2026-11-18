import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

it('keeps empty JSON and newline stdin lists empty without requiring a provider', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-empty-input-'));
    try {
        await fs.mkdir(path.join(cwd, 'tests'));
        await fs.writeFile(path.join(cwd, 'source.ts'), 'export const price = 1;');
        await fs.writeFile(path.join(cwd, 'tests/price.test.ts'), "test('price', () => {});");
        const cli = new URL('../src/cli.ts', import.meta.url);
        for (const input of ['[]', '\n']) {
            const result = spawnSync(process.execPath, [
                '--experimental-strip-types', fileURLToPath(cli), 'match', 'source.ts',
                '--candidates-from-stdin', '--fallback-ranker', 'none', '--paths-only',
            ], { cwd, input, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', JEF: '' } });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout.trim(), '');
        }
    } finally {
        await fs.rm(cwd, { recursive: true, force: true });
    }
});
