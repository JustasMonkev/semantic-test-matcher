import { normalizePathSeparators } from './paths.ts';

export { isParentPath } from './paths.ts';

export interface PathPattern {
    test(candidate: string): boolean;
}

function splitTokens(pattern: string): string[] {
    return pattern
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
}

// Every other step is one literal UTF-16 unit. "**/" also matches no directories at all.
const STARS = new Set(['*', '**', '**/']);

function compileGlob(token: string): string[] {
    const withUnix = normalizePathSeparators(token).toLowerCase();
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

// Tracks every live step at once instead of backtracking, so hostile repo-config globs stay linear.
function matchesGlob(steps: string[], candidate: string): boolean {
    const skipStars = (live: Set<number>): Set<number> => {
        for (let index = 0; index < steps.length; index += 1) {
            if (live.has(index) && STARS.has(steps[index])) {
                live.add(index + 1);
            }
        }
        return live;
    };

    let live = skipStars(new Set([0]));
    // "**/" steps still inside their directories; any later "/" can close them.
    const openDirectories = new Set<number>();
    // UTF-16 units, like compileGlob, so emoji paths line up.
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
        const normalized = normalizePathSeparators(candidate);
        return matchers.some((pattern) => pattern.test(normalized));
    };
}
