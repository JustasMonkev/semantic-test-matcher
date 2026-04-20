import path from 'node:path';

const SPECIALS = /[.+?^${}()|[\]\\]/;

function splitTokens(pattern: string): string[] {
    return pattern
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
}

export function normalizePattern(pattern: string): RegExp {
    const tokens = splitTokens(pattern);
    if (!tokens.length) {
        return /^$/i;
    }

    const escaped = tokens.map((token) => {
        const withUnix = token.replace(/\\/g, '/');
        const anchored = withUnix.includes('/') ? withUnix : `**/${withUnix}`;
        let regex = '';
        for (let index = 0; index < anchored.length; index += 1) {
            const char = anchored[index];
            const next = anchored[index + 1];
            if (char === '*' && next === '*') {
                regex += '.*';
                index += 1;
            } else if (char === '*') {
                regex += '[^/]*';
            } else if (char === '?') {
                regex += '.';
            } else {
                regex += SPECIALS.test(char) ? `\\${char}` : char;
            }
        }
        return `(?:${regex})`;
    });

    return new RegExp(`^(?:${escaped.join('|')})$`, 'i');
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
