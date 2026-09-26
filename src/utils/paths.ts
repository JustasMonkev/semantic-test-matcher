import fs from 'node:fs/promises';
import path from 'node:path';

export function normalizePathSeparators(value: string): string {
    return value.replace(/\\/g, '/');
}

export function isParentPath(base: string, target: string): boolean {
    const relative = path.relative(base, target);
    // Only a `..` segment leaves base; a name such as `..foo.ts` stays inside it.
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function resolveRealPath(targetPath: string): Promise<string> {
    let current = path.resolve(targetPath);
    const suffix: string[] = [];

    while (true) {
        try {
            const realPath = await fs.realpath(current);
            return suffix.length ? path.resolve(realPath, ...suffix.reverse()) : realPath;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }

            const parent = path.dirname(current);
            if (parent === current) {
                return current;
            }

            suffix.push(path.basename(current));
            current = parent;
        }
    }
}

export async function isWorkspaceContainedPath(targetPath: string, workspace: string): Promise<boolean> {
    return isParentPath(workspace, targetPath) &&
        isParentPath(workspace, await resolveRealPath(targetPath));
}
