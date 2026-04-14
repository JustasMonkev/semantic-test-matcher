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

