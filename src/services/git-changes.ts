import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { isAllowedFile } from '../utils/files.ts';
import { listModeOnlyDiffFiles } from './unified-diff.ts';

const execFileAsync = promisify(execFile);

/** Read local changes without modifying the index or working tree. */
export async function readGitChanges(cwd: string): Promise<{ files: string[]; diffText: string; root: string }> {
    const git = async (...args: string[]) => (await execFileAsync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
    })).stdout;
    const root = (await git('rev-parse', '--show-toplevel')).trimEnd();
    let hasHead = true;
    try {
        await git('rev-parse', '--verify', '--quiet', 'HEAD');
    } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 1) throw error;
        hasHead = false;
    }
    const diff = (...args: string[]) =>
        // --no-color: color.diff=always would wrap the headers and lines the diff parser reads.
        git('diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', ...args, '--', '.');
    // Without a HEAD commit, diff the index (staged) and then the working tree against it (unstaged).
    const bases = hasHead ? [['HEAD']] : [['--cached'], []];
    const [patches, names, untracked] = await Promise.all([
        Promise.all(bases.map((base) => diff('--src-prefix=a/', '--dst-prefix=b/', ...base))),
        Promise.all(bases.map((base) => diff('--name-only', '-z', ...base))),
        git('ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', '.'),
    ]);
    // Tracked changes first, then untracked files; -z output ends every name with NUL.
    const changedPaths = [...names, untracked].join('').split('\0').filter(Boolean).map((file) => path.resolve(root, file));
    const diffText = patches.join('');
    // A mode-only change (e.g. chmod +x) leaves the content, and so the tests to run, as it was.
    const modeOnly = new Set(listModeOnlyDiffFiles(diffText, root, root));
    return {
        files: [...new Set(changedPaths)].filter((file) => isAllowedFile(file) && !modeOnly.has(file)),
        diffText,
        root,
    };
}
