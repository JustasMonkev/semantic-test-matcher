import { existsSync } from 'node:fs';
import path from 'node:path';
import { normalizePathSeparators } from '../utils/paths.ts';

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

interface FileSection {
    gitDiffLine?: string;
    prefixedGitPaths?: [string, string];
    unprefixedPaths: [string | undefined, string | undefined];
    gitPrefixes?: GitPrefixes;
    isCopy: boolean;
    plainOldPath?: string;
}

interface DiffTarget {
    absolutePath: string;
    cwd: string;
    rootPath: string;
    allowCwdRelativeGitPaths: boolean;
}

const GIT_DIFF_LINE_PREFIX = 'diff --git ';
const DEV_NULL = '/dev/null';
const DELETED_FILE_PREFIX = 'deleted file mode ';
const CONTENT_CHANGE_WITHOUT_HUNKS = /^(?:Binary files |GIT binary patch|new file mode )/;
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

function isPlainPrefixPair(oldPath: string, newPath: string): boolean {
    return isStandardPrefixPair(oldPath, newPath)
        || oldPath === DEV_NULL && newPath.startsWith('b/')
        || newPath === DEV_NULL && oldPath.startsWith('a/');
}

function stripPlainLabel(diffPath: string): string {
    return diffPath === DEV_NULL ? diffPath : diffPath.slice(2);
}

function plainChangedPath(oldPath: string, newPath: string, basePath: string): string {
    const isDeletion = newPath === DEV_NULL;
    const changedPath = isDeletion ? oldPath : newPath;
    if (!isPlainPrefixPair(oldPath, newPath)) {
        return changedPath;
    }
    const labeledPath = path.resolve(basePath, changedPath);
    const pathThatStillExists = isDeletion ? path.dirname(labeledPath) : labeledPath;
    const labelIsPartOfRealPath = existsSync(pathThatStillExists);
    return labelIsPartOfRealPath ? changedPath : changedPath.slice(2);
}

function splitAfterOldPath(value: string, oldPath: string, newPath: string): [string, string] | undefined {
    const oldPathStart = value.lastIndexOf(`${oldPath} `);
    if (oldPathStart === -1) {
        return undefined;
    }

    const oldPathEnd = oldPathStart + oldPath.length;
    const paths: [string, string] = [value.slice(0, oldPathEnd), value.slice(oldPathEnd + 1)];
    return paths[1].endsWith(newPath) ? paths : undefined;
}

function splitSameFilePaths(value: string): [string, string] | undefined {
    const dropPrefix = (diffPath: string) => diffPath.slice(diffPath.indexOf('/') + 1);
    for (let index = value.indexOf(' '); index !== -1; index = value.indexOf(' ', index + 1)) {
        const paths: [string, string] = [value.slice(0, index), value.slice(index + 1)];
        if (dropPrefix(paths[0]) === dropPrefix(paths[1])) {
            return paths;
        }
    }
    return undefined;
}

