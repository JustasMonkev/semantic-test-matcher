import path from 'node:path';
import { interleaveUniqueTokens } from '../utils/arrays.ts';
import { normalizePathSeparators } from '../utils/paths.ts';
import { canonicalizeToken, splitIntoParts, tokenizeText, uniqueTokens } from './text-utils.ts';
import { collectChangedLines, type ChangedLines } from './unified-diff.ts';

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
    'src', 'test', 'tests', 'lib', 'dist', 'build', 'package', 'packages', 'packag', 'fixture', 'fixtures',
    'playwright', 'core', 'spec', 'ts', 'js', 'mjs', 'cjs', 'mts', 'cts', 'util', 'utils',
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

const GENERIC_ANCHOR_TOKENS = new Set(['id', 'name', 'selector', 'attribute', 'config', 'browser', 'command', 'option']);
const GENERIC_CHANGE_TOKENS = new Set([...GENERIC_ANCHOR_TOKENS, 'is']);
const INTERNAL_ANCHOR_FRAGMENT = /(selector|attribute)/i;
const SHORT_PHRASE_PARTS_KEPT = new Set(['cli', 'mcp', 'sse', 'cdp']);
const MIN_STANDALONE_PHRASE_PART_LENGTH = 6;
const MAX_PHRASE_WINDOW = 4;
const MAX_PATH_FAMILY_DEPTH = 3;

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

const NOT_AFTER_IDENTIFIER_OR_DOT = '(?<![\\w$.])';
const TEST_FUNCTION = '(?:Deno\\.test|test|it|describe)';
const TEST_MODIFIERS = '(?:\\.(?:describe|only|skip|ignore|todo|fixme|fail|failing|slow|serial|parallel|concurrent|sequential))*';
const TAGGED_TEMPLATE_TABLE = '`[^`]{0,4000}`';
const BOUNDED_CALL_ARGUMENTS = '\\((?:[^()]|\\([^()]{0,400}\\)){0,4000}\\)';
const PARAMETRIZED_CALL = `(?:\\.(?:each|for|skipIf|runIf)(?:${TAGGED_TEMPLATE_TABLE}|${BOUNDED_CALL_ARGUMENTS}))?`;
const QUOTED_TITLE_ARGUMENT = '\\(\\s*([\'"`])((?:\\\\.|(?!\\1|\\\\).)+)\\1';
const TEST_TITLE_PATTERN = new RegExp(
    NOT_AFTER_IDENTIFIER_OR_DOT + TEST_FUNCTION + TEST_MODIFIERS + PARAMETRIZED_CALL + QUOTED_TITLE_ARGUMENT,
    'g'
);

const TEST_FILE_NAME = /(?:\.(?:test|spec)|_test)\.[cm]?[jt]sx?$/i;
const FIXTURE_PATH = /(^|\/)(fixture|fixtures|__fixtures__)\//i;
const FIXTURE_FILE_NAME = /\.(fixture)\.[cm]?[jt]sx?$/i;
const TEST_DIRECTORY_PATH = /(^|\/)(test|tests|__tests__)\//i;

const KEYWORDS_FOLLOWED_BY_EXPRESSION = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const KEYWORDS_FOLLOWED_BY_STATEMENT = new Set(['if', 'while', 'for', 'with']);
const IDENTIFIER_CHARACTER = /[\w$]/;

function splitPhraseParts(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
}

function normalizePhrasePart(part: string): string | undefined {
    const normalized = part.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const isMeaningful = normalized.length >= 2 && !/^\d+$/.test(normalized);
    return isMeaningful ? normalized : undefined;
}

function phraseTokensOf(value: string): string[] {
    const parts = splitPhraseParts(value)
        .map(normalizePhrasePart)
        .filter((part): part is string => part !== undefined);

    const standaloneParts = parts.filter((part) =>
        part.length >= MIN_STANDALONE_PHRASE_PART_LENGTH || SHORT_PHRASE_PARTS_KEPT.has(part)
    );
    const joinedWindows: string[] = [];
    for (let size = 2; size <= Math.min(MAX_PHRASE_WINDOW, parts.length); size += 1) {
        for (let start = 0; start + size <= parts.length; start += 1) {
            joinedWindows.push(parts.slice(start, start + size).join(''));
        }
    }
    return uniqueTokens([...standaloneParts, ...joinedWindows]);
}

