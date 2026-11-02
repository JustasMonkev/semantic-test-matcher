import fs from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from './errors.ts';

export function normalizePathSeparators(value: string): string {
    return value.replace(/\\/g, '/');
}

export function isPathInside(base: string, target: string): boolean {
    const relative = path.relative(base, target);
    const climbsOutOfBase = relative === '..' || relative.startsWith(`..${path.sep}`);
    return !climbsOutOfBase && !path.isAbsolute(relative);
}

export async function resolveRealPath(targetPath: string): Promise<string> {
    const absolute = path.resolve(targetPath);
    try {
        return await fs.realpath(absolute);
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
            throw error;
        }
        const parent = path.dirname(absolute);
        if (parent === absolute) {
            return absolute;
        }
        return path.join(await resolveRealPath(parent), path.basename(absolute));
    }
}

export async function isWorkspaceContainedPath(targetPath: string, workspace: string): Promise<boolean> {
    return isPathInside(workspace, targetPath) && isPathInside(workspace, await resolveRealPath(targetPath));
}

export async function findPathsOutside(files: string[], root: string): Promise<string[]> {
    const realRoot = await resolveRealPath(root);
    const outside: string[] = [];
    for (const file of files) {
        if (!isPathInside(root, file) || !isPathInside(realRoot, await resolveRealPath(file))) {
            outside.push(file);
        }
    }
    return outside;
}
