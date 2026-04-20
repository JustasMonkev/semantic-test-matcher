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

export function isDebug(): boolean {
    return process.env.RBT_DEBUG === '1';
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

