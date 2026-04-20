import fs from 'node:fs/promises';
import path from 'node:path';
import { isParentPath } from './utils/patterns.ts';

export type EmbeddingProvider = 'hf' | 'ollama';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface MatchDefaults {
    topK: number;
    threshold: number;
    minScore: number;
    candidatePaths: string[];
    includePatterns: string[];
    excludePatterns: string[];
}

export interface AppConfig {
    provider?: EmbeddingProvider;
    model?: string;
    ollamaHost?: string;
    cacheDir?: string;
    logLevel?: LogLevel;
    quiet?: boolean;
    verbose?: boolean;
    match?: Partial<MatchDefaults>;
}

export interface RuntimeConfig {
    provider: EmbeddingProvider;
    model: string;
    ollamaHost: string;
    cacheDir: string;
    logLevel: LogLevel;
    quiet: boolean;
    verbose: boolean;
    match: MatchDefaults;
    configFile?: string;
}

export interface RootOptions {
    config?: string;
    provider?: string;
    model?: string;
    cacheDir?: string;
    logLevel?: string;
    verbose?: boolean;
    quiet?: boolean;
}

export interface MatchCommandOptions {
    threshold?: string;
    topK?: string;
    minScore?: string;
    candidates?: string[];
    includeFile?: string[];
    excludeFile?: string[];
    provider?: string;
    model?: string;
    cacheDir?: string;
    json?: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
    provider: 'hf',
    model: 'Xenova/all-MiniLM-L6-v2',
    ollamaHost: 'http://127.0.0.1:11434',
    cacheDir: '.rbt/cache',
    logLevel: 'info',
    match: {
        topK: 5,
        threshold: 0.45,
        minScore: 0,
        candidatePaths: ['test', 'tests'],
        includePatterns: ['**/*'],
        excludePatterns: ['**/dist/**', '**/.git/**', '**/node_modules/**', '**/build/**']
    },
};

export function clamp(value: number, min: number, max: number): number {
    if (Number.isNaN(value)) return min;
    return Math.min(Math.max(value, min), max);
}

function firstFiniteNumber(...values: Array<unknown>): number | undefined {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return undefined;
}

function parseProvider(value?: string): EmbeddingProvider {
    if (!value) {
        return 'hf';
    }

    const normalized = value.trim().toLowerCase();
    return normalized === 'ollama' ? 'ollama' : 'hf';
}

function parseBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        if (value === '1' || value === 'true' || value === 'yes') {
            return true;
        }
        if (value === '0' || value === 'false' || value === 'no') {
            return false;
        }
    }
    return fallback;
}

function parseLogLevel(value?: string): LogLevel {
    const normalized = (value || '').trim().toLowerCase();
    if (normalized === 'debug' || normalized === 'warn' || normalized === 'error') {
        return normalized;
    }
    return 'info';
}

function mergeArrays(left: string[] = [], right: string[] = []): string[] {
    if (!left.length) {
        return right;
    }
    if (!right.length) {
        return left;
    }
    return [...new Set([...left, ...right])];
}

