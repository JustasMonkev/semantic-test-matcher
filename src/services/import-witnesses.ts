import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';
import { isPathInside, normalizePathSeparators } from '../utils/paths.ts';

const maxFiles = 1_000;
const maxFileBytes = 128 * 1024;
const maxTotalBytes = 8 * 1024 * 1024;
const maxEdgesPerFile = 64;
const maxEdgesVisited = 64_000;

export function isNativeModule(file: string): boolean {
    return /\.m?js$/.test(file);
}

// Reuse candidate contents already read for ranking. Cache admission affects only I/O:
// uncached modules go through the same bounded search, in candidate order.
export function candidateModuleCache() {
    const texts = new Map<string, string>();
    let bytesLeft = maxTotalBytes;
    function remember(file: string, text: string) {
        if (!isNativeModule(file)) return;
        const bytes = Buffer.byteLength(text);
        if (bytes <= Math.min(bytesLeft, maxFileBytes)) {
            texts.set(file, text);
            bytesLeft -= bytes;
        }
    }
    return { texts, remember };
}

function relativeImports(file: string, text: string): string[] {
    if (!text.includes('import') && !text.includes('export')) return [];
    const tree = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
    const edges = new Set<string>();
    for (const node of tree.body) {
        if (node.type !== 'ImportDeclaration' && node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportAllDeclaration') continue;
        const specifier = node.source?.value;
        if (typeof specifier !== 'string' || !/^\.\.?\//.test(specifier) || !isNativeModule(specifier)) continue;
        // Do not guess URL escapes, query/fragment module identities or platform-specific paths.
        if (/[?#%\\\x00-\x1f]/.test(specifier)) continue;
        edges.add(path.resolve(path.dirname(file), specifier));
        if (edges.size >= maxEdgesPerFile) break;
    }
    return [...edges];
}

// Index only positive one- and two-edge witnesses. A missing path (including a budget miss)
// is not evidence of independence; existing lexical/model eligibility stays intact.
export async function findImportWitnesses(
    cwd: string, candidates: readonly string[], changes: readonly string[], candidateTexts?: ReadonlyMap<string, string>
) {
    const witnesses = new Map<string, Map<string, string[]>>();
    const targets = new Set(changes.filter(file => isNativeModule(file) && isPathInside(cwd, file)));
    if (!targets.size || !candidates.some(isNativeModule)) return witnesses;

    const realRoot = await fs.realpath(cwd);
    const imports = new Map<string, string[]>();
    const verified = new Map<string, boolean>();
    let bytesLeft = maxTotalBytes;
    let edgesLeft = maxEdgesVisited;
    function inWorkspace(file: string) {
        return isPathInside(cwd, file) && !path.relative(cwd, file).split(path.sep).includes('node_modules');
    }
    async function regularPath(file: string) {
        if (!inWorkspace(file)) return;
        const real = await fs.realpath(file);
        if (real !== path.join(realRoot, path.relative(cwd, file))) return;
        const stat = await fs.stat(real);
        if (stat.isFile()) return real;
    }
    async function moduleText(file: string) {
        const limit = Math.min(bytesLeft, maxFileBytes);
        const known = candidateTexts?.get(file);
        if (known !== undefined) {
            const bytes = Buffer.byteLength(known);
            if (bytes > limit) return;
            bytesLeft -= bytes;
            return known;
        }
        const real = await regularPath(file);
        if (!real) return;
        const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > limit) return;
            bytesLeft -= stat.size;
            const buffer = Buffer.alloc(stat.size);
            const { bytesRead } = await handle.read(buffer);
            if (bytesRead !== stat.size || (await handle.stat()).size !== stat.size) return;
            verified.set(file, true);
            return buffer.toString('utf8', 0, bytesRead);
        } finally {
            await handle.close();
        }
    }
    async function edges(file: string): Promise<string[]> {
        const cached = imports.get(file);
        if (cached) return cached;
        if (imports.size >= maxFiles || bytesLeft <= 0 || !inWorkspace(file)) return [];
        let links: string[] = [];
        try {
            const text = await moduleText(file);
            if (text !== undefined) links = relativeImports(file, text);
        } catch {
            // Missing, unreadable or unsupported syntax: no static witness.
        }
        imports.set(file, links);
        return links;
    }
    async function record(candidate: string, target: string, via?: string) {
        const files = via ? [path.resolve(cwd, candidate), via, target] : [path.resolve(cwd, candidate), target];
        for (const file of files) {
            if (!verified.has(file)) verified.set(file, Boolean(await regularPath(file).catch(() => undefined)));
            if (!verified.get(file)) return;
        }
        let matches = witnesses.get(target);
        if (!matches) {
            matches = new Map();
            witnesses.set(target, matches);
        }
        if (matches.has(candidate) && via) return;
        matches.set(candidate, files.map(file => normalizePathSeparators(path.relative(cwd, file))));
    }

    for (const candidate of candidates) {
        if (!isNativeModule(candidate)) continue;
        const file = path.resolve(cwd, candidate);
        const direct = await edges(file);
        for (const imported of direct) {
            if (--edgesLeft < 0) return witnesses;
            if (imported === file) continue;
            if (targets.has(imported)) await record(candidate, imported);
            for (const target of await edges(imported)) {
                if (--edgesLeft < 0) return witnesses;
                if (target !== file && target !== imported && targets.has(target)) await record(candidate, target, imported);
            }
        }
    }
    return witnesses;
}
