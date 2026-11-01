import fs from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from './errors.ts';
import { normalizePathSeparators } from './paths.ts';
import { createPatternMatcher } from './patterns.ts';

const SKIPPED_DIRECTORIES = new Set([
    '.git',
    'node_modules',
    '.idea',
    'dist',
    'build',
    'coverage',
    '.cache',
    '.parcel-cache',
    '.next',
]);

const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts']);

export const MAX_CANDIDATE_FILES = 1000;
export const MAX_CANDIDATE_BYTES = 1_000_000;

export async function readCandidateText(filePath: string): Promise<string | undefined> {
    const handle = await fs.open(filePath, 'r');
    try {
        if ((await handle.stat()).size > MAX_CANDIDATE_BYTES) {
            console.warn(`Warning: skipped ${filePath} (larger than ${MAX_CANDIDATE_BYTES} bytes)`);
            return undefined;
        }
        return await handle.readFile('utf8');
    } finally {
        await handle.close();
    }
}

export function isAllowedFile(filePath: string): boolean {
    return SCRIPT_EXTENSIONS.has(path.extname(filePath));
}

export interface CollectCandidateFilesResult {
    files: string[];
    truncated: boolean;
}

export async function collectCandidateFiles(
    seeds: string[],
    includes: string[],
    excludes: string[],
    cwd: string,
    accept?: (absolutePath: string) => Promise<boolean>
): Promise<CollectCandidateFilesResult> {
    const files = new Set<string>();
    const isFull = () => files.size >= MAX_CANDIDATE_FILES;
    const isIncluded = createPatternMatcher(includes, true);
    const isExcluded = createPatternMatcher(excludes, false);
    const relativePath = (absolute: string) => normalizePathSeparators(path.relative(cwd, absolute));

    const shouldWalk = (directory: string, name: string) => {
        const relative = relativePath(directory);
        const isDotPath = relative.startsWith('.');
        return !SKIPPED_DIRECTORIES.has(name) && !isDotPath && !isExcluded(relative);
    };

    const addFile = async (absolute: string) => {
        const relative = relativePath(absolute);
        const matchesFilters = isIncluded(relative) && !isExcluded(relative);
        if (matchesFilters && !files.has(absolute) && (!accept || await accept(absolute))) {
            files.add(absolute);
        }
    };

    const walkDirectory = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (isFull()) {
                return;
            }
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory() && shouldWalk(entryPath, entry.name)) {
                await walkDirectory(entryPath);
            } else if (entry.isFile() && isAllowedFile(entryPath)) {
                await addFile(entryPath);
            }
        }
    };

    const visitSeed = async (absolute: string) => {
        try {
            const entry = await fs.lstat(absolute);
            if (entry.isDirectory()) {
                await walkDirectory(absolute);
            } else if (entry.isFile()) {
                await addFile(absolute);
            }
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
    };

    for (const seed of seeds.length ? seeds : [cwd]) {
        if (isFull()) {
            break;
        }
        await visitSeed(path.resolve(cwd, seed));
    }

    return { files: [...files], truncated: isFull() };
}
