import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ChangedLines {
    added: string[];
    removed: string[];
    hunks: string[];
}

type GitPrefixes = [string | undefined, string | undefined];

interface HunkCounts {
    oldLines: number;
    newLines: number;
}

/** Header state of one file in a diff; it ends with that file's `+++` line. */
interface FileSection {
    /** Present only in Git diffs; plain unified diffs have just `---`/`+++` headers. */
    gitDiffLine?: string;
    /** The old and new paths as written on the `diff --git` line, prefixes included. */
    gitPaths?: [string, string];
    /** Prefix-free old and new paths from `rename`/`copy` lines. */
    logicalPaths: [string | undefined, string | undefined];
    gitPrefixes?: GitPrefixes;
    isCopy: boolean;
    /** A plain diff's `---` path, kept until its `+++` path shows whether both use `a/`/`b/`. */
    plainOldPath?: string;
}

/** Where the profiled file is and which directories relative diff paths may resolve from. */
interface DiffTarget {
    absolutePath: string;
    cwd: string;
    rootPath: string;
    allowCwdRelativeGitPaths: boolean;
}

const GIT_DIFF_LINE_PREFIX = 'diff --git ';
const FILE_HEADER_PREFIX_LENGTH = '--- '.length;
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const HEADER_TIMESTAMP_PATTERN = /\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?(?: [+-]\d{4})?$/;
const RENAME_OR_COPY_PATTERN = /^(?:rename|copy) (?:from|to) /;

const GIT_ESCAPE_BYTES: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    '\\': 0x5c,
};

function decodeGitPath(value: string): string {
    if (!value.startsWith('"') || !value.endsWith('"')) {
        return value;
    }

    const bytes: number[] = [];
    const quotedValue = value.slice(1, -1);
    for (let index = 0; index < quotedValue.length; index += 1) {
        const character = quotedValue[index];
        if (character !== '\\') {
            const codePoint = quotedValue.codePointAt(index);
            if (codePoint !== undefined) {
                bytes.push(...Buffer.from(String.fromCodePoint(codePoint)));
                if (codePoint > 0xffff) {
                    index += 1;
                }
            }
            continue;
        }

        const escapedCharacter = quotedValue[index + 1];
        if (escapedCharacter === undefined) {
            bytes.push(0x5c);
            continue;
        }
        const octal = /^[0-7]{1,3}/.exec(quotedValue.slice(index + 1))?.[0];
        if (octal) {
            bytes.push(Number.parseInt(octal, 8));
            index += octal.length;
            continue;
        }
        const escapedByte = GIT_ESCAPE_BYTES[escapedCharacter];
        if (escapedByte !== undefined) {
            bytes.push(escapedByte);
            index += 1;
            continue;
        }
        bytes.push(0x5c, ...Buffer.from(escapedCharacter));
        index += 1;
    }

    return Buffer.from(bytes).toString('utf8');
}

function isStandardPrefixPair(oldPath: string, newPath: string): boolean {
    return oldPath.startsWith('a/') && newPath.startsWith('b/') && oldPath.slice(2) === newPath.slice(2);
}

/** Splits unquoted `diff --git` paths, which may contain spaces, after the last `<oldPath> `. */
function splitAfterOldPath(value: string, oldPath: string, newPath: string): [string, string] | undefined {
    const oldPathStart = value.lastIndexOf(`${oldPath} `);
    if (oldPathStart === -1) {
        return undefined;
    }

    const oldPathEnd = oldPathStart + oldPath.length;
    const paths: [string, string] = [value.slice(0, oldPathEnd), value.slice(oldPathEnd + 1)];
    return paths[1].endsWith(newPath) ? paths : undefined;
}

function parseGitDiffPaths(line: string, relativePath: string): [string, string] | undefined {
    const value = line.slice(GIT_DIFF_LINE_PREFIX.length);
    const tokenizedPaths = /^("(?:\\.|[^"\\])*"|\S+) ("(?:\\.|[^"\\])*"|\S+)$/.exec(value);
    if (tokenizedPaths) {
        return [decodeGitPath(tokenizedPaths[1]), decodeGitPath(tokenizedPaths[2])];
    }

    const samePaths = splitAfterOldPath(value, relativePath, relativePath);
    if (samePaths) {
        return samePaths;
    }

    const standardNewPath = `b/${relativePath}`;
    if (value.startsWith('a/') && value.endsWith(` ${standardNewPath}`)) {
        return [value.slice(0, -standardNewPath.length - 1), standardNewPath];
    }

    const paths = /^(\S+) (\S+)$/.exec(value);
    return paths ? [paths[1], paths[2]] : undefined;
}

