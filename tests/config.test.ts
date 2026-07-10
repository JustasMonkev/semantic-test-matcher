import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clamp, resolveConfig } from '../src/config.ts';

const MANAGED_ENV_VARS = [
    'RBT_MODEL',
    'RBT_CACHE_DIR',
    'RBT_LOG_LEVEL',
    'RBT_VERBOSE',
    'RBT_QUIET',
    'RBT_TOP_K',
    'RBT_MATCH_TOP_K',
    'RBT_THRESHOLD',
    'RBT_MATCH_THRESHOLD',
    'RBT_MIN_SCORE',
    'RBT_MATCH_MIN_SCORE',
];

describe('resolveConfig', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
        savedEnv = {};
        for (const name of MANAGED_ENV_VARS) {
            savedEnv[name] = process.env[name];
            delete process.env[name];
        }
    });

    afterEach(() => {
        for (const name of MANAGED_ENV_VARS) {
            if (savedEnv[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = savedEnv[name];
            }
        }
    });

    it('falls back to built-in defaults', async () => {
        const config = await resolveConfig({}, {});
        assert.equal(config.model, path.resolve('models/embeddinggemma-300M-Q4_0.gguf'));
        assert.equal(config.logLevel, 'info');
        assert.equal(config.match.topK, 5);
        assert.equal(config.match.threshold, 0.45);
        assert.deepEqual(config.match.candidatePaths, ['test', 'tests']);
    });

    it('prefers command options over root options and env vars', async () => {
        process.env.RBT_TOP_K = '9';
        const config = await resolveConfig(
            { model: 'root-model' },
            { model: 'command-model', topK: '3' }
        );
        assert.equal(config.model, path.resolve('command-model'));
        assert.equal(config.match.topK, 3);
    });

    it('prefers env vars over the config file', async () => {
        process.env.RBT_MODEL = 'env-model';
        const configFile = await writeTempConfig({ model: 'file-model' });
        const config = await resolveConfig({ config: configFile }, {});
        assert.equal(config.model, path.resolve('env-model'));
    });

    it('reads settings from an explicit config file', async () => {
        const configFile = await writeTempConfig({
            model: 'file-model',
            logLevel: 'warn',
            match: { topK: 7, threshold: 0.6 },
        });
        const config = await resolveConfig({ config: configFile }, {});
        assert.equal(config.model, path.resolve('file-model'));
        assert.equal(config.logLevel, 'warn');
        assert.equal(config.match.topK, 7);
        assert.equal(config.match.threshold, 0.6);
    });

    it('defaults minScore to the resolved threshold', async () => {
        const config = await resolveConfig({}, { threshold: '0.3' });
        assert.equal(config.match.threshold, 0.3);
        assert.equal(config.match.minScore, 0.3);
    });

    it('clamps threshold and minScore into [0, 1] and topK to at least 1', async () => {
        const config = await resolveConfig({}, { threshold: '7', minScore: '-2', topK: '0' });
        assert.equal(config.match.threshold, 1);
        assert.equal(config.match.minScore, 0);
        assert.equal(config.match.topK, 1);
    });

    it('rejects an invalid log level', async () => {
        await assert.rejects(resolveConfig({ logLevel: 'loud' }, {}), /Invalid log level "loud"/);
    });

    it('rejects a malformed config file', async () => {
        const configFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-config-')), 'config.json');
        await fs.writeFile(configFile, '{ not json', 'utf8');
        await assert.rejects(resolveConfig({ config: configFile }, {}), /Failed to parse config file/);
    });

    it('resolves the cache dir relative to the working directory', async () => {
        const config = await resolveConfig({ cacheDir: 'custom-cache' }, {}, '/workspace-root');
        assert.equal(config.cacheDir, path.resolve('/workspace-root', 'custom-cache'));
    });

    it('merges include/exclude patterns from flags and defaults', async () => {
        const config = await resolveConfig({}, { includeFile: ['**/*.spec.ts'], excludeFile: ['**/tmp/**'] });
        assert.ok(config.match.includePatterns.includes('**/*.spec.ts'));
        assert.ok(config.match.includePatterns.includes('**/*'));
        assert.ok(config.match.excludePatterns.includes('**/tmp/**'));
        assert.ok(config.match.excludePatterns.includes('**/node_modules/**'));
    });
});

describe('clamp', () => {
    it('bounds values and maps NaN to the minimum', () => {
        assert.equal(clamp(0.5, 0, 1), 0.5);
        assert.equal(clamp(-1, 0, 1), 0);
        assert.equal(clamp(2, 0, 1), 1);
        assert.equal(clamp(Number.NaN, 0, 1), 0);
    });
});

async function writeTempConfig(config: object): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-config-'));
    const filePath = path.join(dir, 'config.json');
    await fs.writeFile(filePath, JSON.stringify(config), 'utf8');
    return filePath;
}
