import path from 'node:path';
import { interleaveUniqueTokens } from '../utils/arrays.ts';
import { normalizePathSeparators } from '../utils/paths.ts';
import { canonicalizeToken, splitIntoParts, tokenizeText, uniqueTokens } from './text-utils.ts';
import { collectChangedLines, type ChangedLines } from './unified-diff.ts';

export { listDiffFiles, listModeOnlyDiffFiles, resolveDiffRoot } from './unified-diff.ts';

export type DocumentKind = 'source' | 'test' | 'fixture' | 'unknown';

export interface DocumentProfile {
    absolutePath: string;
    relativePath: string;
    basename: string;
    basenameTokens: string[];
    stemTokens: string[];
    pathFamilyTokens: string[];
    phraseTokens: string[];
    rareAnchorTokens: string[];
    changeTokens: string[];
    changePhraseTokens: string[];
    kind: DocumentKind;
    exports: string[];
    imports: string[];
    testNames: string[];
    testTitles: string[];
    commandTokens: string[];
    optionTokens: string[];
    contentTokens: string[];
    lateCallTokens: string[];
    semanticTokens: string[];
    diffExcerpt: string;
    summary: string;
    preview: string;
}

const GENERIC_PATH_SEGMENTS = new Set([
    'src',
    'test',
    'tests',
    'lib',
    'dist',
    'build',
    'package',
    'packages',
    'packag',
    'fixture',
    'fixtures',
    'playwright',
    'core',
    'spec',
    'ts',
    'js',
    'mjs',
    'cjs',
    'mts',
    'cts',
    'util',
    'utils',
]);

const RARE_ANCHOR_PATTERNS = [
    /\bgetByTestIdSelector\b/gi,
    /\bgetByTestId\b/gi,
    /\btestIdAttributeName\b/gi,
    /\bresolveCLIConfigForMCP\b/gi,
    /\bdotenvFileLoader\b/gi,
    /\bmcpCommand\b/gi,
    /\bbrowserName\b/gi,
    /\btoolListChanged\b/gi,
    /\bbrowser_get_config\b/gi,
    /--test-id-attribute/gi,
    /data-testid/gi,
    /data-tid/gi,
    /my-test-id/gi,
    /\bcodegen\b/gi,
];

const GENERIC_ANCHOR_TOKENS = new Set([
    'id',
    'name',
    'selector',
    'attribute',
    'config',
    'browser',
    'command',
    'option',
]);

const GENERIC_CHANGE_TOKENS = new Set([...GENERIC_ANCHOR_TOKENS, 'is']);

const MAX_SEMANTIC_TOKENS = 72;
const MAX_CHANGE_SEMANTIC_TOKENS = 24;
const MAX_CHANGE_TOKENS = 64;
const MAX_CHANGE_PHRASE_TOKENS = 96;
const MAX_PHRASE_TOKENS = 128;
const MAX_RARE_ANCHOR_TOKENS = 96;
const MAX_PATH_FAMILY_TOKENS = 96;
const MAX_CONTENT_TOKENS = 64;
const MAX_LATE_CALL_TOKENS = 128;
const MAX_TITLE_LENGTH = 160;
const MAX_PREVIEW_LENGTH = 160;

function collectIdentifierTokens(value: string, filterGenericAnchors = false): string[] {
    const tokens = uniqueTokens([
        ...tokenizeText(value),
        ...buildPhraseTokens(splitPhraseParts(value)),
    ]);

    if (!filterGenericAnchors) {
        return tokens;
    }

    return tokens.filter((token) => !GENERIC_ANCHOR_TOKENS.has(token));
}

function collectMatches(value: string, pattern: RegExp, splitter?: (input: string) => string[]): string[] {
    const matches: string[] = [];
    for (const match of value.matchAll(pattern)) {
        const captured = match[1] || '';
        if (!captured) {
            continue;
        }

        const segments = splitter ? splitter(captured) : tokenizeText(captured);
        matches.push(...segments);
    }

    return uniqueTokens(matches);
}