/**
 * Custom prefixes are whatever precedes the trailing path segments both sides share.
 * A single shared segment (just the filename) is too weak to tell a prefix from a move.
 */
function inferGitPrefixes(paths: [string, string]): GitPrefixes | undefined {
    const [oldPath, newPath] = paths;
    const oldParts = oldPath.split('/');
    const newParts = newPath.split('/');
    let sharedParts = 0;
    while (
        sharedParts < oldParts.length
        && sharedParts < newParts.length
        && oldParts[oldParts.length - sharedParts - 1] === newParts[newParts.length - sharedParts - 1]
    ) {
        sharedParts += 1;
    }

    if (oldPath.startsWith('a/') && newPath.startsWith('b/') && (
        oldPath.slice(2) === newPath.slice(2) || sharedParts <= 1
    )) {
        return ['a/', 'b/'];
    }
    if (sharedParts <= 1) {
        return undefined;
    }

    const sharedPath = oldParts.slice(-sharedParts).join('/');
    const prefixes: GitPrefixes = [
        oldPath.slice(0, -sharedPath.length),
        newPath.slice(0, -sharedPath.length),
    ];
    return prefixes[0] !== prefixes[1] ? prefixes : undefined;
}

function parseGitPathMetadata(line: string): [0 | 1, string] | undefined {
    const metadata = /^(?:rename|copy) (from|to) (.+)$/.exec(line);
    if (!metadata) {
        return undefined;
    }
    return [metadata[1] === 'to' ? 1 : 0, decodeGitPath(metadata[2])];
}

function applyGitPathMetadata(
    gitPaths: [string, string] | undefined,
    logicalPaths: [string | undefined, string | undefined],
    gitPrefixes: GitPrefixes | undefined
): GitPrefixes | undefined {
    if (!gitPaths) {
        return gitPrefixes;
    }

    const prefixes: GitPrefixes = gitPrefixes ? [...gitPrefixes] : [undefined, undefined];
    let updated = false;
    for (let pathIndex = 0; pathIndex < gitPaths.length; pathIndex += 1) {
        const logicalPath = logicalPaths[pathIndex];
        if (logicalPath !== undefined && gitPaths[pathIndex].endsWith(logicalPath)) {
            prefixes[pathIndex] = gitPaths[pathIndex].slice(0, -logicalPath.length);
            updated = true;
        }
    }
    return updated ? prefixes : gitPrefixes;
}

function matchesDiffPath(
    diffPath: string,
    absolutePath: string,
    basePath: string,
    fallbackBasePath?: string
): boolean {
    if (path.isAbsolute(diffPath)) {
        return path.resolve(diffPath) === absolutePath;
    }
    const resolvedPath = path.resolve(basePath, diffPath);
    if (resolvedPath === absolutePath) {
        return true;
    }
    if (fallbackBasePath === undefined || path.resolve(fallbackBasePath, diffPath) !== absolutePath) {
        return false;
    }
    if (existsSync(resolvedPath)) {
        throw new Error(`Ambiguous diff path "${diffPath}"; use --diff-root to select its base directory`);
    }
    return true;
}

function parseHunkHeader(line: string): HunkCounts | undefined {
    const header = HUNK_HEADER_PATTERN.exec(line);
    return header
        ? { oldLines: Number(header[1] ?? 1), newLines: Number(header[2] ?? 1) }
        : undefined;
}

function findGitRoot(cwd: string): string {
    let currentPath = path.resolve(cwd);
    while (true) {
        if (existsSync(path.join(currentPath, '.git'))) {
            return currentPath;
        }
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            return path.resolve(cwd);
        }
        currentPath = parentPath;
    }
}

function resolveDiffRoot(cwd: string, diffRoot: string | undefined): string {
    return diffRoot ? path.resolve(cwd, diffRoot) : findGitRoot(cwd);
}

function emptyFileSection(): FileSection {
    return { logicalPaths: [undefined, undefined], isCopy: false };
}

