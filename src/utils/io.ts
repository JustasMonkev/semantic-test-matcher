import fs from 'node:fs/promises';
import { hasErrorCode } from './errors.ts';

export async function readStdinText(): Promise<string> {
    if (process.stdin.isTTY) {
        return '';
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8').trim();
}

let debugLogLevel = false;

export function setDebugLogLevel(enabled: boolean): void {
    debugLogLevel = enabled;
}

export function isDebug(): boolean {
    return debugLogLevel || process.env.RBT_DEBUG === '1';
}

export function debugWarn(message: string): void {
    if (isDebug()) {
        console.warn(message);
    }
}

function parseJsonArray(text: string): unknown[] | undefined {
    try {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

export function parseStdinList(raw: string): string[] {
    const trimmed = raw.trim();
    const values = parseJsonArray(trimmed) ?? trimmed.split('\n');
    return values.map((value) => String(value).trim()).filter(Boolean);
}

export async function readFileIfExists(filePath: string): Promise<string | undefined> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return undefined;
        }
        throw error;
    }
}
