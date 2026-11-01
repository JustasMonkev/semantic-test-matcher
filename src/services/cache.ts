import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sleep } from '../utils/async.ts';
import { errorMessage, hasErrorCode } from '../utils/errors.ts';
import { debugWarn } from '../utils/io.ts';

const LOCK_POLL_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_AFTER_OWNER_EXIT_MS = 30_000;
const LOCK_ABANDONED_EVEN_IF_PID_ALIVE_MS = 10 * 60_000;
const TAKEOVER_LOCK_STALE_MS = 5_000;

interface CacheLock {
    handle: FileHandle;
    lockPath: string;
    ownerToken: string;
}

interface LockSnapshot {
    contents: string;
    mtimeMs: number;
}

function debugCache(message: string): void {
    debugWarn(`Cache: ${message}`);
}

function lockPathFor(filePath: string): string {
    const parsed = path.parse(filePath);
    return path.join(parsed.dir, `${parsed.name}.lock`);
}

function testWriteDelayMs(): number {
    const parsed = Number(process.env.RBT_CACHE_WRITE_DELAY_MS || 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function tryCreateLock(lockPath: string): Promise<CacheLock | undefined> {
    const ownerToken = crypto.randomUUID();
    try {
        const handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(`${process.pid}\n${os.hostname()}\n${ownerToken}\n`, 'utf8');
        return { handle, lockPath, ownerToken };
    } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) {
            return undefined;
        }
        throw error;
    }
}

function isLockOwnerKnownToHaveExited(lockContents: string): boolean {
    const [pidLine, host] = lockContents.split('\n');
    const pid = Number(pidLine);
    if (!Number.isInteger(pid) || pid <= 0 || host !== os.hostname()) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return hasErrorCode(error, 'ESRCH');
    }
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot> {
    const { mtimeMs } = await fs.stat(lockPath);
    return { contents: await fs.readFile(lockPath, 'utf8'), mtimeMs };
}

function isStale(lock: LockSnapshot): boolean {
    const ageMs = Date.now() - lock.mtimeMs;
    if (ageMs > LOCK_ABANDONED_EVEN_IF_PID_ALIVE_MS) {
        return true;
    }
    return ageMs > LOCK_STALE_AFTER_OWNER_EXIT_MS && isLockOwnerKnownToHaveExited(lock.contents);
}

async function isLockGoneOrCleared(lockPath: string): Promise<boolean> {
    let lock: LockSnapshot;
    try {
        lock = await readLockSnapshot(lockPath);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return true;
        }
        throw error;
    }
    if (!isStale(lock)) {
        return false;
    }
    return removeStaleLockExclusively(lockPath, lock);
}

async function removeAbandonedTakeoverLock(takeoverPath: string): Promise<void> {
    const takeoverMtimeMs = (await fs.stat(takeoverPath).catch(() => undefined))?.mtimeMs ?? Date.now();
    if (Date.now() - takeoverMtimeMs > TAKEOVER_LOCK_STALE_MS) {
        await fs.unlink(takeoverPath).catch(() => {});
    }
}

async function removeStaleLockExclusively(lockPath: string, stale: LockSnapshot): Promise<boolean> {
    const takeoverPath = `${lockPath}.takeover`;
    let takeover: FileHandle;
    try {
        takeover = await fs.open(takeoverPath, 'wx');
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
            throw error;
        }
        await removeAbandonedTakeoverLock(takeoverPath);
        return false;
    }
    try {
        const current = await readLockSnapshot(lockPath);
        const unchangedSinceJudgedStale = current.contents === stale.contents && current.mtimeMs === stale.mtimeMs;
        if (!unchangedSinceJudgedStale) {
            return false;
        }
        await fs.unlink(lockPath);
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return true;
        }
        throw error;
    } finally {
        await takeover.close();
        await fs.unlink(takeoverPath).catch(() => {});
    }
}

async function acquireCacheLock(filePath: string): Promise<CacheLock> {
    const lockPath = lockPathFor(filePath);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    while (true) {
        const lock = await tryCreateLock(lockPath);
        if (lock) {
            return lock;
        }
        if (await isLockGoneOrCleared(lockPath)) {
            continue;
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out acquiring cache lock for ${lockPath}`);
        }
        await sleep(LOCK_POLL_MS);
    }
}

async function releaseCacheLock({ handle, lockPath, ownerToken }: CacheLock): Promise<void> {
    try {
        await handle.close();
    } finally {
        try {
            const stillOwned = (await fs.readFile(lockPath, 'utf8')).includes(ownerToken);
            if (stillOwned) {
                await fs.unlink(lockPath);
            } else {
                debugCache(`Cache lock ${lockPath} was taken over; leaving it to its new owner`);
            }
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
                debugCache(`Unable to remove cache lock ${lockPath}: ${errorMessage(error)}`);
            }
        }
    }
}

export async function loadCache<T>(filePath: string): Promise<Record<string, T>> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return {};
        }
        if (error instanceof SyntaxError) {
            debugCache(`Ignoring malformed cache file at ${filePath}: ${error.message}`);
            return {};
        }
        throw error;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        debugCache(`Ignoring cache file at ${filePath} that is not a JSON object`);
        return {};
    }
    return parsed as Record<string, T>;
}

export async function countCacheEntries(filePath: string): Promise<number> {
    try {
        return Object.keys(await loadCache(filePath)).length;
    } catch {
        return 0;
    }
}

export async function persistCache<T>(filePath: string, cache: Record<string, T>): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const uniqueSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const tempFile = path.join(path.dirname(filePath), `${path.basename(filePath)}.${uniqueSuffix}.tmp`);

    await fs.writeFile(tempFile, JSON.stringify(cache, null, 2), 'utf8');
    const delayMs = testWriteDelayMs();
    if (delayMs > 0) {
        await sleep(delayMs);
    }
    await fs.rename(tempFile, filePath);
}

export function buildCacheKey(provider: string, model: string, text: string): string {
    const normalizedText = text.replace(/\r\n/g, '\n');
    return crypto.createHash('sha256').update(`${provider}|${model}|${normalizedText}`).digest('hex');
}

export async function writeCacheEntries<T>(filePath: string, entries: Record<string, T>): Promise<void> {
    if (!Object.keys(entries).length) {
        return;
    }

    const lock = await acquireCacheLock(filePath);
    try {
        const cache = await loadCache<T>(filePath);
        Object.assign(cache, entries);
        await persistCache(filePath, cache);
    } finally {
        await releaseCacheLock(lock);
    }
}

export class BufferedCache<T> {
    private readonly filePath: string;
    private readonly label: string;
    private readonly enabled: boolean;
    private stored?: Promise<Record<string, T>>;
    private pending: Record<string, T> = {};

    constructor(filePath: string, label: string, enabled: boolean) {
        this.filePath = filePath;
        this.label = label;
        this.enabled = enabled;
    }

    async get(key: string): Promise<T | undefined> {
        if (!this.enabled) {
            return undefined;
        }
        this.stored ??= loadCache<T>(this.filePath).catch((error) => {
            debugWarn(`${this.label} cache read failed: ${errorMessage(error)}`);
            return {};
        });
        return this.pending[key] ?? (await this.stored)[key];
    }

    set(key: string, entry: T): void {
        if (this.enabled) {
            this.pending[key] = entry;
        }
    }

    async flush(): Promise<void> {
        if (!Object.keys(this.pending).length) {
            return;
        }
        try {
            await writeCacheEntries(this.filePath, this.pending);
            this.pending = {};
        } catch (error) {
            debugWarn(`${this.label} cache write failed: ${errorMessage(error)}`);
        }
    }
}
