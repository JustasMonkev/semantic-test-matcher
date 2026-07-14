import path from 'node:path';
import { canonicalizeToken, tokenizeText, uniqueTokens } from './text-utils.ts';

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
    commandTokens: string[];
    optionTokens: string[];
    contentTokens: string[];
    semanticTokens: string[];
    summary: string;
    embeddingText: string;
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

interface ChangedLines {
    added: string[];
    removed: string[];
}

const MAX_SEMANTIC_TOKENS = 72;
const MAX_CHANGE_SEMANTIC_TOKENS = 24;
const MAX_EMBEDDING_SECTION_TOKENS = 32;
const MAX_EMBEDDING_WORDS = 512;

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
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

    for (const match of value.matchAll(regex)) {
        const captured = match[1] || '';
        if (!captured) {
            continue;
        }

        const segments = splitter ? splitter(captured) : tokenizeText(captured);
        matches.push(...segments);
    }

    return uniqueTokens(matches);
}

function collectExportedSymbols(text: string): string[] {
    const direct = collectMatches(
        text,
        /export\s+(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        (input) => collectIdentifierTokens(input)
    );
    const classes = collectMatches(
        text,
        /export\s+(?:class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        (input) => collectIdentifierTokens(input)
    );
    const variables = collectMatches(
        text,
        /export\s+(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        (input) => collectIdentifierTokens(input)
    );
    const braceExports = collectMatches(
        text,
        /export\s*{\s*([^}]+)\s*}/g,
        (input) =>
            input
                .split(',')
                .map((entry) => entry.split(/\s+as\s+/i)[0].trim())
                .filter(Boolean)
                .flatMap((entry) => collectIdentifierTokens(entry))
    );

    return uniqueTokens([...direct, ...classes, ...variables, ...braceExports]);
}

function collectImportedSymbols(text: string): string[] {
    const direct = collectMatches(text, /import\s+{([^}]+)}\s+from\s+['"][^'"]+['"]/g, (input) =>
        input
            .split(',')
            .map((entry) => entry.split(/\s+as\s+/i)[0].trim())
            .filter(Boolean)
            .flatMap((entry) => collectIdentifierTokens(entry))
    );
    const defaultImports = collectMatches(
        text,
        /import\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+['"][^'"]+['"]/g,
        (input) => collectIdentifierTokens(input)
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

function collectStemTokens(basename: string): string[] {
    const stem = basename
        .replace(/\.[^.]+$/u, '')
        .replace(/\.(test|spec)$/iu, '');

    return uniqueTokens(
        stem
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[_./\\-]+/g, ' ')
            .split(/\s+/)
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

    return uniqueTokens(rawValues.flatMap((value) => buildPhraseTokens(splitPhraseParts(value)))).slice(0, 128);
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
            const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
            for (const match of value.matchAll(regex)) {
                anchors.push(match[0]);
            }
        }
    }

    return uniqueTokens(
        anchors.flatMap((value) => collectIdentifierTokens(value, true))
    )
        .filter((token) => includeInternalFragments || !/(selector|attribute)/i.test(token))
        .slice(0, 96);
}

function collectPathSegments(value: string): string[] {
    const segments = value
        .replace(/\\/g, '/')
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
    ).slice(0, 96);
}

function interleaveUniqueTokens(groups: string[][], limit: number): string[] {
    const tokens: string[] = [];
    const seen = new Set<string>();

    for (let index = 0; tokens.length < limit; index += 1) {
        let hasValue = false;
        for (const group of groups) {
            const token = group[index];
            if (token === undefined) {
                continue;
            }
            hasValue = true;
            if (!seen.has(token)) {
                seen.add(token);
                tokens.push(token);
                if (tokens.length === limit) {
                    break;
                }
            }
        }
        if (!hasValue) {
            break;
        }
    }

    return tokens;
}

