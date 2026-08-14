import fs from 'node:fs/promises';
import path from 'node:path';
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

type Matcher = (candidate: string) => boolean;
type CollectState = {
    truncated: boolean;
};

function isAllowedFile(filePath: string): boolean {
    const ext = path.extname(filePath);
    return ALLOWED_EXTENSIONS.has(ext);
}

async function walkDirectory(
    current: string,
    accumulator: string[],
    seen: Set<string>,
    includeMatcher: Matcher,
    excludeMatcher: Matcher,
    state: CollectState,
    cwd: string
): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
        if (state.truncated) {
            break;
        }

        const next = path.join(current, entry.name);
        const relative = path.relative(cwd, next).replace(/\\/g, '/');

        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || relative.startsWith('.')) {
                continue;
            }
            if (!excludeMatcher(relative)) {
                await walkDirectory(next, accumulator, seen, includeMatcher, excludeMatcher, state, cwd);
            }
            continue;
        }

        if (!entry.isFile() || !isAllowedFile(next)) {
            continue;
        }

        if (excludeMatcher(relative)) {
            continue;
        }

        if (includeMatcher(relative) && !seen.has(next)) {
            // Only a candidate that cannot be kept proves the scan was truncated;
            // a tree that lands exactly on the cap has dropped nothing.
            if (accumulator.length >= MAX_CANDIDATE_FILES) {
                state.truncated = true;
                break;
            }
            seen.add(next);
            accumulator.push(next);
        }
    }
}

export interface CollectCandidateFilesResult {
    files: string[];
    truncated: boolean;
}

export async function collectCandidateFilesDetailed(
    seeds: string[],
    includes: string[],
    excludes: string[],
    cwd: string
): Promise<CollectCandidateFilesResult> {
    const matches: string[] = [];
    const seen = new Set<string>();
    const state: CollectState = { truncated: false };
    const normalizedSeeds = seeds.length ? seeds : [cwd];
    const includeMatcher = createPatternMatcher(includes, true);
    const excludeMatcher = createPatternMatcher(excludes, false);

    for (const seed of normalizedSeeds) {
        if (state.truncated) {
            break;
        }

        const absolute = path.resolve(cwd, seed);

        try {
            const entry = await fs.lstat(absolute);
            if (entry.isDirectory()) {
                await walkDirectory(absolute, matches, seen, includeMatcher, excludeMatcher, state, cwd);
                continue;
            }

            if (entry.isFile()) {
                const relative = path.relative(cwd, absolute).replace(/\\/g, '/');
                if (includeMatcher(relative) && !excludeMatcher(relative) && !seen.has(absolute)) {
                    if (matches.length >= MAX_CANDIDATE_FILES) {
                        state.truncated = true;
                        break;
                    }
                    seen.add(absolute);
                    matches.push(absolute);
                }
                continue;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                continue;
            }
            throw error;
        }
    }

    return {
        files: matches,
        truncated: state.truncated,
    };
}

