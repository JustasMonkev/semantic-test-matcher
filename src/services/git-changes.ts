import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { isAllowedFile } from '../utils/files.ts';
import { listModeOnlyDiffFiles } from './unified-diff.ts';

const execFileAsync = promisify(execFile);
const GIT_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const DIFF_OPTIONS_FOR_PARSING = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative'];

export interface GitChanges {
    files: string[];
    diffText: string;
    root: string;
}

function isExitCode(error: unknown, code: number): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}

export async function readGitChanges(cwd: string): Promise<GitChanges> {
    const git = async (...args: string[]) => (await execFileAsync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
        timeout: GIT_TIMEOUT_MS,
    })).stdout;
    const diff = (...args: string[]) => git('diff', ...DIFF_OPTIONS_FOR_PARSING, ...args, '--', '.');

    const root = (await git('rev-parse', '--show-toplevel')).trimEnd();
    const hasHeadCommit = await git('rev-parse', '--verify', '--quiet', 'HEAD').then(() => true, (error) => {
        if (isExitCode(error, 1)) {
            return false;
        }
        throw error;
    });
    const stagedThenUnstaged = [['--cached'], []];
    const diffBases = hasHeadCommit ? [['HEAD']] : stagedThenUnstaged;
    const [patches, trackedNames, untrackedNames] = await Promise.all([
        Promise.all(diffBases.map((base) => diff('--src-prefix=a/', '--dst-prefix=b/', ...base))),
        Promise.all(diffBases.map((base) => diff('--name-only', '-z', ...base))),
        git('ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', '.'),
    ]);
    const changedPaths = [...trackedNames, untrackedNames]
        .join('')
        .split('\0')
        .filter(Boolean)
        .map((file) => path.resolve(root, file));
    const diffText = patches.join('');
    const contentUnchanged = new Set(listModeOnlyDiffFiles(diffText, root, root));
    return {
        files: [...new Set(changedPaths)].filter((file) => isAllowedFile(file) && !contentUnchanged.has(file)),
        diffText,
        root,
    };
}
