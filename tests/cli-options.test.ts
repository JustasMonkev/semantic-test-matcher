import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('global options next to subcommand options', () => {
    let root: string;

    async function rbt(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        const env = { ...process.env };
        for (const name of ['TYPESAFE_API_KEY', 'JEF', 'OPENAI_API_KEY', 'OPEN_AI', 'RBT_RANKER', 'RBT_FALLBACK_RANKER', 'RBT_QUIET']) {
            delete env[name];
        }
        try {
            const { stdout, stderr } = await execFileAsync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args], { cwd: root, env });
            return { code: 0, stdout, stderr };
        } catch (error) {
            const failure = error as { code: number; stdout: string; stderr: string };
            return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
        }
    }

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-cli-options-'));
        await fs.mkdir(path.join(root, 'src'));
        await fs.mkdir(path.join(root, 'e2e'));
        await fs.mkdir(path.join(root, 'tests'));
        await fs.writeFile(path.join(root, 'src/price.ts'), 'export function applyDiscount(total: number) { return total * 0.9; }');
        await fs.writeFile(path.join(root, 'e2e/price.test.ts'), "import { applyDiscount } from '../src/price'; test('discount', () => applyDiscount(1));");
        await fs.writeFile(path.join(root, 'tests/other.test.ts'), "test('other', () => {});");
        await fs.writeFile(path.join(root, 'quiet.json'), JSON.stringify({ ranker: 'heuristics', quiet: true }));
    });

    it('reads -c after match as a candidate path, even when repeated', async () => {
        const single = await rbt('match', 'src/price.ts', '-c', 'e2e', '--ranker', 'heuristics', '--paths-only');
        assert.equal(single.code, 0, single.stderr);
        assert.equal(single.stdout.trim(), 'e2e/price.test.ts');
        const repeated = await rbt('match', 'src/price.ts', '-c', 'e2e', '-c', 'tests', '--ranker', 'heuristics', '--json');
        assert.equal(repeated.code, 0, repeated.stderr);
        assert.equal(JSON.parse(repeated.stdout).candidateCount, 2);
    });

    it('reads -c before the subcommand, and after status, as the config file', async () => {
        const beforeMatch = await rbt('-c', 'quiet.json', 'match', 'src/price.ts', '-c', 'e2e');
        assert.equal(beforeMatch.code, 0, beforeMatch.stderr);
        assert.match(beforeMatch.stdout, /^\d\.\d{4} e2e\/price\.test\.ts\n$/);
        const status = await rbt('status', '-c', 'quiet.json', '--json');
        assert.equal(JSON.parse(status.stdout).ranker, 'heuristics');
    });

    it('still accepts --config, --quiet, and --log-level after the subcommand', async () => {
        const result = await rbt('match', 'src/price.ts', '-c', 'e2e', '--config', 'quiet.json', '--log-level', 'warn');
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /^\d\.\d{4} e2e\/price\.test\.ts\n$/);
        const quiet = await rbt('match', 'src/price.ts', '-c', 'e2e', '--ranker', 'heuristics', '-q');
        assert.match(quiet.stdout, /^\d\.\d{4} e2e\/price\.test\.ts\n$/);
    });

    it('fails on a missing --config file and on a non-numeric --top-k', async () => {
        const missingConfig = await rbt('--config', 'nope.json', 'status');
        assert.equal(missingConfig.code, 1);
        assert.match(missingConfig.stderr, /Config file not found: nope\.json/);
        const badTopK = await rbt('match', 'src/price.ts', '-c', 'e2e', '--ranker', 'heuristics', '--top-k', 'abc');
        assert.equal(badTopK.code, 1);
        assert.match(badTopK.stderr, /Invalid --top-k "abc"\. Expected a number\./);
    });
});
