export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = typeof LOG_LEVELS[number];

export function parseBoolean(value: unknown): boolean {
    return value === true || value === '1' || value === 'true' || value === 'yes';
}

function isBlank(value: unknown): boolean {
    return value === null || (typeof value === 'string' && !value.trim());
}

export function firstFiniteNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
        const parsed = isBlank(value) ? Number.NaN : Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}

export function clamp(value: number, min: number, max: number): number {
    if (Number.isNaN(value)) {
        return min;
    }
    return Math.min(Math.max(value, min), max);
}

export function readEnv(name: string): string | undefined {
    const value = process.env[name];
    return value?.trim() ? value : undefined;
}

export function readFirstEnv(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
    for (const name of names) {
        const value = env[name]?.trim();
        if (value) {
            return value;
        }
    }
    return undefined;
}

export function parseChoice<T extends string>(
    value: unknown,
    choices: readonly T[],
    invalidMessage: string,
    aliases: Readonly<Record<string, T>> = {}
): T {
    const normalized = String(value ?? '').trim().toLowerCase();
    const resolved = new Map(Object.entries(aliases)).get(normalized) ?? normalized;
    if ((choices as readonly string[]).includes(resolved)) {
        return resolved as T;
    }
    throw new Error(invalidMessage);
}

export function parseLogLevel(value?: string): LogLevel {
    if (!value?.trim()) {
        return 'info';
    }
    return parseChoice(value, LOG_LEVELS, `Invalid log level "${value}". Expected "debug", "info", "warn", or "error".`);
}

export function isProbability(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 1;
}
