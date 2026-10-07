import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerStatusCommand } from '../src/commands/status.ts';

describe('status provider configuration', () => {
    it('reports provider configuration and credential presence without disclosing keys or invoking APIs', async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-status-'));
        const originalCwd = process.cwd();
        const names = ['TYPESAFE_API_KEY', 'JEF', 'OPENAI_API_KEY', 'OPEN_AI', 'RBT_RANKER', 'RBT_FALLBACK_RANKER'];
        const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
        const output: string[] = [];
        t.mock.method(console, 'log', (value: unknown) => output.push(String(value)));
        t.mock.method(globalThis, 'fetch', async () => { throw new Error('status must not make remote requests'); });
        try {
            process.chdir(root);
            for (const name of names) delete process.env[name];
            process.env.JEF = 'fixture-jev-secret';
            process.env.OPEN_AI = 'fixture-openai-secret';
            await fs.writeFile('.rbtconfig', JSON.stringify({ ranker: 'decisions', decisionsModel: 'configured-model' }));
            const program = new Command();
            registerStatusCommand(program);
            await program.parseAsync(['status', '--json'], { from: 'user' });
            const status = JSON.parse(output[output.length - 1]);
            assert.equal(status.ranker, 'decisions');
            assert.equal(status.decisionsModel, 'configured-model');
            assert.equal(status.fallbackRanker, 'heuristics');
            assert.equal(status.jevApiKey, 'set');
            assert.equal(status.decisionsApiKey, 'set');
            assert.equal(status.decisionsCacheEntries, 0);
            assert.ok(output.every(line => !line.includes('fixture-jev-secret') && !line.includes('fixture-openai-secret')));
        } finally {
            process.chdir(originalCwd);
            for (const name of names) {
                if (saved[name] === undefined) delete process.env[name];
                else process.env[name] = saved[name];
            }
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
