import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readGitChanges } from '../src/services/git-changes.ts';
import { buildDocumentProfile } from '../src/services/document-profile.ts';

const execFileAsync = promisify(execFile);

describe('local Git changes', () => {
    let root: string;
    const git = (...args: string[]) => execFileAsync('git', args, { cwd: root });

    beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-git-')));
        await git('init');
        await git('config', 'user.email', 'test@example.com');
        await git('config', 'user.name', 'RBT test');
        await fs.mkdir(path.join(root, 'src'));
        await fs.writeFile(path.join(root, 'src/price.ts'), 'export const price = 1;\n');
        await fs.writeFile(path.join(root, 'src/gone.ts'), 'export const oldPrice = 1;\n');
        await fs.writeFile(path.join(root, '.gitignore'), 'ignored.ts\n');
        await git('add', '.');
        await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
    });

    afterEach(async () => fs.rm(root, { recursive: true, force: true }));

    it('includes staged, unstaged, untracked and deleted sources, with deletion evidence', async () => {
        await fs.writeFile(path.join(root, 'src/price.ts'), 'export const price = 2;\n');
        await git('add', 'src/price.ts');
        await fs.writeFile(path.join(root, 'src/price.ts'), 'export const price = 3;\n');
        await fs.rm(path.join(root, 'src/gone.ts'));
        await fs.writeFile(path.join(root, 'src/new file.ts'), 'export const fresh = true;\n');
        await fs.writeFile(path.join(root, 'README.md'), 'documentation');
        await fs.writeFile(path.join(root, 'ignored.ts'), 'ignored');
        const changes = await readGitChanges(root);
        assert.deepEqual(changes.files.map(file => path.relative(changes.root, file)).sort(), [
            'src/gone.ts', 'src/new file.ts', 'src/price.ts',
        ]);
        assert.match(changes.diffText, /\+export const price = 3/);
        assert.doesNotMatch(changes.diffText, /\+export const price = 2/);
        const profile = buildDocumentProfile(path.join(root, 'src/gone.ts'), '', root, changes.diffText, changes.root);
        assert.match(profile.diffExcerpt ?? '', /oldPrice/);
    });

    it('reads an uncolored diff even when Git is configured to always color', async () => {
        await git('config', 'color.ui', 'always');
        await git('config', 'color.diff', 'always');
        await fs.writeFile(path.join(root, 'src/price.ts'), 'export const price = 2;\n');
        const changes = await readGitChanges(root);

        assert.doesNotMatch(changes.diffText, /\u001b\[/);
        const profile = buildDocumentProfile(path.join(root, 'src/price.ts'), '', root, changes.diffText, changes.root);
        assert.match(profile.diffExcerpt ?? '', /^@@ -1 \+1 @@\n-export const price = 1;\n\+export const price = 2;$/);
    });

    it('scopes changes to the current directory and resolves paths from nested directories', async () => {
        await fs.writeFile(path.join(root, 'outside.ts'), 'export const outside = 1;');
        await fs.writeFile(path.join(root, 'src/price.ts'), 'export const price = 2;\n');
        await fs.writeFile(path.join(root, 'src/café.ts'), 'export const fresh = 1;');
        const changes = await readGitChanges(path.join(root, 'src'));
        assert.deepEqual(changes.files.map(file => path.relative(changes.root, file)).sort(), ['src/café.ts', 'src/price.ts']);
    });

    it('handles repositories before their first commit', async () => {
        await fs.rm(path.join(root, '.git'), { recursive: true, force: true });
        await git('init');
        await git('add', 'src/price.ts');
        await fs.writeFile(path.join(root, 'src/price.ts'), 'export const price = 2;\n');
        const changes = await readGitChanges(root);
        assert.deepEqual(changes.files.map(file => path.relative(changes.root, file)).sort(), ['src/gone.ts', 'src/price.ts']);
        assert.match(changes.diffText, /\+export const price = 2/);
    });

    it('returns no changes for a clean tree, but preserves Git errors', async () => {
        assert.deepEqual((await readGitChanges(root)).files, []);
        await fs.rm(path.join(root, '.git'), { recursive: true, force: true });
        await assert.rejects(readGitChanges(root), /not a git repository/);
    });
});
