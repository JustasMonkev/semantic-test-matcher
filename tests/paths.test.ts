import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { isWorkspaceContainedPath, normalizePathSeparators, resolveRealPath } from '../src/utils/paths.ts';

describe('normalizePathSeparators', () => {
    it('normalizes separators without changing case, spaces, or path segments', () => {
        assert.equal(normalizePathSeparators('Src\\a b/..\\🧪.ts'), 'Src/a b/../🧪.ts');
        assert.equal(normalizePathSeparators('src/a.ts'), 'src/a.ts');
        assert.equal(normalizePathSeparators(''), '');
    });
});

describe('workspace paths', () => {
    it('resolves symlink ancestors for missing paths and rejects escapes', async (t) => {
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-paths-'));
        t.after(() => fs.rm(temporary, { recursive: true, force: true }));
        const root = await fs.realpath(temporary);
        const workspace = path.join(root, 'workspace');
        const outside = path.join(root, 'outside');
        await fs.mkdir(workspace);
        await fs.mkdir(outside);
        await fs.symlink(outside, path.join(workspace, 'link'), 'dir');

        const missingInside = path.join(workspace, 'new', 'cache.json');
        const missingEscape = path.join(workspace, 'link', 'new', 'cache.json');
        assert.equal(await resolveRealPath(workspace), workspace);
        assert.equal(await resolveRealPath(missingInside), missingInside);
        assert.equal(await resolveRealPath(missingEscape), path.join(outside, 'new', 'cache.json'));
        assert.equal(await isWorkspaceContainedPath(workspace, workspace), true);
        assert.equal(await isWorkspaceContainedPath(missingInside, workspace), true);
        assert.equal(await isWorkspaceContainedPath(missingEscape, workspace), false);
        assert.equal(await isWorkspaceContainedPath(outside, workspace), false);

        const file = path.join(workspace, 'file');
        await fs.writeFile(file, 'text');
        await assert.rejects(resolveRealPath(path.join(file, 'child')), { code: 'ENOTDIR' });
    });
});
