import { normalizePathSeparators } from './paths.ts';

export interface PathPattern {
    test(candidate: string): boolean;
}

const ANY_CHARACTERS_IN_SEGMENT = '*';
const ANY_CHARACTERS = '**';
const ANY_DIRECTORIES = '**/';
const OPTIONAL_STEPS = new Set([ANY_CHARACTERS_IN_SEGMENT, ANY_CHARACTERS, ANY_DIRECTORIES]);

function splitAlternatives(pattern: string): string[] {
    return pattern
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
}

function compileGlob(glob: string): string[] {
    const lowered = normalizePathSeparators(glob).toLowerCase();
    const anchored = lowered.includes('/') ? lowered : `${ANY_DIRECTORIES}${lowered}`;
    const steps: string[] = [];
    for (let index = 0; index < anchored.length;) {
        const step = [ANY_DIRECTORIES, ANY_CHARACTERS].find((star) => anchored.startsWith(star, index)) ?? anchored[index];
        steps.push(step);
        index += step.length;
    }
    return steps;
}

function matchesGlob(steps: string[], candidate: string): boolean {
    const withOptionalStepsSkipped = (live: Set<number>): Set<number> => {
        for (let index = 0; index < steps.length; index += 1) {
            if (live.has(index) && OPTIONAL_STEPS.has(steps[index])) {
                live.add(index + 1);
            }
        }
        return live;
    };

    let live = withOptionalStepsSkipped(new Set([0]));
    const directoryStepsAwaitingSlash = new Set<number>();
    for (const char of candidate.split('')) {
        const next = new Set<number>();
        for (const index of live) {
            const step = steps[index];
            if (step === ANY_CHARACTERS || (step === ANY_CHARACTERS_IN_SEGMENT && char !== '/')) {
                next.add(index);
            } else if (step === ANY_DIRECTORIES) {
                directoryStepsAwaitingSlash.add(index);
            } else if (step === '?' || step === char) {
                next.add(index + 1);
            }
        }
        if (char === '/') {
            for (const index of directoryStepsAwaitingSlash) {
                next.add(index + 1);
            }
        }
        live = withOptionalStepsSkipped(next);
        if (!live.size && !directoryStepsAwaitingSlash.size) {
            return false;
        }
    }
    return live.has(steps.length);
}

function compilePatterns(patterns: string[]): string[][] {
    return patterns.flatMap(splitAlternatives).map(compileGlob);
}

function matchesAny(globs: string[][], candidate: string): boolean {
    const normalized = normalizePathSeparators(candidate).toLowerCase();
    return globs.some((steps) => matchesGlob(steps, normalized));
}

export function normalizePattern(pattern: string): PathPattern {
    const globs = compilePatterns([pattern]);
    return { test: (candidate) => matchesAny(globs, candidate) };
}

export function createPatternMatcher(
    patterns: string[] | undefined,
    matchWhenEmpty = true
): (candidate: string) => boolean {
    const globs = compilePatterns(patterns ?? []);
    if (!globs.length) {
        return () => matchWhenEmpty;
    }
    return (candidate) => matchesAny(globs, candidate);
}
