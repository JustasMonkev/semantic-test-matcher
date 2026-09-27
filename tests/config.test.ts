import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clamp, resolveConfig } from '../src/config.ts';
import { isDebug } from '../src/utils/io.ts';

const MANAGED_ENV_VARS = [
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
    'RBT_RANKER',
    'RBT_JEV_MODEL',
    'RBT_SELECTION_POLICY',
    'RBT_DEBUG',
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
        assert.equal(config.cacheDir, path.resolve('.rbt/cache'));
        assert.equal(config.logLevel, 'info');
        assert.equal(config.match.topK, undefined);
        assert.equal(config.match.threshold, 0);
        assert.equal(config.match.minScore, 0);
        assert.equal(config.match.selectionPolicy, 'adaptive');
        assert.deepEqual(config.match.candidatePaths, ['test', 'tests']);
    });

    it('turns on debug diagnostics for a debug log level from a flag or the environment', async () => {
        await resolveConfig({ logLevel: 'debug' }, {});
        assert.equal(isDebug(), true);
        await resolveConfig({}, {});
        assert.equal(isDebug(), false);
        process.env.RBT_LOG_LEVEL = 'debug';
        await resolveConfig({}, {});
        assert.equal(isDebug(), true);
    });

    it('defaults to the Jev ranker with a pinned model', async () => {
        const config = await resolveConfig({}, {});
        assert.equal(config.ranker, 'jev');
        assert.equal(config.jevModel, 'jev-1.13.0');
    });

    it('resolves the ranker and Jev model from options, env vars, and the config file', async () => {
        const configFile = await writeTempConfig({ ranker: 'heuristics', jevModel: 'jev-file' });
        assert.deepEqual(
            await resolveConfig({ config: configFile }, {}).then(({ ranker, jevModel }) => ({ ranker, jevModel })),
            { ranker: 'heuristics', jevModel: 'jev-file' }
        );

        process.env.RBT_RANKER = 'JEV';
        process.env.RBT_JEV_MODEL = 'jev-env';
        assert.deepEqual(
            await resolveConfig({ config: configFile }, {}).then(({ ranker, jevModel }) => ({ ranker, jevModel })),
            { ranker: 'jev', jevModel: 'jev-env' }
        );

        assert.deepEqual(
            await resolveConfig({ config: configFile }, { ranker: 'heuristics', jevModel: 'jev-cli' })
                .then(({ ranker, jevModel }) => ({ ranker, jevModel })),
            { ranker: 'heuristics', jevModel: 'jev-cli' }
        );
    });

    it('rejects unknown rankers', async () => {
        await assert.rejects(resolveConfig({}, { ranker: 'embedding' }), /Invalid ranker "embedding"/);
    });

    it('resolves selection policy from config, environment, then command options', async () => {
        const configFile = await writeTempConfig({ match: { selectionPolicy: 'targeted' } });
        assert.equal((await resolveConfig({ config: configFile }, {})).match.selectionPolicy, 'targeted');
        process.env.RBT_SELECTION_POLICY = 'conservative';
        assert.equal((await resolveConfig({ config: configFile }, {})).match.selectionPolicy, 'conservative');
        assert.equal((await resolveConfig({ config: configFile }, { selectionPolicy: 'targeted' })).match.selectionPolicy, 'targeted');
        await assert.rejects(resolveConfig({}, { selectionPolicy: 'unsafe' }), /Invalid selection policy/);
    });

    it('prefers command options over root options and env vars', async () => {
        process.env.RBT_TOP_K = '9';
        const config = await resolveConfig(
            { cacheDir: 'root-cache' },
            { cacheDir: 'command-cache', topK: '3' }
        );
        assert.equal(config.cacheDir, path.resolve('command-cache'));
        assert.equal(config.match.topK, 3);
    });

    it('leaves adaptive selection uncapped until a config, env, or CLI limit is supplied', async () => {
        assert.equal((await resolveConfig({}, {})).match.topK, undefined);
        const configFile = await writeTempConfig({ match: { topK: 7 } });
        assert.equal((await resolveConfig({ config: configFile }, {})).match.topK, 7);
        process.env.RBT_TOP_K = '4';
        assert.equal((await resolveConfig({ config: configFile }, {})).match.topK, 4);
        assert.equal((await resolveConfig({ config: configFile }, { topK: '2' })).match.topK, 2);
    });

    it('treats empty numeric env vars and null config values as unset', async () => {
        process.env.RBT_TOP_K = '';
        process.env.RBT_THRESHOLD = ' ';
        process.env.RBT_MIN_SCORE = '';
        const configFile = await writeTempConfig({ match: { topK: null, threshold: 0.4 } });
        const config = await resolveConfig({ config: configFile }, {});
        assert.equal(config.match.topK, undefined);
        assert.equal(config.match.threshold, 0.4);
        assert.equal(config.match.minScore, 0.4);
    });

    it('keeps explicit zero numeric values', async () => {
        process.env.RBT_MIN_SCORE = '0';
        const configFile = await writeTempConfig({ match: { threshold: 0, minScore: 0.5 } });
        assert.equal((await resolveConfig({ config: configFile }, { threshold: '0.4' })).match.minScore, 0);
        assert.equal((await resolveConfig({ config: configFile }, {})).match.threshold, 0);
    });

    it('keeps explicit false flags ahead of truthy environment values', async () => {
        process.env.RBT_QUIET = 'yes';
        process.env.RBT_VERBOSE = '1';
        const config = await resolveConfig({ quiet: false, verbose: false }, {});
        assert.equal(config.quiet, false);
        assert.equal(config.verbose, false);
    });

    it('treats false and unrecognized boolean env values as overrides', async () => {
        process.env.RBT_QUIET = 'false';
        process.env.RBT_VERBOSE = 'unknown';
        const configFile = await writeTempConfig({ quiet: true, verbose: true });
        const config = await resolveConfig({ config: configFile }, {});
        assert.equal(config.quiet, false);
        assert.equal(config.verbose, false);
    });

    it('treats empty string env vars as unset', async () => {
        for (const name of ['RBT_RANKER', 'RBT_JEV_MODEL', 'RBT_LOG_LEVEL', 'RBT_QUIET', 'RBT_VERBOSE', 'RBT_CACHE_DIR', 'RBT_SELECTION_POLICY']) {
            process.env[name] = '';
        }
        const configFile = await writeTempConfig({
            ranker: 'heuristics',
            jevModel: 'jev-file',
            logLevel: 'warn',
            quiet: true,
            verbose: true,
            cacheDir: 'file-cache',
            match: { selectionPolicy: 'targeted' },
        });
        const config = await resolveConfig({ config: configFile }, {});
        assert.equal(config.ranker, 'heuristics');
        assert.equal(config.jevModel, 'jev-file');
        assert.equal(config.logLevel, 'warn');
        assert.equal(config.quiet, true);
        assert.equal(config.verbose, true);
        assert.equal(config.cacheDir, path.resolve('file-cache'));
        assert.equal(config.match.selectionPolicy, 'targeted');
    });

    it('keeps the auto-discovered cacheDir guard when RBT_CACHE_DIR is empty', async () => {
        const cwd = process.cwd();
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-config-'));
        await fs.writeFile(path.join(root, '.rbtconfig'), JSON.stringify({ cacheDir: '../outside' }), 'utf8');
        process.env.RBT_CACHE_DIR = '';
        process.chdir(root);
        try {
            await assert.rejects(resolveConfig({}, {}, root), /cannot set cacheDir outside the workspace/);
        } finally {
            process.chdir(cwd);
        }
    });

    it('prefers env vars over the config file', async () => {
        process.env.RBT_CACHE_DIR = 'env-cache';
        const configFile = await writeTempConfig({ cacheDir: 'file-cache' });
        const config = await resolveConfig({ config: configFile }, {});
        assert.equal(config.cacheDir, path.resolve('env-cache'));
    });

    it('reads settings from an explicit config file', async () => {
        const configFile = await writeTempConfig({
            cacheDir: 'file-cache',
            logLevel: 'warn',
            match: { topK: 7, threshold: 0.6 },
        });
        const config = await resolveConfig({ config: configFile }, {});
        assert.equal(config.cacheDir, path.resolve('file-cache'));
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

    it('uses include patterns from flags and merges exclude patterns with defaults', async () => {
        const config = await resolveConfig({}, { includeFile: ['**/*.spec.ts'], excludeFile: ['**/tmp/**'] });
        assert.deepEqual(config.match.includePatterns, ['**/*.spec.ts']);
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
