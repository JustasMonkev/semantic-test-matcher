import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePathSeparators } from './paths.ts';
import { createPatternMatcher } from './patterns.ts';

const SKIP_DIRS = new Set([
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

const ALLOWED_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.mts',
    '.cjs',
    '.cts',
]);

export const MAX_CANDIDATE_FILES = 1000;
// Real test files stay well under this (Playwright's largest is ~180 KB).
export const MAX_CANDIDATE_BYTES = 1_000_000;

/** Reads a candidate file, or warns and returns undefined when it is too large to profile. */
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
    const ext = path.extname(filePath);
    return ALLOWED_EXTENSIONS.has(ext);
}

export interface CollectCandidateFilesResult {
    files: string[];
    truncated: boolean;
}

/** `accept` narrows the candidates; only accepted files count toward {@link MAX_CANDIDATE_FILES}. */
export async function collectCandidateFilesDetailed(
    seeds: string[],
    includes: string[],
    excludes: string[],
    cwd: string,
    accept?: (absolutePath: string) => Promise<boolean>
): Promise<CollectCandidateFilesResult> {
    // A Set keeps discovery order and drops files reachable through several seeds.
    const files = new Set<string>();
    const isFull = () => files.size >= MAX_CANDIDATE_FILES;
    const includeMatcher = createPatternMatcher(includes, true);
    const excludeMatcher = createPatternMatcher(excludes, false);
    const relativePath = (absolute: string) => normalizePathSeparators(path.relative(cwd, absolute));

    const addFile = async (absolute: string) => {
        const relative = relativePath(absolute);
        if (includeMatcher(relative) && !excludeMatcher(relative) && !files.has(absolute) && (!accept || await accept(absolute))) {
            files.add(absolute);
        }
    };

    const walkDirectory = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (isFull()) {
                return;
            }
            const next = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                const relative = relativePath(next);
                if (!SKIP_DIRS.has(entry.name) && !relative.startsWith('.') && !excludeMatcher(relative)) {
                    await walkDirectory(next);
                }
            } else if (entry.isFile() && isAllowedFile(next)) {
                await addFile(next);
            }
        }
    };

    for (const seed of seeds.length ? seeds : [cwd]) {
        if (isFull()) {
            break;
        }
        const absolute = path.resolve(cwd, seed);
        try {
            const entry = await fs.lstat(absolute);
            if (entry.isDirectory()) {
                await walkDirectory(absolute);
            } else if (entry.isFile()) {
                await addFile(absolute);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }

    // Reaching the cap counts as truncated even when nothing was left to collect.
    return { files: [...files], truncated: isFull() };
}