function startGitSection(line: string, relativePath: string, rootRelativePath: string): FileSection {
    let gitPaths = parseGitDiffPaths(line, rootRelativePath);
    if (!gitPaths && rootRelativePath !== relativePath) {
        gitPaths = parseGitDiffPaths(line, relativePath);
    }
    return {
        ...emptyFileSection(),
        gitDiffLine: line,
        gitPaths,
        gitPrefixes: gitPaths ? inferGitPrefixes(gitPaths) : undefined,
    };
}

/** Rename and copy lines carry prefix-free paths, which expose the prefixes on the `diff --git` line. */
function readRenameOrCopyLine(line: string, section: FileSection): void {
    section.isCopy ||= line.startsWith('copy ');
    const metadata = parseGitPathMetadata(line);
    if (metadata) {
        section.logicalPaths[metadata[0]] = metadata[1];
    }
    const [oldLogicalPath, newLogicalPath] = section.logicalPaths;
    if (!section.gitPaths && section.gitDiffLine && oldLogicalPath !== undefined && newLogicalPath !== undefined) {
        const value = section.gitDiffLine.slice(GIT_DIFF_LINE_PREFIX.length);
        section.gitPaths = splitAfterOldPath(value, oldLogicalPath, newLogicalPath);
        section.gitPrefixes = section.gitPaths ? inferGitPrefixes(section.gitPaths) : undefined;
    }
    section.gitPrefixes = applyGitPathMetadata(section.gitPaths, section.logicalPaths, section.gitPrefixes);
}

function readFileHeaderPath(line: string): string {
    return decodeGitPath(
        line.slice(FILE_HEADER_PREFIX_LENGTH).split('\t', 1)[0]
            .replace(HEADER_TIMESTAMP_PATTERN, '')
            .trim()
    );
}

/** Drops the section's Git prefix from a header path unless the prefixed path is itself real. */
function stripGitPrefix(
    diffPath: string,
    prefix: string | undefined,
    section: FileSection,
    diffBase: string,
    isTargetPath: (diffPath: string) => boolean
): string {
    if (!prefix || !diffPath.startsWith(prefix)) {
        return diffPath;
    }
    const prefixIsSynthetic = section.logicalPaths[0] !== undefined && section.logicalPaths[1] !== undefined
        || section.gitPaths !== undefined && isStandardPrefixPair(section.gitPaths[0], section.gitPaths[1]);
    if (prefixIsSynthetic) {
        return diffPath.slice(prefix.length);
    }
    const prefixedPathExists = section.gitPaths?.some((gitPath) => existsSync(path.resolve(diffBase, gitPath))) ?? false;
    return prefixedPathExists || isTargetPath(diffPath) ? diffPath : diffPath.slice(prefix.length);
}

/** Reads a `---` or `+++` line and returns whether the current section is the target file. */
function readFileHeader(
    line: string,
    section: FileSection,
    target: DiffTarget,
    currentFileMatches: boolean
): boolean {
    const isNewFileHeader = line.startsWith('+++ ');
    const isGitDiff = section.gitDiffLine !== undefined;
    const diffBase = isGitDiff || !target.allowCwdRelativeGitPaths ? target.rootPath : target.cwd;
    const isTargetPath = (diffPath: string) => matchesDiffPath(diffPath, target.absolutePath, diffBase);
    const prefix = section.gitPrefixes?.[isNewFileHeader ? 1 : 0];
    let diffPath = stripGitPrefix(readFileHeaderPath(line), prefix, section, diffBase, isTargetPath);
    let fileMatches = currentFileMatches;
    if (!isGitDiff) {
        if (!isNewFileHeader) {
            section.plainOldPath = diffPath;
        } else if (
            section.plainOldPath !== undefined
            && isStandardPrefixPair(section.plainOldPath, diffPath)
            && !isTargetPath(section.plainOldPath)
            && !isTargetPath(diffPath)
        ) {
            fileMatches = isTargetPath(section.plainOldPath.slice(2));
            diffPath = diffPath.slice(2);
        }
    }

    const diffPathMatches = matchesDiffPath(
        diffPath,
        target.absolutePath,
        diffBase,
        isGitDiff && target.allowCwdRelativeGitPaths ? target.cwd : undefined
    );
    // A copy leaves its source untouched, so only the copy's own `+++` path can match.
    if (section.isCopy) {
        return isNewFileHeader && diffPathMatches;
    }
    return isNewFileHeader ? fileMatches || diffPathMatches : diffPathMatches;
}