function identifierTokens(value: string): string[] {
    return uniqueTokens([...tokenizeText(value), ...phraseTokensOf(value)]);
}

function collectCaptures(text: string, pattern: RegExp, toTokens: (captured: string) => string[] = tokenizeText): string[] {
    const tokens: string[] = [];
    for (const match of text.matchAll(pattern)) {
        if (match[1]) {
            tokens.push(...toTokens(match[1]));
        }
    }
    return uniqueTokens(tokens);
}

function originalNamesInBraceList(list: string): string[] {
    return list
        .split(',')
        .map((entry) => entry.split(/\s+as\s+/i)[0].trim())
        .filter(Boolean)
        .flatMap(identifierTokens);
}

function collectExportedSymbols(text: string): string[] {
    return uniqueTokens([
        ...collectCaptures(text, /export\s+(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g, identifierTokens),
        ...collectCaptures(text, /export\s+(?:class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g, identifierTokens),
        ...collectCaptures(text, /export\s+(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g, identifierTokens),
        ...collectCaptures(text, /export\s*{\s*([^}]+)\s*}/g, originalNamesInBraceList),
    ]);
}

function collectImportedSymbols(text: string): string[] {
    return uniqueTokens([
        ...collectCaptures(text, /import\s+{([^}]+)}\s+from\s+['"][^'"]+['"]/g, originalNamesInBraceList),
        ...collectCaptures(text, /import\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+['"][^'"]+['"]/g, identifierTokens),
    ]);
}

function collectImportedPaths(text: string): string[] {
    return uniqueTokens(
        Array.from(text.matchAll(/(?:from|require\s*\()\s*['"]([^'"]+)['"]/g))
            .map((match) => match[1]?.trim())
            .filter((value): value is string => Boolean(value))
    );
}

function collectTestNames(text: string): string[] {
    return collectCaptures(text, /(?:describe|it|test)\s*\(\s*['"`]([^'"`]{1,160})['"`]/g, (name) => {
        const trimmed = name.trim();
        return trimmed ? identifierTokens(trimmed) : [];
    });
}

function maskNonCode(text: string): string {
    let masked = '';
    let previousCodeCharacter = '';
    let lastWord = '';
    let lastClosedParenEndedStatementHead = false;
    const openParensAreStatementHeads: boolean[] = [];

    const slashStartsRegex = () => {
        if (previousCodeCharacter === ')') {
            return lastClosedParenEndedStatementHead;
        }
        if (IDENTIFIER_CHARACTER.test(previousCodeCharacter)) {
            return KEYWORDS_FOLLOWED_BY_EXPRESSION.has(lastWord);
        }
        return previousCodeCharacter !== ']';
    };

    let index = 0;
    while (index < text.length) {
        const character = text[index];
        const next = text[index + 1];

        const startsComment = character === '/' && (next === '/' || next === '*');
        if (startsComment) {
            const close = next === '/' ? text.indexOf('\n', index) : text.indexOf('*/', index + 2);
            const end = close === -1 ? text.length : next === '/' ? close : close + 2;
            masked += text.slice(index, end).replace(/[^\n]/g, ' ');
            index = end;
            continue;
        }

        const startsLiteral = character === '"' || character === "'" || character === '`' || (character === '/' && slashStartsRegex());
        if (startsLiteral) {
            const spansLines = character === '`';
            let end = index + 1;
            while (end < text.length && text[end] !== character && (spansLines || text[end] !== '\n')) {
                end += text[end] === '\\' ? 2 : 1;
            }
            end = Math.min(end, text.length);
            const closed = text[end] === character;
            masked += character + text.slice(index + 1, end).replace(/[^\n]/g, 'x') + (closed ? character : '');
            index = closed ? end + 1 : end;
            previousCodeCharacter = 'x';
            lastWord = '';
            continue;
        }

        masked += character;
        if (IDENTIFIER_CHARACTER.test(character)) {
            const continuesWord = IDENTIFIER_CHARACTER.test(text[index - 1] ?? '');
            lastWord = continuesWord ? lastWord + character : character;
        } else if (character === '(') {
            const opensStatementHead = IDENTIFIER_CHARACTER.test(previousCodeCharacter) && KEYWORDS_FOLLOWED_BY_STATEMENT.has(lastWord);
            openParensAreStatementHeads.push(opensStatementHead);
        } else if (character === ')') {
            lastClosedParenEndedStatementHead = openParensAreStatementHeads.pop() ?? false;
        }
        if (!/\s/.test(character)) {
            previousCodeCharacter = character;
        }
        index += 1;
    }
    return masked;
}

function collectTestTitles(text: string): string[] {
    const code = maskNonCode(text);
    const titles: string[] = [];
    for (const match of text.matchAll(TEST_TITLE_PATTERN)) {
        const callIsCode = code[match.index] === text[match.index];
        const title = match[2].trim().slice(0, MAX_TITLE_LENGTH);
        if (callIsCode && title) {
            titles.push(title);
        }
    }
    return uniqueTokens(titles);
}

function collectStemTokens(basename: string): string[] {
    const stem = basename
        .replace(/\.[^.]+$/u, '')
        .replace(/\.(test|spec)$/iu, '');

    return uniqueTokens(
        splitIntoParts(stem)
            .map((token) => canonicalizeToken(token, { keepStopWords: true }))
            .filter((token): token is string => Boolean(token))
    );
}

function collectCommandTokens(text: string): string[] {
    return collectCaptures(text, /\.\s*command\s*\(\s*['"`]([^'"`]{1,160})['"`]/g);
}

function collectOptionTokens(text: string): string[] {
    return uniqueTokens(
        Array.from(text.matchAll(/--[a-z0-9][a-z0-9-]*/gi))
            .map((match) => match[0].replace(/^--/, ''))
            .flatMap(tokenizeText)
    );
}

function withoutTemplateExpressions(value: string): string {
    return value.replace(/\$\{[^}]+\}/g, ' ').trim();
}

function isPhraseWorthyIdentifier(identifier: string): boolean {
    return /[A-Z]/.test(identifier) || identifier.length >= 12;
}

function isPhraseWorthyString(value: string): boolean {
    if (!value || /^internal:/i.test(value)) {
        return false;
    }
    return /[A-Z:-]/.test(value) || /(testid|selector|codegen|locator|mcp|config|timeout|browser)/i.test(value);
}

function collectPhraseTokens(text: string, relativePath: string): string[] {
    const identifiers = Array.from(text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g), (match) => match[0])
        .filter(isPhraseWorthyIdentifier);
    const strings = Array.from(text.matchAll(/['"`]([^'"`\n]{2,240})['"`]/g), (match) => withoutTemplateExpressions(match[1]))
        .filter(isPhraseWorthyString);
    const values = [path.basename(relativePath), ...identifiers, ...strings];
    return uniqueTokens(values.flatMap(phraseTokensOf)).slice(0, MAX_PHRASE_TOKENS);
}

function anchorTokensIn(values: string[]): string[] {
    const anchors = values.flatMap((value) =>
        RARE_ANCHOR_PATTERNS.flatMap((pattern) => Array.from(value.matchAll(pattern), (match) => match[0]))
    );
    return uniqueTokens(anchors.flatMap(identifierTokens)).filter((token) => !GENERIC_ANCHOR_TOKENS.has(token));
}

function collectRareAnchorTokens(text: string, relativePath: string): string[] {
    return anchorTokensIn([relativePath, path.basename(relativePath), text])
        .filter((token) => !INTERNAL_ANCHOR_FRAGMENT.test(token))
        .slice(0, MAX_RARE_ANCHOR_TOKENS);
}

function pathSegments(value: string): string[] {
    const segments = normalizePathSeparators(value)
        .split('/')
        .flatMap((segment) => segment.split(/[._-]+/))
        .map((segment) => canonicalizeToken(segment, { keepStopWords: true }))
        .filter((segment): segment is string => Boolean(segment));

    return uniqueTokens(segments.filter((segment) => !GENERIC_PATH_SEGMENTS.has(segment)));
}

function pathFamilies(segments: string[]): string[] {
    const families: string[] = [];
    for (let size = 1; size <= Math.min(MAX_PATH_FAMILY_DEPTH, segments.length); size += 1) {
        for (let start = 0; start + size <= segments.length; start += 1) {
            families.push(segments.slice(start, start + size).join('/'));
        }
    }
    return uniqueTokens(families);
}

function collectPathFamilyTokens(relativePath: string, text: string): string[] {
    const paths = [relativePath, ...collectImportedPaths(text)];
    return uniqueTokens(paths.flatMap((value) => pathFamilies(pathSegments(value)))).slice(0, MAX_PATH_FAMILY_TOKENS);
}

const CHANGE_SIGNAL_PATTERNS = {
    identifier: /\b[A-Za-z_][A-Za-z0-9_]*\b/g,
    quotedString: /['"`]([^'"`\n]{1,240})['"`]/g,
    cliOption: /--[a-z0-9][a-z0-9-]*/gi,
    slashPath: /\b(?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\b/g,
    namespacedName: /\b[a-z-]+:[a-z-]+\b/gi,
};

function collectChangeSignalValues(changedLines: string[]): string[] {
    const values: string[] = [];
    const addMatches = (line: string, pattern: RegExp) => {
        for (const match of line.matchAll(pattern)) {
            const value = match[0].trim();
            if (value) {
                values.push(value);
            }
        }
    };

    for (const line of changedLines) {
        addMatches(line, CHANGE_SIGNAL_PATTERNS.identifier);
        for (const match of line.matchAll(CHANGE_SIGNAL_PATTERNS.quotedString)) {
            const value = withoutTemplateExpressions(match[1]);
            if (value) {
                values.push(value);
            }
        }
        addMatches(line, CHANGE_SIGNAL_PATTERNS.cliOption);
        addMatches(line, CHANGE_SIGNAL_PATTERNS.slashPath);
        addMatches(line, CHANGE_SIGNAL_PATTERNS.namespacedName);
    }
    return values;
}

function countOccurrences(tokens: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const token of tokens) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
}

function tokensWhoseCountChanged(changedLines: ChangedLines, tokensOf: (lines: string[]) => string[]): string[] {
    const added = tokensOf(changedLines.added);
    const removed = tokensOf(changedLines.removed);
    const addedCounts = countOccurrences(added);
    const removedCounts = countOccurrences(removed);

    const changedTokens = uniqueTokens([...added, ...removed].filter(
        (token) => addedCounts.get(token) !== removedCounts.get(token)
    ));
    const onlyMovedTokens = uniqueTokens(added.filter((token) => removedCounts.has(token)));
    return changedTokens.length ? changedTokens : onlyMovedTokens;
}

function isUsefulChangeToken(token: string): boolean {
    const canonicalToken = canonicalizeToken(token);
    return Boolean(canonicalToken && !GENERIC_CHANGE_TOKENS.has(canonicalToken));
}

function collectChangeTokens(changedLines: ChangedLines): string[] {
    return tokensWhoseCountChanged(changedLines, (lines) =>
        collectChangeSignalValues(lines)
            .flatMap(tokenizeText)
            .filter(isUsefulChangeToken)
    ).slice(0, MAX_CHANGE_TOKENS);
}

function collectChangePhraseTokens(changedLines: ChangedLines, relativePath: string): string[] {
    return tokensWhoseCountChanged(changedLines, (lines) => {
        const values = collectChangeSignalValues(lines);
        return [
            ...values.flatMap(phraseTokensOf),
            ...anchorTokensIn([relativePath, path.basename(relativePath), ...values]).slice(0, MAX_RARE_ANCHOR_TOKENS),
        ].filter(isUsefulChangeToken);
    }).slice(0, MAX_CHANGE_PHRASE_TOKENS);
}

function blankClosedLiteral(literal: string, closingQuote?: string): string {
    return closingQuote ? ' ' : literal;
}

function stripCommentsAndStrings(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ')
        .replace(/'(?:[^'\\]|\\.)*(')?/g, blankClosedLiteral)
        .replace(/"(?:[^"\\]|\\.)*(")?/g, blankClosedLiteral)
        .replace(/`(?:[^`\\]|\\.)*(`)?/g, blankClosedLiteral);
}

function collectLateCallTokens(code: string, keptContentTokens: string[]): string[] {
    const calledNames = /\b((?:[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\?\.|\.)\s*)*[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\?\.)?\(/g;
    const tokens = Array.from(code.matchAll(calledNames)).flatMap((match) => tokenizeText(match[1]));
    const alreadyKept = new Set(keptContentTokens);
    return uniqueTokens(tokens)
        .filter((token) => !alreadyKept.has(token))
        .slice(0, MAX_LATE_CALL_TOKENS);
}

function determineKind(relativePath: string): DocumentKind {
    const normalized = normalizePathSeparators(relativePath);
    if (hasTestFileName(normalized)) {
        return 'test';
    }
    if (FIXTURE_PATH.test(normalized) || FIXTURE_FILE_NAME.test(normalized)) {
        return 'fixture';
    }
    if (TEST_DIRECTORY_PATH.test(normalized)) {
        return 'test';
    }
    return 'source';
}

type TokenListField = { [K in keyof DocumentProfile]: DocumentProfile[K] extends string[] ? K : never }[keyof DocumentProfile];

const SUMMARY_SECTIONS: Array<{ label: string; field: TokenListField; limit: number; separator?: string }> = [
    { label: 'changes', field: 'changePhraseTokens', limit: 8 },
    { label: 'exports', field: 'exports', limit: 8 },
    { label: 'imports', field: 'imports', limit: 8 },
    { label: 'tests', field: 'testNames', limit: 4, separator: ' | ' },
    { label: 'commands', field: 'commandTokens', limit: 6 },
    { label: 'options', field: 'optionTokens', limit: 8 },
    { label: 'paths', field: 'pathFamilyTokens', limit: 6 },
    { label: 'anchors', field: 'rareAnchorTokens', limit: 8 },
];

const SUBJECT_BY_KIND: Record<DocumentKind, string> = {
    test: 'test file',
    fixture: 'fixture file',
    source: 'source module',
    unknown: 'source module',
};

function createSummary(profile: Omit<DocumentProfile, 'summary' | 'preview'>): string {
    const focus = profile.semanticTokens.slice(0, 12).join(', ') || profile.basenameTokens.join(', ');
    const lines = [`${SUBJECT_BY_KIND[profile.kind]} about ${focus}`];
    for (const { label, field, limit, separator = ', ' } of SUMMARY_SECTIONS) {
        const values = profile[field];
        if (values.length) {
            lines.push(`${label}: ${values.slice(0, limit).join(separator)}`);
        }
    }
    return lines.join('\n');
}

function hasTestFileName(relativePath: string): boolean {
    return TEST_FILE_NAME.test(normalizePathSeparators(relativePath));
}

export function isTestLikeSource(relativePath: string, text: string): boolean {
    return hasTestFileName(relativePath)
        || (determineKind(relativePath) !== 'fixture' && collectTestTitles(text).length > 0);
}

export function isTestLike(profile: DocumentProfile): boolean {
    return hasTestFileName(profile.relativePath) || (profile.kind !== 'fixture' && profile.testTitles.length > 0);
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
    const hasChangedLines = changedLines.added.length > 0 || changedLines.removed.length > 0;
    const changeTokens = hasChangedLines ? collectChangeTokens(changedLines) : [];
    const changePhraseTokens = hasChangedLines ? collectChangePhraseTokens(changedLines, relativePath) : [];
    const exports = collectExportedSymbols(text);
    const imports = collectImportedSymbols(text);
    const testNames = collectTestNames(text);
    const commandTokens = collectCommandTokens(text);
    const optionTokens = collectOptionTokens(text);
    const rareAnchorTokens = collectRareAnchorTokens(text, relativePath);
    const code = stripCommentsAndStrings(text);
    const allContentTokens = uniqueTokens(tokenizeText(code));
    const contentTokens = allContentTokens.slice(0, MAX_CONTENT_TOKENS);

    const changeSemanticTokens = uniqueTokens([...changeTokens, ...changePhraseTokens]).slice(0, MAX_CHANGE_SEMANTIC_TOKENS);
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
                allContentTokens,
            ],
            MAX_SEMANTIC_TOKENS - changeSemanticTokens.length
        ),
    ];

    const profile = {
        absolutePath,
        relativePath,
        basename,
        basenameTokens,
        stemTokens,
        pathFamilyTokens,
        phraseTokens: collectPhraseTokens(text, relativePath),
        rareAnchorTokens,
        changeTokens,
        changePhraseTokens,
        kind: determineKind(relativePath),
        exports,
        imports,
        testNames,
        testTitles: collectTestTitles(text),
        commandTokens,
        optionTokens,
        contentTokens,
        lateCallTokens: collectLateCallTokens(code, contentTokens),
        semanticTokens,
        diffExcerpt: changedLines.hunks.join('\n'),
    };
    const summary = createSummary(profile);

    return {
        ...profile,
        summary,
        preview: (summary.split('\n')[0] || relativePath).slice(0, MAX_PREVIEW_LENGTH),
    };
}