function inferGitPrefixes(line: string, relativePath: string): [string, string] | undefined {
    const paths = /^diff --git ("(?:\\.|[^"])*"|\S+) ("(?:\\.|[^"])*"|\S+)$/.exec(line);
    if (!paths) {
        return undefined;
    }

    const [oldPath, newPath] = paths.slice(1).map(value => value.replace(/^"|"$/g, ''));
    const oldPrefix = oldPath.endsWith(relativePath)
        ? oldPath.slice(0, -relativePath.length)
        : undefined;
    const newPrefix = newPath.endsWith(relativePath)
        ? newPath.slice(0, -relativePath.length)
        : undefined;
    return oldPrefix && newPrefix && oldPrefix !== newPrefix
        ? [oldPrefix, newPrefix]
        : undefined;
}

function collectChangedLines(diffText: string | undefined, relativePath: string, cwd: string): ChangedLines {
    const changedLines: ChangedLines = { added: [], removed: [] };
    if (!diffText) {
        return changedLines;
    }

    let currentFileMatches = true;
    let inHunk = false;
    let oldLinesRemaining = 0;
    let newLinesRemaining = 0;
    let structuredDiff = false;
    let gitPrefixes: [string, string] | undefined = ['a/', 'b/'];
    const absolutePath = path.resolve(cwd, relativePath);
    for (const line of diffText.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
            currentFileMatches = false;
            inHunk = false;
            structuredDiff = true;
            gitPrefixes = inferGitPrefixes(line, relativePath);
            continue;
        }
        if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) {
            let diffPath = line.slice(4).split('\t', 1)[0].trim()
                .replace(/^"|"$/g, '');
            const prefix = line.startsWith('+++ ') ? gitPrefixes?.[1] : gitPrefixes?.[0];
            if (prefix && diffPath.startsWith(prefix)) {
                diffPath = diffPath.slice(prefix.length);
            }
            const diffPathMatches = path.resolve(cwd, diffPath) === absolutePath;
            currentFileMatches = line.startsWith('+++ ')
                ? currentFileMatches || diffPathMatches
                : diffPathMatches;
            structuredDiff = true;
            continue;
        }
        if (line.startsWith('@@')) {
            const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
            if (header) {
                oldLinesRemaining = Number(header[1] ?? 1);
                newLinesRemaining = Number(header[2] ?? 1);
                inHunk = true;
                structuredDiff = true;
            }
            continue;
        }
        if (!line || (!inHunk && structuredDiff)) {
            continue;
        }
        if (currentFileMatches) {
            if (line.startsWith('+')) {
                changedLines.added.push(line.slice(1));
            } else if (line.startsWith('-')) {
                changedLines.removed.push(line.slice(1));
            }
        }
        if (inHunk) {
            if (line.startsWith('+')) {
                newLinesRemaining -= 1;
            } else if (line.startsWith('-')) {
                oldLinesRemaining -= 1;
            } else if (line.startsWith(' ')) {
                oldLinesRemaining -= 1;
                newLinesRemaining -= 1;
            }
            inHunk = oldLinesRemaining > 0 || newLinesRemaining > 0;
        }
    }

    return changedLines;
}

