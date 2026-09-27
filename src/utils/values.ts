export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Unrecognized values count as false rather than falling through to the next source.
export function parseBoolean(value: unknown): boolean {
    return value === true || value === '1' || value === 'true' || value === 'yes';
}

// Blank strings and null mean "not set": `Number('')` and `Number(null)` are 0.
export function firstFiniteNumber(...values: Array<unknown>): number | undefined {
    for (const value of values) {
        if (value === null || (typeof value === 'string' && !value.trim())) {
            continue;
        }
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return undefined;
}

export function clamp(value: number, min: number, max: number): number {
    if (Number.isNaN(value)) return min;
    return Math.min(Math.max(value, min), max);
}

// CI often sets variables to empty strings; treat those as unset so config and defaults still apply.
export function readEnv(name: string): string | undefined {
    const value = process.env[name];
    return value?.trim() ? value : undefined;
}

export function parseLogLevel(value?: string): LogLevel {
    const normalized = (value || '').trim().toLowerCase();
    if (!normalized) {
        return 'info';
    }

    if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
        return normalized;
    }

    throw new Error(`Invalid log level "${value}". Expected "debug", "info", "warn", or "error".`);
}

export function isProbability(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 1;
}
