import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectCandidateFilesDetailed, MAX_CANDIDATE_FILES } from '../src/utils/files.ts';

async function makeTree(files: string[]): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-files-'));
    for (const file of files) {
        const absolute = path.join(root, file);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, '// content\n', 'utf8');
    }
    return root;
}

function relativeSorted(root: string, files: string[]): string[] {
    return files.map((file) => path.relative(root, file).replace(/\\/g, '/')).sort();
}

describe('collectCandidateFilesDetailed', () => {
    it('collects allowed source files from seed directories', async () => {
        const root = await makeTree([
            'tests/a.test.ts',
            'tests/nested/b.spec.tsx',
            'tests/readme.md',
            'src/c.ts',
        ]);

        const result = await collectCandidateFilesDetailed(['tests'], ['**/*'], [], root);
        assert.deepEqual(relativeSorted(root, result.files), ['tests/a.test.ts', 'tests/nested/b.spec.tsx']);
        assert.equal(result.truncated, false);
    });

    it('skips well-known build and dependency directories', async () => {
        const root = await makeTree([
            'node_modules/pkg/index.ts',
            'dist/out.ts',
            '.git/hook.ts',
            'tests/a.test.ts',
        ]);

        const result = await collectCandidateFilesDetailed(['.'], ['**/*'], [], root);
        assert.deepEqual(relativeSorted(root, result.files), ['tests/a.test.ts']);
    });

    it('applies include and exclude patterns', async () => {
        const root = await makeTree([
            'tests/a.test.ts',
            'tests/b.test.ts',
            'tests/helper.ts',
        ]);

        const result = await collectCandidateFilesDetailed(['tests'], ['**/*.test.ts'], ['**/b.test.ts'], root);
        assert.deepEqual(relativeSorted(root, result.files), ['tests/a.test.ts']);
    });

    it('accepts individual files as seeds and ignores missing seeds', async () => {
        const root = await makeTree(['tests/a.test.ts']);

        const result = await collectCandidateFilesDetailed(
            ['tests/a.test.ts', 'does-not-exist'],
            ['**/*'],
            [],
            root
        );
        assert.deepEqual(relativeSorted(root, result.files), ['tests/a.test.ts']);
    });

    it('deduplicates files reachable through multiple seeds', async () => {
        const root = await makeTree(['tests/a.test.ts']);

        const result = await collectCandidateFilesDetailed(
            ['tests', 'tests/a.test.ts'],
            ['**/*'],
            [],
            root
        );
        assert.equal(result.files.length, 1);
    });

    it('collects every supported extension and nothing else', async () => {
        const supported = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'mts', 'cjs', 'cts'];
        const unsupported = ['json', 'md', 'txt', 'snap', 'css', 'gguf'];
        const root = await makeTree([
            ...supported.map((extension) => `tests/file.${extension}`),
            ...unsupported.map((extension) => `tests/file.${extension}`),
            'tests/no-extension',
        ]);

        const result = await collectCandidateFilesDetailed(['tests'], ['**/*'], [], root);
        assert.deepEqual(
            relativeSorted(root, result.files),
            supported.map((extension) => `tests/file.${extension}`).sort()
        );
    });

    it('caps the scan and reports truncation', async () => {
        const root = await makeTree(
            Array.from({ length: MAX_CANDIDATE_FILES + 10 }, (_, index) =>
                `tests/file-${String(index).padStart(5, '0')}.test.ts`
            )
        );

        const result = await collectCandidateFilesDetailed(['tests'], ['**/*'], [], root);
        assert.equal(result.files.length, MAX_CANDIDATE_FILES);
        assert.equal(result.truncated, true);
    });

    it('reports no truncation when the tree fits exactly at the cap', async () => {
        const root = await makeTree(
            Array.from({ length: MAX_CANDIDATE_FILES }, (_, index) =>
                `tests/file-${String(index).padStart(5, '0')}.test.ts`
            )
        );

        const result = await collectCandidateFilesDetailed(['tests'], ['**/*'], [], root);
        assert.equal(result.files.length, MAX_CANDIDATE_FILES);
        assert.equal(result.truncated, false);
    });

    it('reports truncation when a later seed pushes past the cap', async () => {
        const root = await makeTree([
            ...Array.from({ length: MAX_CANDIDATE_FILES }, (_, index) =>
                `first/file-${String(index).padStart(5, '0')}.test.ts`
            ),
            'second/extra.test.ts',
        ]);

        const result = await collectCandidateFilesDetailed(['first', 'second'], ['**/*'], [], root);
        assert.equal(result.files.length, MAX_CANDIDATE_FILES);
        assert.equal(result.truncated, true);
    });

    it('stops walking sibling directories once truncated', async () => {
        const root = await makeTree([
            ...Array.from({ length: MAX_CANDIDATE_FILES }, (_, index) =>
                `tests/a/file-${String(index).padStart(5, '0')}.test.ts`
            ),
            'tests/b/nested/deep/extra.test.ts',
            'tests/c/another.test.ts',
            'tests/d/yet-another.test.ts',
        ]);

        const result = await collectCandidateFilesDetailed(['tests'], ['**/*'], [], root);
        assert.equal(result.files.length, MAX_CANDIDATE_FILES);
        assert.equal(result.truncated, true);
        assert.ok(
            result.files.every((file) => file.includes(`${path.sep}a${path.sep}`)),
            'only the first directory should have been collected'
        );
    });

    it('stops walking remaining seeds once truncated', async () => {
        const root = await makeTree([
            ...Array.from({ length: MAX_CANDIDATE_FILES }, (_, index) =>
                `first/file-${String(index).padStart(5, '0')}.test.ts`
            ),
            'second/extra.test.ts',
            'third/also-extra.test.ts',
        ]);

        const result = await collectCandidateFilesDetailed(['first', 'second', 'third'], ['**/*'], [], root);
        assert.equal(result.files.length, MAX_CANDIDATE_FILES);
        assert.equal(result.truncated, true);
    });

    it('stops at a direct seed file once truncated', async () => {
        const root = await makeTree([
            ...Array.from({ length: MAX_CANDIDATE_FILES }, (_, index) =>
                `first/file-${String(index).padStart(5, '0')}.test.ts`
            ),
            'extra.test.ts',
        ]);

        const result = await collectCandidateFilesDetailed(['first', 'extra.test.ts'], ['**/*'], [], root);
        assert.equal(result.files.length, MAX_CANDIDATE_FILES);
        assert.equal(result.truncated, true);
        assert.ok(!result.files.some((file) => file.endsWith('extra.test.ts')));
    });

    it('does not count files excluded by pattern towards the cap', async () => {
        const root = await makeTree([
            ...Array.from({ length: 10 }, (_, index) => `tests/keep-${index}.test.ts`),
            ...Array.from({ length: 10 }, (_, index) => `tests/drop-${index}.test.ts`),
        ]);

        const result = await collectCandidateFilesDetailed(['tests'], ['**/keep-*.test.ts'], [], root);
        assert.equal(result.files.length, 10);
        assert.equal(result.truncated, false);
    });

    it('skips dot directories that are not in the built-in skip list', async () => {
        const root = await makeTree(['.hidden/a.test.ts', '.yarn/b.test.ts', 'tests/c.test.ts']);

        const result = await collectCandidateFilesDetailed(['.'], ['**/*'], [], root);
        assert.deepEqual(relativeSorted(root, result.files), ['tests/c.test.ts']);
    });

    it('ignores symlinks rather than following them out of the tree', async () => {
        const root = await makeTree(['tests/real.test.ts', 'outside/secret.test.ts']);
        await fs.symlink(path.join(root, 'outside', 'secret.test.ts'), path.join(root, 'tests', 'link.test.ts'));
        await fs.symlink(path.join(root, 'outside'), path.join(root, 'tests', 'linked-dir'), 'dir');

        const result = await collectCandidateFilesDetailed(['tests'], ['**/*'], [], root);
        assert.deepEqual(relativeSorted(root, result.files), ['tests/real.test.ts']);
    });

    it('accepts an explicit seed file with an unsupported extension', async () => {
        const root = await makeTree(['notes.md']);

        const result = await collectCandidateFilesDetailed(['notes.md'], ['**/*'], [], root);
        assert.deepEqual(relativeSorted(root, result.files), ['notes.md']);
    });

    it('excludes a directory before descending into it', async () => {
        const root = await makeTree(['tests/keep/a.test.ts', 'tests/legacy/b.test.ts']);

        const result = await collectCandidateFilesDetailed(['tests'], ['**/*'], ['**/legacy/**'], root);
        assert.deepEqual(relativeSorted(root, result.files), ['tests/keep/a.test.ts']);
    });

    it('lets excludes win over includes for the same file', async () => {
        const root = await makeTree(['tests/a.test.ts', 'tests/b.test.ts']);

        const result = await collectCandidateFilesDetailed(['tests'], ['**/*.test.ts'], ['**/*.test.ts'], root);
        assert.deepEqual(result.files, []);
    });

    it('scans the working directory when no seeds are given', async () => {
        const root = await makeTree(['tests/a.test.ts', 'src/b.ts']);

        const result = await collectCandidateFilesDetailed([], ['**/*'], [], root);
        assert.deepEqual(relativeSorted(root, result.files), ['src/b.ts', 'tests/a.test.ts']);
    });

    it('returns nothing for a seed directory that is empty', async () => {
        const root = await makeTree(['tests/a.test.ts']);
        await fs.mkdir(path.join(root, 'empty'), { recursive: true });

        const result = await collectCandidateFilesDetailed(['empty'], ['**/*'], [], root);
        assert.deepEqual(result.files, []);
        assert.equal(result.truncated, false);
    });

    it('splits comma-separated patterns', async () => {
        const root = await makeTree(['tests/a.test.ts', 'tests/b.spec.ts', 'tests/c.ts']);

        const result = await collectCandidateFilesDetailed(['tests'], ['**/*.test.ts,**/*.spec.ts'], [], root);
        assert.deepEqual(relativeSorted(root, result.files), ['tests/a.test.ts', 'tests/b.spec.ts']);
    });
});
