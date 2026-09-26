import path from 'node:path';

export interface PathPattern {
    test(candidate: string): boolean;
}

function splitTokens(pattern: string): string[] {
    return pattern
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
}

// Wildcard steps; every other step is one literal UTF-16 unit.
// "**/" matches zero or more whole directories, so "**/foo.ts" also matches a root-level "foo.ts".
const STARS = new Set(['*', '**', '**/']);

function compileGlob(token: string): string[] {
    const withUnix = token.replace(/\\/g, '/').toLowerCase();
    const anchored = withUnix.includes('/') ? withUnix : `**/${withUnix}`;
    const steps: string[] = [];
    let index = 0;
    while (index < anchored.length) {
        const step = ['**/', '**'].find((star) => anchored.startsWith(star, index)) ?? anchored[index];
        steps.push(step);
        index += step.length;
    }
    return steps;
}

/**
 * Advances every live step at once instead of backtracking, so matching costs
 * O(steps × path length) even for wildcard-heavy patterns from repo config.
 */
function matchesGlob(steps: string[], candidate: string): boolean {
    // Stars may match nothing, so a live star also makes the next step live.
    // Set iteration visits indexes added here, which chains consecutive stars.
    const skipStars = (live: Set<number>): Set<number> => {
        for (const index of live) {
            if (STARS.has(steps[index])) {
                live.add(index + 1);
            }
        }
        return live;
    };

    let live = skipStars(new Set([0]));
    // "**/" steps that have consumed characters; each later "/" may end the directory prefix.
    const openDirectories = new Set<number>();
    // Walk UTF-16 units, as compileGlob does, so astral characters line up.
    for (let position = 0; position < candidate.length; position += 1) {
        const char = candidate[position];
        const next = new Set<number>();
        for (const index of live) {
            const step = steps[index];
            if (step === '**' || (step === '*' && char !== '/')) {
                next.add(index);
            } else if (step === '**/') {
                openDirectories.add(index);
            } else if (step === '?' || step === char) {
                next.add(index + 1);
            }
        }
        if (char === '/') {
            for (const index of openDirectories) {
                next.add(index + 1);
            }
        }
        live = skipStars(next);
        if (!live.size && !openDirectories.size) {
            return false;
        }
    }
    return live.has(steps.length);
}

export function normalizePattern(pattern: string): PathPattern {
    const alternatives = splitTokens(pattern).map(compileGlob);
    return {
        test: (candidate) => {
            const lowered = candidate.toLowerCase();
            return alternatives.some((steps) => matchesGlob(steps, lowered));
        },
    };
}

export function createPatternMatcher(
    patterns: string[] | undefined,
    emptyResult = true
): (candidate: string) => boolean {
    const matchers = (patterns ?? []).flatMap(splitTokens).map((pattern) => normalizePattern(pattern));
    if (!matchers.length) {
        return () => emptyResult;
    }

    return (candidate: string) => {
        const normalized = candidate.replace(/\\/g, '/');
        return matchers.some((pattern) => pattern.test(normalized));
    };
}

export function isParentPath(base: string, target: string): boolean {
    const relative = path.relative(base, target);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}