/** Original names from a `{ a, b as c }` list. */
function collectListedIdentifiers(list: string): string[] {
    return list
        .split(',')
        .map((entry) => entry.split(/\s+as\s+/i)[0].trim())
        .filter(Boolean)
        .flatMap((entry) => collectIdentifierTokens(entry));
}

function collectExportedSymbols(text: string): string[] {
    const direct = collectMatches(
        text,
        /export\s+(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        collectIdentifierTokens
    );
    const classes = collectMatches(
        text,
        /export\s+(?:class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        collectIdentifierTokens
    );
    const variables = collectMatches(
        text,
        /export\s+(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        collectIdentifierTokens
    );
    const braceExports = collectMatches(text, /export\s*{\s*([^}]+)\s*}/g, collectListedIdentifiers);

    return uniqueTokens([...direct, ...classes, ...variables, ...braceExports]);
}

function collectImportedSymbols(text: string): string[] {
    const direct = collectMatches(text, /import\s+{([^}]+)}\s+from\s+['"][^'"]+['"]/g, collectListedIdentifiers);
    const defaultImports = collectMatches(
        text,
        /import\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+['"][^'"]+['"]/g,
        collectIdentifierTokens
    );
    return uniqueTokens([...direct, ...defaultImports]);
}

function collectImportedPaths(text: string): string[] {
    return uniqueTokens(
        Array.from(text.matchAll(/(?:from|require\s*\()\s*['"]([^'"]+)['"]/g))
            .map((match) => match[1]?.trim())
            .filter((value): value is string => Boolean(value))
    );
}

function collectTestNames(text: string): string[] {
    const names: string[] = [];
    const regex = /(?:describe|it|test)\s*\(\s*['"`]([^'"`]{1,160})['"`]/g;
    for (const match of text.matchAll(regex)) {
        const name = match[1]?.trim();
        if (name) {
            names.push(...collectIdentifierTokens(name));
        }
    }
    return uniqueTokens(names);
}

// `.each(table)`, `.each`table``, `.for(table)`, and `.skipIf(condition)` call once before the title;
// the bounded table keeps an unclosed call cheap to reject.
// The lookbehind skips method calls such as `/\d+/.test('42')`; `Deno.test` is the dotted call that declares tests.
const TEST_TITLE_PATTERN = /(?<![\w$.])(?:Deno\.test|test|it|describe)(?:\.(?:describe|only|skip|ignore|todo|fixme|fail|failing|slow|serial|parallel|concurrent|sequential))*(?:\.(?:each|for|skipIf|runIf)(?:`[^`]{0,4000}`|\((?:[^()]|\([^()]{0,400}\)){0,4000}\)))?\(\s*(['"`])((?:\\.|(?!\1|\\).)+)\1/g;

// After these keywords an expression follows, so `/` starts a regex literal: `return /x/`.
const KEYWORDS_BEFORE_EXPRESSION = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
// A statement head such as `if (x)` is followed by a statement, which may start with a regex.
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
const IDENTIFIER_CHARACTER = /[\w$]/;

/**
 * The text at the same offsets with comments blanked and string, template, and regex contents
 * masked, so a match can be checked for being code. A heuristic lexer: a misread literal only
 * masks up to the end of its line.
 */
function maskNonCode(text: string): string {
    let masked = '';
    let previousCode = '';
    let lastWord = '';
    let closedControlParen = false;
    const parens: boolean[] = [];
    // `/` is division after an operand (a name, number, literal, `)` or `]`) and a regex elsewhere.
    const startsRegex = () => {
        if (previousCode === ')') {
            return closedControlParen;
        }
        if (IDENTIFIER_CHARACTER.test(previousCode)) {
            return KEYWORDS_BEFORE_EXPRESSION.has(lastWord);
        }
        return previousCode !== ']';
    };
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        const next = text[index + 1];
        if (character === '/' && (next === '/' || next === '*')) {
            const close = next === '/' ? text.indexOf('\n', index) : text.indexOf('*/', index + 2);
            const end = close === -1 ? text.length : next === '/' ? close : close + 2;
            masked += text.slice(index, end).replace(/[^\n]/g, ' ');
            index = end;
            continue;
        }
        if (character === '"' || character === "'" || character === '`' || (character === '/' && startsRegex())) {
            let end = index + 1;
            // Only template literals span lines.
            while (end < text.length && text[end] !== character && (character === '`' || text[end] !== '\n')) {
                end += text[end] === '\\' ? 2 : 1;
            }
            end = Math.min(end, text.length);
            const closed = text[end] === character;
            masked += character + text.slice(index + 1, end).replace(/[^\n]/g, 'x') + (closed ? character : '');
            index = closed ? end + 1 : end;
            // A literal is an operand, like a name that is not a keyword.
            previousCode = 'x';
            lastWord = '';
            continue;
        }
        masked += character;
        if (IDENTIFIER_CHARACTER.test(character)) {
            lastWord = IDENTIFIER_CHARACTER.test(text[index - 1] ?? '') ? lastWord + character : character;
        } else if (character === '(') {
            parens.push(IDENTIFIER_CHARACTER.test(previousCode) && CONTROL_KEYWORDS.has(lastWord));
        } else if (character === ')') {
            closedControlParen = parens.pop() ?? false;
        }
        if (!/\s/.test(character)) {
            previousCode = character;
        }
        index += 1;
    }
    return masked;
}

/** Raw test titles, kept verbatim for consumers that read them as prose. */
function collectTestTitles(text: string): string[] {
    const titles: string[] = [];
    const code = maskNonCode(text);
    for (const match of text.matchAll(TEST_TITLE_PATTERN)) {
        // A call inside a comment or string, such as `// test('example')`, declares no test.
        if (code[match.index] !== text[match.index]) {
            continue;
        }
        const title = match[2].trim().slice(0, MAX_TITLE_LENGTH);
        if (title) {
            titles.push(title);
        }
    }
    return [...new Set(titles)];
}

function collectStemTokens(basename: string): string[] {
    const stem = basename
        .replace(/\.[^.]+$/u, '')
        .replace(/\.(test|spec)$/iu, '');

    return uniqueTokens(
        splitIntoParts(stem)
            .map((token) => canonicalizeToken(token, { skipStopWords: true }))
            .filter((token): token is string => Boolean(token))
    );
}

function collectCommandTokens(text: string): string[] {
    return collectMatches(text, /\.\s*command\s*\(\s*['"`]([^'"`]{1,160})['"`]/g);
}

function collectOptionTokens(text: string): string[] {
    return uniqueTokens(
        Array.from(text.matchAll(/--[a-z0-9][a-z0-9-]*/gi))
            .map((match) => match[0].replace(/^--/, ''))
            .flatMap(tokenizeText)
    );
}

function splitPhraseParts(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
}

function normalizePhrasePart(part: string): string | null {
    const normalized = part.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!normalized || normalized.length < 2 || /^\d+$/.test(normalized)) {
        return null;
    }

    return normalized;
}

function buildPhraseTokens(parts: string[]): string[] {
    const normalizedParts = parts
        .map((part) => normalizePhrasePart(part))
        .filter((part): part is string => Boolean(part));
    if (!normalizedParts.length) {
        return [];
    }

    const tokens: string[] = [];
    for (const part of normalizedParts) {
        if (part.length >= 6 || part === 'cli' || part === 'mcp' || part === 'sse' || part === 'cdp') {
            tokens.push(part);
        }
    }

    const maxWindow = Math.min(4, normalizedParts.length);
    for (let size = 2; size <= maxWindow; size += 1) {
        for (let start = 0; start + size <= normalizedParts.length; start += 1) {
            tokens.push(normalizedParts.slice(start, start + size).join(''));
        }
    }

    return uniqueTokens(tokens);
}

function collectPhraseTokens(
    text: string,
    relativePath: string,
    extraValues: string[] = [],
    allowInternalStrings = false
): string[] {
    const rawValues: string[] = [path.basename(relativePath), ...extraValues];

    for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
        const value = match[0] || '';
        if (!value || (!/[A-Z]/.test(value) && value.length < 12)) {
            continue;
        }
        rawValues.push(value);
    }

    for (const match of text.matchAll(/['"`]([^'"`\n]{2,240})['"`]/g)) {
        const value = (match[1] || '').replace(/\$\{[^}]+\}/g, ' ').trim();
        if (!allowInternalStrings && /^internal:/i.test(value)) {
            continue;
        }
        if (!value || (!/[A-Z:-]/.test(value) && !/(testid|selector|codegen|locator|mcp|config|timeout|browser)/i.test(value))) {
            continue;
        }
        rawValues.push(value);
    }

    return uniqueTokens(rawValues.flatMap((value) => buildPhraseTokens(splitPhraseParts(value)))).slice(0, MAX_PHRASE_TOKENS);
}

function collectRareAnchorTokens(
    text: string,
    relativePath: string,
    extraValues: string[] = [],
    includeInternalFragments = false
): string[] {
    const rawValues: string[] = [relativePath, path.basename(relativePath), ...extraValues, text];
    const anchors: string[] = [];

    for (const value of rawValues) {
        for (const pattern of RARE_ANCHOR_PATTERNS) {
            for (const match of value.matchAll(pattern)) {
                anchors.push(match[0]);
            }
        }
    }

    return uniqueTokens(
        anchors.flatMap((value) => collectIdentifierTokens(value, true))
    )
        .filter((token) => includeInternalFragments || !/(selector|attribute)/i.test(token))
        .slice(0, MAX_RARE_ANCHOR_TOKENS);
}

function collectPathSegments(value: string): string[] {
    const segments = normalizePathSeparators(value)
        .split('/')
        .flatMap((segment) => segment.split(/[._-]+/))
        .map((segment) => canonicalizeToken(segment, { skipStopWords: true }))
        .filter((segment): segment is string => Boolean(segment));

    return uniqueTokens(segments.filter((segment) => !GENERIC_PATH_SEGMENTS.has(segment)));
}

function buildPathFamilyTokensFromSegments(segments: string[]): string[] {
    const families: string[] = [];
    for (let size = 1; size <= Math.min(3, segments.length); size += 1) {
        for (let start = 0; start + size <= segments.length; start += 1) {
            families.push(segments.slice(start, start + size).join('/'));
        }
    }
    return uniqueTokens(families);
}

function collectPathFamilyTokens(relativePath: string, text: string): string[] {
    const values = [relativePath, ...collectImportedPaths(text)];
    return uniqueTokens(
        values.flatMap((value) => buildPathFamilyTokensFromSegments(collectPathSegments(value)))
    ).slice(0, MAX_PATH_FAMILY_TOKENS);
}

function collectChangeSignalValues(changedLines: string[]): string[] {
    const values: string[] = [];

    const pushMatches = (line: string, pattern: RegExp) => {
        for (const match of line.matchAll(pattern)) {
            const value = match[0].trim();
            if (value) {
                values.push(value);
            }
        }
    };

    for (const line of changedLines) {
        pushMatches(line, /\b[A-Za-z_][A-Za-z0-9_]*\b/g);

        for (const match of line.matchAll(/['"`]([^'"`\n]{1,240})['"`]/g)) {
            const value = (match[1] || '').replace(/\$\{[^}]+\}/g, ' ').trim();
            if (value) {
                values.push(value);
            }
        }

        pushMatches(line, /--[a-z0-9][a-z0-9-]*/gi);
        pushMatches(line, /\b(?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\b/g);
        pushMatches(line, /\b[a-z-]+:[a-z-]+\b/gi);
    }

    return values;
}

function collectChangedTokens(changedLines: ChangedLines, collect: (lines: string[]) => string[]): string[] {
    const added = collect(changedLines.added);
    const removed = collect(changedLines.removed);
    const count = (tokens: string[]): Map<string, number> => {
        const counts = new Map<string, number>();
        for (const token of tokens) {
            counts.set(token, (counts.get(token) || 0) + 1);
        }
        return counts;
    };
    const addedCounts = count(added);
    const removedCounts = count(removed);

    const changedTokens = uniqueTokens([...added, ...removed].filter(
        (token) => addedCounts.get(token) !== removedCounts.get(token)
    ));
    return changedTokens.length
        ? changedTokens
        : uniqueTokens(added.filter((token) => removedCounts.has(token)));
}

function isUsefulChangeToken(token: string): boolean {
    const canonicalToken = canonicalizeToken(token);
    return Boolean(canonicalToken && !GENERIC_CHANGE_TOKENS.has(canonicalToken));
}

function collectChangeTokens(changedLines: ChangedLines): string[] {
    return collectChangedTokens(changedLines, (lines) =>
        collectChangeSignalValues(lines)
            .flatMap((value) => tokenizeText(value))
            .filter(isUsefulChangeToken)
    ).slice(0, MAX_CHANGE_TOKENS);
}

function collectChangePhraseTokens(changedLines: ChangedLines, relativePath: string): string[] {
    return collectChangedTokens(changedLines, (lines) => {
        const values = collectChangeSignalValues(lines);

        return [
            ...values.flatMap((value) => buildPhraseTokens(splitPhraseParts(value))),
            ...collectRareAnchorTokens(values.join('\n'), relativePath, values, true),
        ].filter(isUsefulChangeToken);
    }).slice(0, MAX_CHANGE_PHRASE_TOKENS);
}

// Keeps an unterminated string instead of failing the match, which made the scan retry at every quote.
function stripClosedString(match: string, closingQuote?: string): string {
    return closingQuote ? ' ' : match;
}

function stripCommentsAndStrings(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ')
        .replace(/'(?:[^'\\]|\\.)*(')?/g, stripClosedString)
        .replace(/"(?:[^"\\]|\\.)*(")?/g, stripClosedString)
        .replace(/`(?:[^`\\]|\\.)*(`)?/g, stripClosedString);
}

function collectLateCallTokens(text: string, contentTokens: string[]): string[] {
    const tokens: string[] = [];
    for (const match of text.matchAll(/\b((?:[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\?\.|\.)\s*)*[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\?\.)?\(/g)) {
        tokens.push(...tokenizeText(match[1]));
    }
    const retainedContentTokens = new Set(contentTokens);
    // ponytail: bounded overflow; use source-aware call matching if 128 unseen call tokens is too small.
    return uniqueTokens(tokens)
        .filter((token) => !retainedContentTokens.has(token))
        .slice(0, MAX_LATE_CALL_TOKENS);
}

// `.test`/`.spec` files and Deno's `_test` files.
const TEST_FILE_NAME = /(?:\.(?:test|spec)|_test)\.[cm]?[jt]sx?$/i;

function determineKind(relativePath: string): DocumentKind {
    const normalized = normalizePathSeparators(relativePath);
    if (TEST_FILE_NAME.test(normalized)) {
        return 'test';
    }
    // Fixtures often live under test directories, so they are recognized first.
    if (/(^|\/)(fixture|fixtures|__fixtures__)\//i.test(normalized) || /\.(fixture)\.[cm]?[jt]sx?$/i.test(normalized)) {
        return 'fixture';
    }
    if (/(^|\/)(test|tests|__tests__)\//i.test(normalized)) {
        return 'test';
    }

    return 'source';
}

function createSummary(profile: Omit<DocumentProfile, 'summary' | 'preview'>): string {
    const subject = profile.kind === 'test' ? 'test file' : profile.kind === 'fixture' ? 'fixture file' : 'source module';
    const focus = profile.semanticTokens.slice(0, 12).join(', ');
    const lines = [`${subject} about ${focus || profile.basenameTokens.join(', ')}`];

    if (profile.changePhraseTokens.length) {
        lines.push(`changes: ${profile.changePhraseTokens.slice(0, 8).join(', ')}`);
    }

    if (profile.exports.length) {
        lines.push(`exports: ${profile.exports.slice(0, 8).join(', ')}`);
    }

    if (profile.imports.length) {
        lines.push(`imports: ${profile.imports.slice(0, 8).join(', ')}`);
    }

    if (profile.testNames.length) {
        lines.push(`tests: ${profile.testNames.slice(0, 4).join(' | ')}`);
    }

    if (profile.commandTokens.length) {
        lines.push(`commands: ${profile.commandTokens.slice(0, 6).join(', ')}`);
    }

    if (profile.optionTokens.length) {
        lines.push(`options: ${profile.optionTokens.slice(0, 8).join(', ')}`);
    }

    if (profile.pathFamilyTokens.length) {
        lines.push(`paths: ${profile.pathFamilyTokens.slice(0, 6).join(', ')}`);
    }

    if (profile.rareAnchorTokens.length) {
        lines.push(`anchors: ${profile.rareAnchorTokens.slice(0, 8).join(', ')}`);
    }

    return lines.join('\n');
}

/**
 * Whether a file can be handed to a test runner: a test file by name, or a file outside fixtures
 * that declares tests, such as `e2e/checkout.ts`. A helper or fixture in a test directory is neither.
 */
export function isTestLikeSource(relativePath: string, text: string): boolean {
    return TEST_FILE_NAME.test(normalizePathSeparators(relativePath))
        || (determineKind(relativePath) !== 'fixture' && collectTestTitles(text).length > 0);
}

/** {@link isTestLikeSource} for an already built profile. */
export function isTestLike(profile: DocumentProfile): boolean {
    return TEST_FILE_NAME.test(normalizePathSeparators(profile.relativePath))
        || (profile.kind !== 'fixture' && profile.testTitles.length > 0);
}

export function buildDocumentProfile(
    filePath: string,
    text: string,
    cwd = process.cwd(),
    diffText?: string,
    diffRoot?: string
): DocumentProfile {
    const absolutePath = path.resolve(cwd, filePath);
    const relativePath = normalizePathSeparators(path.relative(cwd, absolutePath));
    const basename = path.basename(absolutePath);
    const basenameTokens = tokenizeText(basename);
    const stemTokens = collectStemTokens(basename);
    const pathFamilyTokens = collectPathFamilyTokens(relativePath, text);
    const changedLines = collectChangedLines(diffText, relativePath, cwd, diffRoot);
    const phraseTokens = collectPhraseTokens(text, relativePath);
    const rareAnchorTokens = collectRareAnchorTokens(text, relativePath);
    const hasChangedLines = changedLines.added.length > 0 || changedLines.removed.length > 0;
    const changeTokens = hasChangedLines
        ? collectChangeTokens(changedLines)
        : [];
    const changePhraseTokens = hasChangedLines
        ? collectChangePhraseTokens(changedLines, relativePath)
        : [];
    const kind = determineKind(relativePath);
    const exports = collectExportedSymbols(text);
    const imports = collectImportedSymbols(text);
    const testNames = collectTestNames(text);
    const testTitles = collectTestTitles(text);
    const commandTokens = collectCommandTokens(text);
    const optionTokens = collectOptionTokens(text);
    const contentText = stripCommentsAndStrings(text);
    const contentTokens = uniqueTokens(tokenizeText(contentText));
    const boundedContentTokens = contentTokens.slice(0, MAX_CONTENT_TOKENS);
    const lateCallTokens = collectLateCallTokens(contentText, boundedContentTokens);

    const changeSemanticTokens = uniqueTokens([
        ...changeTokens,
        ...changePhraseTokens,
    ]).slice(0, MAX_CHANGE_SEMANTIC_TOKENS);
    const semanticTokens = [
        ...changeSemanticTokens,
        ...interleaveUniqueTokens(
            [
                basenameTokens,
                stemTokens,
                pathFamilyTokens,
                exports,
                imports,
                testNames,
                commandTokens,
                optionTokens,
                rareAnchorTokens,
                contentTokens,
            ],
            MAX_SEMANTIC_TOKENS - changeSemanticTokens.length
        ),
    ];

    const partialProfile = {
        absolutePath,
        relativePath,
        basename,
        basenameTokens,
        stemTokens,
        pathFamilyTokens,
        phraseTokens,
        rareAnchorTokens,
        changeTokens,
        changePhraseTokens,
        kind,
        exports,
        imports,
        testNames,
        testTitles,
        commandTokens,
        optionTokens,
        contentTokens: boundedContentTokens,
        lateCallTokens,
        semanticTokens,
        diffExcerpt: changedLines.hunks.join('\n'),
    };

    const summary = createSummary(partialProfile);

    return {
        ...partialProfile,
        summary,
        preview: (summary.split('\n')[0] || relativePath).slice(0, MAX_PREVIEW_LENGTH),
    };
}