function parseJsonConfig(raw: string, filePath: string): AppConfig {
    try {
        const parsed = JSON.parse(raw) as AppConfig;
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch (error) {
        throw new Error(`Failed to parse config file ${filePath}: ${(error as Error).message}`);
    }
}

function isLoopbackHost(value: string): boolean {
    try {
        const url = new URL(value);
        const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

        if (hostname === 'localhost' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
            return true;
        }

        const octets = hostname.split('.');
        return octets.length === 4 &&
            octets.every((octet) => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255) &&
            Number(octets[0]) === 127;
    } catch {
        return false;
    }
}

async function resolveRealPath(targetPath: string): Promise<string> {
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

async function isWorkspaceContainedPath(targetPath: string, workspace: string): Promise<boolean> {
    return isParentPath(workspace, targetPath) &&
        isParentPath(workspace, await resolveRealPath(targetPath));
}

export interface LoadedConfig {
    config: AppConfig;
    autoDiscovered: boolean;
    filePath?: string;
}

export async function loadConfig(configPath?: string): Promise<LoadedConfig> {
    const candidates = configPath
        ? [{ filePath: configPath, autoDiscovered: false }]
        : [
            { filePath: path.join(process.cwd(), '.rbt', 'config.json'), autoDiscovered: true },
            { filePath: path.join(process.cwd(), '.rbtconfig'), autoDiscovered: true },
        ];

    for (const candidate of candidates) {
        try {
            const raw = await fs.readFile(candidate.filePath, 'utf8');
            return {
                config: parseJsonConfig(raw, candidate.filePath),
                autoDiscovered: candidate.autoDiscovered,
                filePath: candidate.filePath,
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }

    return { config: {}, autoDiscovered: false };
}

export async function resolveConfig(
    rootOptions: RootOptions,
    commandOptions: MatchCommandOptions,
    cwd: string = process.cwd()
): Promise<RuntimeConfig> {
    const { config: fileConfig, autoDiscovered, filePath: configFile } = await loadConfig(rootOptions.config);
    const resolvedWorkspace = path.resolve(cwd);
    const resolvedProvider = parseProvider(
        commandOptions.provider ??
            rootOptions.provider ??
            process.env.RBT_PROVIDER ??
            fileConfig.provider ??
            DEFAULT_CONFIG.provider
    );
    const resolvedModel = commandOptions.model ??
        rootOptions.model ??
        process.env.RBT_MODEL ??
        (resolvedProvider === 'ollama'
            ? process.env.OLLAMA_MODEL || process.env.RBT_OLLAMA_MODEL || fileConfig.model || 'qwen3.5:9b'
            : fileConfig.model) ??
        DEFAULT_CONFIG.model!;

    const resolvedLogLevel = parseLogLevel(
        rootOptions.logLevel ??
            process.env.RBT_LOG_LEVEL ??
            fileConfig.logLevel ??
            DEFAULT_CONFIG.logLevel
    );

    const resolvedQuiet = parseBoolean(
        rootOptions.quiet ??
        process.env.RBT_QUIET ??
        fileConfig.quiet ??
        false,
        false
    );
    const resolvedVerbose = parseBoolean(
        rootOptions.verbose ??
        process.env.RBT_VERBOSE ??
        fileConfig.verbose ??
        false,
        false
    );

    const resolvedOllamaHost = process.env.OLLAMA_HOST ?? fileConfig.ollamaHost ?? DEFAULT_CONFIG.ollamaHost!;
    if (autoDiscovered && process.env.OLLAMA_HOST == null && fileConfig.ollamaHost && !isLoopbackHost(fileConfig.ollamaHost)) {
        throw new Error('Auto-discovered repo config cannot set ollamaHost to a non-loopback address.');
    }

    const resolvedTopK = firstFiniteNumber(
        commandOptions.topK,
        process.env.RBT_TOP_K,
        process.env.RBT_MATCH_TOP_K,
        fileConfig.match?.topK,
        DEFAULT_CONFIG.match!.topK
)!;

    const resolvedThreshold = firstFiniteNumber(
        commandOptions.threshold,
        process.env.RBT_THRESHOLD,
        process.env.RBT_MATCH_THRESHOLD,
        fileConfig.match?.threshold,
        DEFAULT_CONFIG.match!.threshold
)!;

    const configuredMinScore = firstFiniteNumber(
        commandOptions.minScore,
        process.env.RBT_MIN_SCORE,
        process.env.RBT_MATCH_MIN_SCORE,
        fileConfig.match?.minScore
    );

    const minScore = clamp(configuredMinScore ?? resolvedThreshold, 0, 1);
    const topK = Math.max(1, Math.floor(clamp(resolvedTopK, 1, 1000)));

    const resolvedCacheDir = commandOptions.cacheDir ??
        rootOptions.cacheDir ??
        process.env.RBT_CACHE_DIR ??
        fileConfig.cacheDir ??
        DEFAULT_CONFIG.cacheDir!;
    if (
        autoDiscovered &&
        commandOptions.cacheDir == null &&
        rootOptions.cacheDir == null &&
        process.env.RBT_CACHE_DIR == null &&
        fileConfig.cacheDir &&
        !await isWorkspaceContainedPath(path.resolve(resolvedWorkspace, fileConfig.cacheDir), resolvedWorkspace)
    ) {
        throw new Error('Auto-discovered repo config cannot set cacheDir outside the workspace.');
    }

    const cacheDir = path.resolve(cwd, resolvedCacheDir);

    const candidatePaths = commandOptions.candidates && commandOptions.candidates.length
        ? commandOptions.candidates
        : fileConfig.match?.candidatePaths ??
        DEFAULT_CONFIG.match!.candidatePaths!;
    if (
        autoDiscovered &&
        (!commandOptions.candidates || commandOptions.candidates.length === 0) &&
        fileConfig.match?.candidatePaths &&
        (await Promise.all(
            fileConfig.match.candidatePaths.map((candidatePath) =>
                isWorkspaceContainedPath(path.resolve(resolvedWorkspace, candidatePath), resolvedWorkspace)
            )
        )).some((isContained) => !isContained)
    ) {
        throw new Error('Auto-discovered repo config cannot set candidate paths outside the workspace.');
    }

    const includePatterns = mergeArrays(commandOptions.includeFile, fileConfig.match?.includePatterns ??
        DEFAULT_CONFIG.match!.includePatterns!);
    const excludePatterns = mergeArrays(commandOptions.excludeFile, fileConfig.match?.excludePatterns ??
        DEFAULT_CONFIG.match!.excludePatterns!);

    return {
        provider: resolvedProvider,
        model: resolvedModel,
        ollamaHost: resolvedOllamaHost,
        cacheDir,
        logLevel: resolvedLogLevel,
        quiet: resolvedQuiet,
        verbose: resolvedVerbose,
        match: {
            topK,
            threshold: clamp(resolvedThreshold, 0, 1),
            minScore,
            candidatePaths,
            includePatterns,
            excludePatterns
        },
        configFile,
    };
}
