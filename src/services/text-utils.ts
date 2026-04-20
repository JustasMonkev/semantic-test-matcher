const STOP_WORDS = new Set([
    'a',
    'an',
    'and',
    'api',
    'args',
    'await',
    'be',
    'build',
    'by',
    'callback',
    'class',
    'code',
    'command',
    'const',
    'data',
    'debug',
    'describe',
    'dist',
    'does',
    'else',
    'enum',
    'expect',
    'false',
    'file',
    'files',
    'for',
    'from',
    'fs',
    'function',
    'get',
    'global',
    'helpers',
    'if',
    'import',
    'in',
    'index',
    'it',
    'item',
    'items',
    'jest',
    'let',
    'lib',
    'main',
    'mock',
    'kind',
    'module',
    'modules',
    'mutate',
    'node',
    'not',
    'null',
    'object',
    'of',
    'or',
    'path',
    'purpose',
    'process',
    'program',
    'crypto',
    'result',
    'return',
    'signals',
    'should',
    'semantic',
    'source',
    'spec',
    'src',
    'summary',
    'module',
    'string',
    'stub',
    'sub',
    'tests',
    'ts',
    'js',
    'jsx',
    'tsx',
    'mjs',
    'cjs',
    'cts',
    'mts',
    'test',
    'the',
    'this',
    'to',
    'true',
    'type',
    'text',
    'plain',
    'lowercase',
    'phrases',
    'fingerprint',
    'intent',
    'domain',
    'terms',
    'about',
    'basename',
    'exports',
    'imports',
    'include',
    'relative',
    'undefined',
    'utils',
    'value',
    'var',
    'when',
    'with',
    'without',
]);

function splitIntoParts(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_./\\-]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

export function canonicalizeToken(token: string, options?: { skipStopWords?: boolean }): string | null {
    const normalized = token.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!normalized || normalized.length < 2 || /^\d+$/.test(normalized)) {
        return null;
    }

    if (!options?.skipStopWords && STOP_WORDS.has(normalized)) {
        return null;
    }

    if (normalized.endsWith('ies') && normalized.length > 4) {
        return `${normalized.slice(0, -3)}y`;
    }

    if (normalized.endsWith('es') && normalized.length > 4) {
        return normalized.slice(0, -2);
    }

    if (normalized.endsWith('s') && normalized.length > 3 && !normalized.endsWith('ss')) {
        return normalized.slice(0, -1);
    }

    return normalized;
}

export function tokenizeText(value: string): string[] {
    const tokens: string[] = [];
    for (const part of splitIntoParts(value)) {
        const token = canonicalizeToken(part);
        if (token) {
            tokens.push(token);
        }
    }
    return tokens;
}

export function uniqueTokens(tokens: string[]): string[] {
    return [...new Set(tokens)];
}

export function normalizeVector(vector: number[]): number[] {
    let magnitude = 0;
    for (const component of vector) {
        magnitude += component * component;
    }

    if (magnitude === 0) {
        return vector;
    }

    const divisor = Math.sqrt(magnitude);
    return vector.map((component) => component / divisor);
}

function sharedTokenCount(leftTokens: string[], rightTokens: Set<string>): number {
    let shared = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) {
            shared += 1;
        }
    }
    return shared;
}

export function overlapCoefficient(left: string[], right: string[]): number {
    const leftTokens = uniqueTokens(left);
    const rightTokens = new Set(uniqueTokens(right));

    if (!leftTokens.length || !rightTokens.size) {
        return 0;
    }

    return sharedTokenCount(leftTokens, rightTokens) / Math.min(leftTokens.length, rightTokens.size);
}

export function diceCoefficient(left: string[], right: string[]): number {
    const leftTokens = uniqueTokens(left);
    const rightTokens = new Set(uniqueTokens(right));

    if (!leftTokens.length || !rightTokens.size) {
        return 0;
    }

    return (sharedTokenCount(leftTokens, rightTokens) * 2) / (leftTokens.length + rightTokens.size);
}

function hashToken(token: string): number {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function addTokenToVector(vector: number[], token: string, weight: number): void {
    const index = hashToken(token) % vector.length;
    vector[index] += weight;
}

export function textToVector(text: string, dimensions = 384): number[] {
    const vector = new Array(dimensions).fill(0);
    const tokens = tokenizeText(text);

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        addTokenToVector(vector, token, 1);
        if (index + 1 < tokens.length) {
            addTokenToVector(vector, `${token} ${tokens[index + 1]}`, 0.5);
        }
    }

    return normalizeVector(vector);
}