function parseGitDiffPaths(line: string, relativePath: string | undefined): [string, string] | undefined {
    const value = line.slice(GIT_DIFF_LINE_PREFIX.length);
    const tokenizedPaths = /^("(?:\\.|[^"\\])*"|\S+) ("(?:\\.|[^"\\])*"|\S+)$/.exec(value);
    if (tokenizedPaths) {
        return [decodeGitPath(tokenizedPaths[1]), decodeGitPath(tokenizedPaths[2])];
    }
    if (relativePath === undefined) {
        return splitSameFilePaths(value);
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

function inferGitPrefixes(paths: [string, string]): GitPrefixes | undefined {
    const [oldPath, newPath] = paths;
    const oldParts = oldPath.split('/');
    const newParts = newPath.split('/');
    let sharedTrailingSegments = 0;
    while (
        sharedTrailingSegments < oldParts.length
        && sharedTrailingSegments < newParts.length
        && oldParts[oldParts.length - sharedTrailingSegments - 1] === newParts[newParts.length - sharedTrailingSegments - 1]
    ) {
        sharedTrailingSegments += 1;
    }

    const onlyFilenameShared = sharedTrailingSegments <= 1;
    if (oldPath.startsWith('a/') && newPath.startsWith('b/') && (oldPath.slice(2) === newPath.slice(2) || onlyFilenameShared)) {
        return ['a/', 'b/'];
    }
    const isPrefixedRootFile = sharedTrailingSegments === 1 && oldParts.length === 2 && newParts.length === 2;
    const tooWeakToTellPrefixFromMove = onlyFilenameShared && !isPrefixedRootFile;
    if (tooWeakToTellPrefixFromMove) {
        return undefined;
    }

    const sharedPath = oldParts.slice(-sharedTrailingSegments).join('/');
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
    prefixedGitPaths: [string, string] | undefined,
    unprefixedPaths: [string | undefined, string | undefined],
    gitPrefixes: GitPrefixes | undefined
): GitPrefixes | undefined {
    if (!prefixedGitPaths) {
        return gitPrefixes;
    }

    const prefixes: GitPrefixes = gitPrefixes ? [...gitPrefixes] : [undefined, undefined];
    let updated = false;
    for (let pathIndex = 0; pathIndex < prefixedGitPaths.length; pathIndex += 1) {
        const unprefixedPath = unprefixedPaths[pathIndex];
        if (unprefixedPath !== undefined && prefixedGitPaths[pathIndex].endsWith(unprefixedPath)) {
            prefixes[pathIndex] = prefixedGitPaths[pathIndex].slice(0, -unprefixedPath.length);
            updated = true;
        }
    }
    return updated ? prefixes : gitPrefixes;
}

function cwdFallbackBase(target: DiffTarget): string | undefined {
    return target.allowCwdRelativeGitPaths ? target.cwd : undefined;
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

export function resolveDiffRoot(cwd: string, diffRoot: string | undefined): string {
    return diffRoot ? path.resolve(cwd, diffRoot) : findGitRoot(cwd);
}

function emptyFileSection(): FileSection {
    return { unprefixedPaths: [undefined, undefined], isCopy: false };
}

function startGitSection(line: string, relativePath?: string, rootRelativePath = relativePath): FileSection {
    let prefixedGitPaths = parseGitDiffPaths(line, rootRelativePath);
    if (!prefixedGitPaths && rootRelativePath !== relativePath) {
        prefixedGitPaths = parseGitDiffPaths(line, relativePath);
    }
    return {
        ...emptyFileSection(),
        gitDiffLine: line,
        prefixedGitPaths,
        gitPrefixes: prefixedGitPaths ? inferGitPrefixes(prefixedGitPaths) : undefined,
    };
}

function readRenameOrCopyLine(line: string, section: FileSection): void {
    section.isCopy ||= line.startsWith('copy ');
    const metadata = parseGitPathMetadata(line);
    if (metadata) {
        section.unprefixedPaths[metadata[0]] = metadata[1];
    }
    const [oldUnprefixedPath, newUnprefixedPath] = section.unprefixedPaths;
    if (!section.prefixedGitPaths && section.gitDiffLine && oldUnprefixedPath !== undefined && newUnprefixedPath !== undefined) {
        const value = section.gitDiffLine.slice(GIT_DIFF_LINE_PREFIX.length);
        section.prefixedGitPaths = splitAfterOldPath(value, oldUnprefixedPath, newUnprefixedPath);
        section.gitPrefixes = section.prefixedGitPaths ? inferGitPrefixes(section.prefixedGitPaths) : undefined;
    }
    section.gitPrefixes = applyGitPathMetadata(section.prefixedGitPaths, section.unprefixedPaths, section.gitPrefixes);
}

function readFileHeaderPath(line: string): string {
    return decodeGitPath(
        line.slice(FILE_HEADER_PREFIX_LENGTH).split('\t', 1)[0]
            .replace(HEADER_TIMESTAMP_PATTERN, '')
            .trim()
    );
}

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
    const prefixIsSynthetic = section.unprefixedPaths[0] !== undefined && section.unprefixedPaths[1] !== undefined
        || section.prefixedGitPaths !== undefined && isStandardPrefixPair(section.prefixedGitPaths[0], section.prefixedGitPaths[1]);
    if (prefixIsSynthetic) {
        return diffPath.slice(prefix.length);
    }
    const prefixedPathExists = section.prefixedGitPaths?.some((gitPath) => existsSync(path.resolve(diffBase, gitPath))) ?? false;
    return prefixedPathExists || isTargetPath(diffPath) ? diffPath : diffPath.slice(prefix.length);
}

function readFileHeaderAndMatchTarget(
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
            && isPlainPrefixPair(section.plainOldPath, diffPath)
            && !isTargetPath(section.plainOldPath)
            && !isTargetPath(diffPath)
        ) {
            fileMatches = isTargetPath(stripPlainLabel(section.plainOldPath));
            diffPath = stripPlainLabel(diffPath);
        }
    }

    const diffPathMatches = matchesDiffPath(
        diffPath,
        target.absolutePath,
        diffBase,
        isGitDiff ? cwdFallbackBase(target) : undefined
    );
    const copySourceIsUntouched = section.isCopy;
    if (copySourceIsUntouched) {
        return isNewFileHeader && diffPathMatches;
    }
    return isNewFileHeader ? fileMatches || diffPathMatches : diffPathMatches;
}

