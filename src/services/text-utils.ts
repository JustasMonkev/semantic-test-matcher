const STOP_WORDS = new Set([
    'a', 'an', 'and', 'api', 'args', 'await', 'be', 'build', 'by', 'callback', 'class', 'code', 'command', 'const',
    'data', 'debug', 'describe', 'dist', 'does', 'else', 'enum', 'expect', 'false', 'file', 'files', 'for', 'from',
    'fs', 'function', 'get', 'global', 'helpers', 'if', 'import', 'in', 'index', 'it', 'item', 'items', 'jest',
    'let', 'lib', 'main', 'mock', 'kind', 'module', 'modules', 'mutate', 'node', 'not', 'null', 'object', 'of',
    'or', 'path', 'purpose', 'process', 'program', 'crypto', 'result', 'return', 'signals', 'should', 'semantic',
    'source', 'spec', 'src', 'summary', 'string', 'stub', 'sub', 'tests', 'ts', 'js', 'jsx', 'tsx', 'mjs', 'cjs',
    'cts', 'mts', 'test', 'the', 'this', 'to', 'true', 'type', 'text', 'plain', 'lowercase', 'phrases',
    'fingerprint', 'intent', 'domain', 'terms', 'about', 'basename', 'exports', 'imports', 'include', 'relative',
    'undefined', 'utils', 'value', 'var', 'when', 'with', 'without',
]);

const COMMON_ACRONYMS = new Set(['api', 'cli', 'gui', 'tui', 'ui', 'uri']);

export function splitIntoParts(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_./\\-]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function isAcronymPlural(compact: string, normalized: string): boolean {
    return /^[A-Z]{2,}s$/.test(compact) || COMMON_ACRONYMS.has(normalized.slice(0, -1));
}

function isRegularPlural(compact: string, normalized: string): boolean {
    if (!normalized.endsWith('s') || normalized.length <= 3 || normalized.endsWith('ss')) {
        return false;
    }
    if (normalized.endsWith('us')) {
        return normalized.endsWith('menus');
    }
    if (normalized.endsWith('is')) {
        return isAcronymPlural(compact, normalized);
    }
    return true;
}

export function canonicalizeToken(token: string, options?: { keepStopWords?: boolean }): string | null {
    const compact = token.replace(/[^a-z0-9]+/gi, '');
    const normalized = compact.toLowerCase();
    if (normalized.length < 2 || /^\d+$/.test(normalized)) {
        return null;
    }
    const isDroppedStopWord = (word: string) => !options?.keepStopWords && STOP_WORDS.has(word);
    if (isDroppedStopWord(normalized)) {
        return null;
    }
    if (normalized.endsWith('ies') && normalized.length > 4) {
        return `${normalized.slice(0, -3)}y`;
    }
    if (normalized.endsWith('es') && normalized.length > 4) {
        return normalized.slice(0, -2);
    }
    if (isRegularPlural(compact, normalized)) {
        const singular = normalized.slice(0, -1);
        return isDroppedStopWord(singular) ? null : singular;
    }
    return normalized;
}

export function tokenizeText(value: string): string[] {
    return splitIntoParts(value)
        .map((part) => canonicalizeToken(part))
        .filter((token): token is string => token !== null);
}

export function uniqueTokens(tokens: string[]): string[] {
    return [...new Set(tokens)];
}

function sharedTokenCount(leftTokens: string[], rightTokens: Set<string>): number {
    return leftTokens.filter((token) => rightTokens.has(token)).length;
}

export function overlapCoefficient(left: string[], right: string[]): number {
    const leftTokens = uniqueTokens(left);
    const rightTokens = new Set(right);
    if (!leftTokens.length || !rightTokens.size) {
        return 0;
    }
    return sharedTokenCount(leftTokens, rightTokens) / Math.min(leftTokens.length, rightTokens.size);
}

export function diceCoefficient(left: string[], right: string[]): number {
    const leftTokens = uniqueTokens(left);
    const rightTokens = new Set(right);
    if (!leftTokens.length || !rightTokens.size) {
        return 0;
    }
    return (sharedTokenCount(leftTokens, rightTokens) * 2) / (leftTokens.length + rightTokens.size);
}
