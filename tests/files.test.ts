import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectCandidateFilesDetailed } from '../src/utils/files.ts';

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
});