function isRenameOrCopyTarget(newPath: string, target: DiffTarget): boolean {
    return matchesDiffPath(
        newPath,
        target.absolutePath,
        target.rootPath,
        cwdFallbackBase(target)
    );
}

function isDeletedTarget(section: FileSection, target: DiffTarget): boolean {
    const oldGitPath = section.prefixedGitPaths?.[0];
    if (oldGitPath === undefined) {
        return false;
    }
    const isTargetPath = (diffPath: string) => matchesDiffPath(diffPath, target.absolutePath, target.rootPath);
    const diffPath = stripGitPrefix(oldGitPath, section.gitPrefixes?.[0], section, target.rootPath, isTargetPath);
    return matchesDiffPath(
        diffPath,
        target.absolutePath,
        target.rootPath,
        cwdFallbackBase(target)
    );
}

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
    const rootRelativePath = normalizePathSeparators(path.relative(target.rootPath, target.absolutePath));
    let section = emptyFileSection();
    let fileMatches = true;
    let hunk: HunkCounts | undefined;
    let hasDiffHeaders = false;
    let hunklessChange: { metadataLines: string[]; pathWhoseImportsBreak?: string } | undefined;
    const recordHunklessChange = () => {
        if (hunklessChange) {
            changedLines.hunks.push(...hunklessChange.metadataLines);
            if (hunklessChange.pathWhoseImportsBreak !== undefined) {
                changedLines.removed.push(hunklessChange.pathWhoseImportsBreak);
            }
            hunklessChange = undefined;
        }
    };
    for (const line of diffText.split(/\r?\n/)) {
        if (line.startsWith(GIT_DIFF_LINE_PREFIX)) {
            recordHunklessChange();
            section = startGitSection(line, relativePath, rootRelativePath);
            fileMatches = false;
            hunk = undefined;
            hasDiffHeaders = true;
            continue;
        }
        if (!hunk && RENAME_OR_COPY_PATTERN.test(line)) {
            readRenameOrCopyLine(line, section);
            const [oldPath, newPath] = section.unprefixedPaths;
            if (oldPath !== undefined && newPath !== undefined && isRenameOrCopyTarget(newPath, target)) {
                const verb = section.isCopy ? 'copy' : 'rename';
                hunklessChange = {
                    metadataLines: [`${verb} from ${oldPath}`, `${verb} to ${newPath}`],
                    pathWhoseImportsBreak: section.isCopy ? undefined : oldPath,
                };
            }
            continue;
        }
        if (!hunk && line.startsWith(DELETED_FILE_PREFIX) && isDeletedTarget(section, target)) {
            hunklessChange = { metadataLines: [line] };
            continue;
        }
        if (!hunk && (line.startsWith('--- ') || line.startsWith('+++ '))) {
            hunklessChange = undefined;
            fileMatches = readFileHeaderAndMatchTarget(line, section, target, fileMatches);
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
    recordHunklessChange();

    return changedLines;
}

interface DiffFileScan {
    changed: Set<string>;
    modeOnly: Set<string>;
}

function scanDiffFiles(diffText: string, basePath: string): DiffFileScan {
    const scan: DiffFileScan = { changed: new Set(), modeOnly: new Set() };
    let section = emptyFileSection();
    let headerlessContentChanged = false;
    let deleted = false;
    let modeChanged = false;
    const headerlessPath = (side: 0 | 1) => section.prefixedGitPaths
        && stripGitPrefix(section.prefixedGitPaths[side], section.gitPrefixes?.[side], section, basePath, () => false);
    const addHeaderlessTarget = () => {
        if (section.gitDiffLine === undefined) {
            return;
        }
        const targetPath = deleted ? headerlessPath(0)
            : section.unprefixedPaths[1] ?? (headerlessContentChanged ? headerlessPath(1) : undefined);
        if (targetPath) {
            scan.changed.add(path.resolve(basePath, targetPath));
        } else if (modeChanged) {
            const modePath = headerlessPath(1);
            if (modePath) {
                scan.modeOnly.add(path.resolve(basePath, modePath));
            }
        }
    };
    let oldPath = '';
    let hunk: HunkCounts = { oldLines: 0, newLines: 0 };
    for (const line of diffText.split(/\r?\n/)) {
        const insideHunkBody = hunk.oldLines > 0 || hunk.newLines > 0;
        if (insideHunkBody) {
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
        if (line.startsWith(GIT_DIFF_LINE_PREFIX)) {
            addHeaderlessTarget();
            section = startGitSection(line);
            headerlessContentChanged = false;
            deleted = false;
            modeChanged = false;
            continue;
        }
        if (RENAME_OR_COPY_PATTERN.test(line)) {
            readRenameOrCopyLine(line, section);
            continue;
        }
        headerlessContentChanged ||= CONTENT_CHANGE_WITHOUT_HUNKS.test(line);
        deleted ||= line.startsWith(DELETED_FILE_PREFIX);
        modeChanged ||= line.startsWith('old mode ');
        if (!line.startsWith('--- ') && !line.startsWith('+++ ')) {
            continue;
        }
        const isNewFileHeader = line.startsWith('+++ ');
        const prefix = section.gitPrefixes?.[isNewFileHeader ? 1 : 0];
        const diffPath = stripGitPrefix(readFileHeaderPath(line), prefix, section, basePath, () => false);
        if (!isNewFileHeader) {
            oldPath = diffPath;
            continue;
        }
        const changedPath = section.gitDiffLine === undefined
            ? plainChangedPath(oldPath, diffPath, basePath)
            : diffPath === DEV_NULL ? oldPath : diffPath;
        scan.changed.add(path.resolve(basePath, changedPath));
        section = emptyFileSection();
    }
    addHeaderlessTarget();
    return scan;
}

export function listDiffFiles(diffText: string, cwd: string, diffRoot?: string): string[] {
    return [...scanDiffFiles(diffText, resolveDiffRoot(cwd, diffRoot)).changed];
}

export function listModeOnlyDiffFiles(diffText: string, cwd: string, diffRoot?: string): string[] {
    const { changed, modeOnly } = scanDiffFiles(diffText, resolveDiffRoot(cwd, diffRoot));
    return [...modeOnly].filter((file) => !changed.has(file));
}
