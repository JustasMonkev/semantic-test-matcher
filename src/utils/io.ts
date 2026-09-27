import fs from 'node:fs/promises';

export async function readStdinText(): Promise<string> {
    return new Promise((resolve, reject) => {
        if (process.stdin.isTTY) {
            resolve('');
            return;
        }

        const chunks: Buffer[] = [];
        process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        process.stdin.on('error', reject);
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
    });
}

let debugLogLevel = false;

/** Set once the log level resolves, so `--log-level debug` and its equivalents enable diagnostics. */
export function setDebugLogLevel(enabled: boolean): void {
    debugLogLevel = enabled;
}

// RBT_DEBUG=1 also covers errors raised before any config resolves.
export function isDebug(): boolean {
    return debugLogLevel || process.env.RBT_DEBUG === '1';
}

export function parseStdinList(raw: string): string[] {
    const trimmed = raw.trim();
    if (!trimmed) {
        return [];
    }

    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return parsed.map((value) => String(value).trim()).filter(Boolean);
        }
    } catch {
        // Fall through: stdin isn't JSON, parse as newline-separated list.
    }

    return trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
}

export async function readFileIfExists(filePath: string): Promise<string | undefined> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}