/** The profiled file's changed lines and hunks, from a diff that may cover many files. */
export function collectChangedLines(
    diffText: string | undefined,
    relativePath: string,
    cwd: string,
    diffRoot: string | undefined
): ChangedLines {
    const changedLines: ChangedLines = { added: [], removed: [], hunks: [] };
    if (!diffText) {
        return changedLines;
    }

    const target: DiffTarget = {
        absolutePath: path.resolve(cwd, relativePath),
        cwd,
        rootPath: resolveDiffRoot(cwd, diffRoot),
        allowCwdRelativeGitPaths: diffRoot === undefined,
    };
    const rootRelativePath = path.relative(target.rootPath, target.absolutePath).replace(/\\/g, '/');
    let section = emptyFileSection();
    let fileMatches = true;
    let hunk: HunkCounts | undefined;
    // Text with no diff headers at all is read as bare `+`/`-` lines.
    let hasDiffHeaders = false;
    for (const line of diffText.split(/\r?\n/)) {
        if (line.startsWith(GIT_DIFF_LINE_PREFIX)) {
            section = startGitSection(line, relativePath, rootRelativePath);
            fileMatches = false;
            hunk = undefined;
            hasDiffHeaders = true;
            continue;
        }
        if (!hunk && RENAME_OR_COPY_PATTERN.test(line)) {
            readRenameOrCopyLine(line, section);
            continue;
        }
        if (!hunk && (line.startsWith('--- ') || line.startsWith('+++ '))) {
            fileMatches = readFileHeader(line, section, target, fileMatches);
            if (line.startsWith('+++ ')) {
                section = emptyFileSection();
            }
            hasDiffHeaders = true;
            continue;
        }
        if (line.startsWith('@@')) {
            const hunkHeader = parseHunkHeader(line);
            if (hunkHeader) {
                hunk = hunkHeader;
                hasDiffHeaders = true;
                if (fileMatches) {
                    changedLines.hunks.push(line);
                }
            }
            continue;
        }
        if (!line || (!hunk && hasDiffHeaders)) {
            continue;
        }
        if (fileMatches) {
            changedLines.hunks.push(line);
            if (line.startsWith('+')) {
                changedLines.added.push(line.slice(1));
            } else if (line.startsWith('-')) {
                changedLines.removed.push(line.slice(1));
            }
        }
        if (hunk) {
            if (line.startsWith('+')) {
                hunk.newLines -= 1;
            } else if (line.startsWith('-')) {
                hunk.oldLines -= 1;
            } else if (line.startsWith(' ')) {
                hunk.oldLines -= 1;
                hunk.newLines -= 1;
            }
            if (hunk.oldLines <= 0 && hunk.newLines <= 0) {
                hunk = undefined;
            }
        }
    }

    return changedLines;
}

/** Absolute paths of the files a unified diff changes; a deleted file keeps its old path. */
export function listDiffFiles(diffText: string, cwd: string, diffRoot?: string): string[] {
    const basePath = resolveDiffRoot(cwd, diffRoot);
    const files = new Set<string>();
    let isGitDiff = false;
    let oldPath = '';
    let hunk: HunkCounts = { oldLines: 0, newLines: 0 };
    for (const line of diffText.split(/\r?\n/)) {
        // Hunk bodies can hold lines like "--- x" that are content, not headers.
        if (hunk.oldLines > 0 || hunk.newLines > 0) {
            if (line.startsWith('-')) {
                hunk.oldLines -= 1;
            } else if (line.startsWith('+')) {
                hunk.newLines -= 1;
            } else if (!line.startsWith('\\')) {
                hunk.oldLines -= 1;
                hunk.newLines -= 1;
            }
            continue;
        }
        const hunkHeader = parseHunkHeader(line);
        if (hunkHeader) {
            hunk = hunkHeader;
            continue;
        }
        isGitDiff ||= line.startsWith(GIT_DIFF_LINE_PREFIX);
        if (!line.startsWith('--- ') && !line.startsWith('+++ ')) {
            continue;
        }
        let diffPath = decodeGitPath(line.slice(FILE_HEADER_PREFIX_LENGTH).split('\t', 1)[0].trim());
        if (isGitDiff && /^[ab]\//.test(diffPath)) {
            diffPath = diffPath.slice(2);
        }
        if (line.startsWith('--- ')) {
            oldPath = diffPath;
        } else {
            files.add(path.resolve(basePath, diffPath === '/dev/null' ? oldPath : diffPath));
        }
    }
    return [...files];
}