function collectChangeSignalValues(changedLines: string[]): string[] {
    const values: string[] = [];

    for (const line of changedLines) {
        for (const match of line.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
            const value = match[0]?.trim();
            if (value) {
                values.push(value);
            }
        }

        for (const match of line.matchAll(/['"`]([^'"`\n]{1,240})['"`]/g)) {
            const value = (match[1] || '').replace(/\$\{[^}]+\}/g, ' ').trim();
            if (value) {
                values.push(value);
            }
        }

        for (const match of line.matchAll(/--[a-z0-9][a-z0-9-]*/gi)) {
            const value = match[0]?.trim();
            if (value) {
                values.push(value);
            }
        }

        for (const match of line.matchAll(/\b(?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\b/g)) {
            const value = match[0]?.trim();
            if (value) {
                values.push(value);
            }
        }

        for (const match of line.matchAll(/\b[a-z-]+:[a-z-]+\b/gi)) {
            const value = match[0]?.trim();
            if (value) {
                values.push(value);
            }
        }
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

    return uniqueTokens([...added, ...removed].filter(
        (token) => addedCounts.get(token) !== removedCounts.get(token)
    ));
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
    ).slice(0, 64);
}

function collectChangePhraseTokens(changedLines: ChangedLines, relativePath: string): string[] {
    return collectChangedTokens(changedLines, (lines) => {
        const values = collectChangeSignalValues(lines);

        return [
            ...values.flatMap((value) => buildPhraseTokens(splitPhraseParts(value))),
            ...collectRareAnchorTokens(values.join('\n'), relativePath, values, true),
        ].filter(isUsefulChangeToken);
    }).slice(0, 96);
}

function stripCommentsAndStrings(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ')
        .replace(/'([^'\\]|\\.)*'/g, ' ')
        .replace(/"([^"\\]|\\.)*"/g, ' ')
        .replace(/`([^`\\]|\\.)*`/g, ' ');
}

function determineKind(relativePath: string): DocumentKind {
    const normalized = relativePath.replace(/\\/g, '/');
    if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized) || /(^|\/)(test|tests)\//i.test(normalized)) {
        return 'test';
    }

    if (/(^|\/)(fixture|fixtures)\//i.test(normalized) || /\.(fixture)\.[cm]?[jt]sx?$/i.test(normalized)) {
        return 'fixture';
    }

    return 'source';
}

function createSummary(profile: Omit<DocumentProfile, 'summary' | 'embeddingText' | 'preview'>): string {
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

function createEmbeddingText(profile: Omit<DocumentProfile, 'summary' | 'embeddingText' | 'preview'> & { summary: string }): string {
    const buildSections = (limit?: number): string[] => {
        const take = (tokens: string[]): string[] => limit === undefined ? tokens : tokens.slice(0, limit);
        const sections = [
            `path: ${profile.relativePath}`,
            `kind: ${profile.kind}`,
            `basename: ${profile.basenameTokens.join(' ')}`,
            `summary: ${profile.summary}`,
        ];
        const tokenSections: Array<[string, string[]]> = [
            ['exports', profile.exports],
            ['imports', profile.imports],
            ['tests', profile.testNames],
            ['commands', profile.commandTokens],
            ['options', profile.optionTokens],
            ['path-families', profile.pathFamilyTokens],
            ['anchors', profile.rareAnchorTokens],
        ];

        for (const [label, tokens] of tokenSections) {
            if (tokens.length) {
                sections.push(`${label}: ${take(tokens).join(' ')}`);
            }
        }
        sections.push(`signals: ${profile.semanticTokens.join(' ')}`);
        return sections;
    };

    const completeText = buildSections().join('\n');
    return completeText.split(/\s+/).length <= MAX_EMBEDDING_WORDS
        ? completeText
        : buildSections(MAX_EMBEDDING_SECTION_TOKENS).join('\n');
}

export function buildDocumentProfile(
    filePath: string,
    text: string,
    cwd = process.cwd(),
    diffText?: string
): DocumentProfile {
    const absolutePath = path.resolve(cwd, filePath);
    const relativePath = path.relative(cwd, absolutePath).replace(/\\/g, '/');
    const basename = path.basename(absolutePath);
    const basenameTokens = tokenizeText(basename);
    const stemTokens = collectStemTokens(basename);
    const pathFamilyTokens = collectPathFamilyTokens(relativePath, text);
    const changedLines = collectChangedLines(diffText, relativePath, cwd);
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
    const commandTokens = collectCommandTokens(text);
    const optionTokens = collectOptionTokens(text);
    const contentTokens = uniqueTokens(tokenizeText(stripCommentsAndStrings(text)));

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
        commandTokens,
        optionTokens,
        contentTokens: contentTokens.slice(0, 64),
        semanticTokens,
    };

    const summary = createSummary(partialProfile);
    const embeddingText = createEmbeddingText({ ...partialProfile, summary });

    return {
        ...partialProfile,
        summary,
        embeddingText,
        preview: (summary.split('\n')[0] || relativePath).slice(0, 160),
    };
}
