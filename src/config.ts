import path from 'node:path';
import { DECISIONS_MODEL } from './services/decisions.ts';
import { REPRESENTATIVE_TOP_K_REQUIRED } from './services/representative-selection.ts';
import { mergeArrays } from './utils/arrays.ts';
import { readFileIfExists, setDebugLogLevel } from './utils/io.ts';
import { isWorkspaceContainedPath } from './utils/paths.ts';
import { clamp, firstFiniteNumber, parseBoolean, parseChoice, parseLogLevel, readEnv, type LogLevel } from './utils/values.ts';

const RANKERS = ['jev', 'decisions', 'heuristics'] as const;
const FALLBACK_RANKERS = ['decisions', 'heuristics'] as const;
const SELECTION_POLICIES = ['adaptive', 'conservative', 'targeted', 'representative'] as const;
const OPENAI_ALIAS = { openai: 'decisions' } as const;
const MAX_TOP_K = 1000;
const PINNED_JEV_MODEL = 'jev-1.13.0';

export type Ranker = typeof RANKERS[number];
export type FallbackRanker = typeof FALLBACK_RANKERS[number];
export type SelectionPolicy = typeof SELECTION_POLICIES[number];

export interface MatchDefaults {
    topK?: number;
    threshold: number;
    minScore: number;
    selectionPolicy: SelectionPolicy;
    candidatePaths: string[];
    includePatterns: string[];
    excludePatterns: string[];
}

export interface AppConfig {
    ranker?: Ranker;
    jevModel?: string;
    decisionsModel?: string;
    fallbackRanker?: FallbackRanker;
    cacheDir?: string;
    logLevel?: LogLevel;
    quiet?: boolean;
    verbose?: boolean;
    match?: Partial<MatchDefaults>;
}

export interface RuntimeConfig {
    ranker: Ranker;
    jevModel: string;
    decisionsModel: string;
    fallbackRanker: FallbackRanker;
    cacheDir: string;
    logLevel: LogLevel;
    quiet: boolean;
    verbose: boolean;
    match: MatchDefaults;
    configFile?: string;
}

export interface RootOptions {
    config?: string;
    cacheDir?: string;
    logLevel?: string;
    verbose?: boolean;
    quiet?: boolean;
}

export interface MatchCommandOptions {
    threshold?: string;
    topK?: string;
    minScore?: string;
    selectionPolicy?: string;
    candidates?: string[];
    includeFile?: string[];
    excludeFile?: string[];
    ranker?: string;
    jevModel?: string;
    decisionsModel?: string;
    fallbackRanker?: string;
    cacheDir?: string;
}

export interface LoadedConfig {
    config: AppConfig;
    autoDiscovered: boolean;
    filePath?: string;
}

const DEFAULT_CONFIG = {
    ranker: 'jev',
    jevModel: PINNED_JEV_MODEL,
    decisionsModel: DECISIONS_MODEL,
    fallbackRanker: 'heuristics',
    cacheDir: '.rbt/cache',
    logLevel: 'info',
    match: {
        threshold: 0,
        minScore: 0,
        selectionPolicy: 'adaptive',
        candidatePaths: ['test', 'tests'],
        includePatterns: ['**/*'],
        excludePatterns: ['**/dist/**', '**/.git/**', '**/node_modules/**', '**/build/**'],
    },
} satisfies AppConfig;

function parseRanker(value: unknown): Ranker {
    return parseChoice(value, RANKERS,
        `Invalid ranker "${value}". Expected "jev", "decisions" (alias "openai"), or "heuristics".`, OPENAI_ALIAS);
}

function parseFallbackRanker(value: unknown): FallbackRanker {
    return parseChoice(value, FALLBACK_RANKERS,
        `Invalid fallback ranker "${value}". Expected "decisions" or "heuristics".`, OPENAI_ALIAS);
}

function parseSelectionPolicy(value: unknown): SelectionPolicy {
    return parseChoice(value, SELECTION_POLICIES,
        `Invalid selection policy "${value}". Expected "adaptive", "conservative", "targeted", or "representative".`);
}

function parseJsonConfig(raw: string, filePath: string): AppConfig {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Failed to parse config file ${filePath}: ${(error as Error).message}`);
    }
    return typeof parsed === 'object' && parsed !== null ? parsed as AppConfig : {};
}

export async function loadConfig(configPath?: string): Promise<LoadedConfig> {
    const candidates = configPath
        ? [{ filePath: configPath, autoDiscovered: false }]
        : [
            { filePath: path.join(process.cwd(), '.rbt', 'config.json'), autoDiscovered: true },
            { filePath: path.join(process.cwd(), '.rbtconfig'), autoDiscovered: true },
        ];

    for (const { filePath, autoDiscovered } of candidates) {
        const raw = await readFileIfExists(filePath);
        if (raw !== undefined) {
            return { config: parseJsonConfig(raw, filePath), autoDiscovered, filePath };
        }
    }
    return { config: {}, autoDiscovered: false };
}

async function assertRepoConfigStaysInWorkspace(paths: string[], workspace: string, setting: string): Promise<void> {
    const contained = await Promise.all(
        paths.map((configuredPath) => isWorkspaceContainedPath(path.resolve(workspace, configuredPath), workspace))
    );
    if (contained.includes(false)) {
        throw new Error(`Auto-discovered repo config cannot set ${setting} outside the workspace.`);
    }
}

function resolveFallbackRanker(ranker: Ranker, options: MatchCommandOptions, fileConfig: AppConfig): FallbackRanker {
    const envFallbackRanker = readEnv('RBT_FALLBACK_RANKER');
    const fallbackRanker = parseFallbackRanker(
        options.fallbackRanker ?? envFallbackRanker ?? fileConfig.fallbackRanker ?? DEFAULT_CONFIG.fallbackRanker
    );
    if (fallbackRanker !== 'decisions' || ranker === 'jev') {
        return fallbackRanker;
    }
    const rankerChosenAboveFallback = options.fallbackRanker === undefined
        && (options.ranker !== undefined || (readEnv('RBT_RANKER') !== undefined && envFallbackRanker === undefined));
    if (rankerChosenAboveFallback) {
        return 'heuristics';
    }
    throw new Error('The decisions fallback ranker is only supported with --ranker jev.');
}

function resolveTopK(options: MatchCommandOptions, fileMatch: Partial<MatchDefaults>): number | undefined {
    const configured = firstFiniteNumber(options.topK, process.env.RBT_TOP_K, process.env.RBT_MATCH_TOP_K, fileMatch.topK);
    return configured === undefined ? undefined : Math.floor(clamp(configured, 1, MAX_TOP_K));
}

function resolveRepresentativeTopK(options: MatchCommandOptions, fileMatch: Partial<MatchDefaults>): number {
    const value: unknown = options.topK ?? readEnv('RBT_TOP_K') ?? readEnv('RBT_MATCH_TOP_K') ?? fileMatch.topK;
    const topK = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
    if (typeof topK !== 'number' || !Number.isSafeInteger(topK) || topK < 1) {
        throw new Error(REPRESENTATIVE_TOP_K_REQUIRED);
    }
    return topK;
}

export async function resolveConfig(
    rootOptions: RootOptions,
    options: MatchCommandOptions,
    cwd: string = process.cwd()
): Promise<RuntimeConfig> {
    const { config: fileConfig, autoDiscovered, filePath: configFile } = await loadConfig(rootOptions.config);
    const fileMatch = fileConfig.match ?? {};
    const defaults = DEFAULT_CONFIG.match;
    const workspace = path.resolve(cwd);
    const env = process.env;

    const ranker = parseRanker(options.ranker ?? readEnv('RBT_RANKER') ?? fileConfig.ranker ?? DEFAULT_CONFIG.ranker);
    const fallbackRanker = resolveFallbackRanker(ranker, options, fileConfig);
    const logLevel = parseLogLevel(rootOptions.logLevel ?? readEnv('RBT_LOG_LEVEL') ?? fileConfig.logLevel ?? DEFAULT_CONFIG.logLevel);
    setDebugLogLevel(logLevel === 'debug');

    const threshold = clamp(
        firstFiniteNumber(options.threshold, env.RBT_THRESHOLD, env.RBT_MATCH_THRESHOLD, fileMatch.threshold) ?? defaults.threshold,
        0,
        1
    );
    const minScore = clamp(
        firstFiniteNumber(options.minScore, env.RBT_MIN_SCORE, env.RBT_MATCH_MIN_SCORE, fileMatch.minScore) ?? threshold,
        0,
        1
    );
    const selectionPolicy = parseSelectionPolicy(
        options.selectionPolicy ?? readEnv('RBT_SELECTION_POLICY') ?? fileMatch.selectionPolicy ?? defaults.selectionPolicy
    );
    const topK = selectionPolicy === 'representative'
        ? resolveRepresentativeTopK(options, fileMatch)
        : resolveTopK(options, fileMatch);

    const cacheDirOverride = options.cacheDir ?? rootOptions.cacheDir ?? readEnv('RBT_CACHE_DIR');
    const cliCandidates = options.candidates?.length ? options.candidates : undefined;
    if (autoDiscovered && cacheDirOverride === undefined && fileConfig.cacheDir) {
        await assertRepoConfigStaysInWorkspace([fileConfig.cacheDir], workspace, 'cacheDir');
    }
    if (autoDiscovered && !cliCandidates && fileMatch.candidatePaths) {
        await assertRepoConfigStaysInWorkspace(fileMatch.candidatePaths, workspace, 'candidate paths');
    }

    return {
        ranker,
        jevModel: options.jevModel ?? readEnv('RBT_JEV_MODEL') ?? fileConfig.jevModel ?? DEFAULT_CONFIG.jevModel,
        decisionsModel: options.decisionsModel ?? readEnv('RBT_DECISIONS_MODEL') ?? fileConfig.decisionsModel ?? DEFAULT_CONFIG.decisionsModel,
        fallbackRanker,
        cacheDir: path.resolve(cwd, cacheDirOverride ?? fileConfig.cacheDir ?? DEFAULT_CONFIG.cacheDir),
        logLevel,
        quiet: parseBoolean(rootOptions.quiet ?? readEnv('RBT_QUIET') ?? fileConfig.quiet),
        verbose: parseBoolean(rootOptions.verbose ?? readEnv('RBT_VERBOSE') ?? fileConfig.verbose),
        match: {
            topK,
            threshold,
            minScore,
            selectionPolicy,
            candidatePaths: cliCandidates ?? fileMatch.candidatePaths ?? defaults.candidatePaths,
            includePatterns: options.includeFile?.length ? options.includeFile : fileMatch.includePatterns ?? defaults.includePatterns,
            excludePatterns: mergeArrays(options.excludeFile, fileMatch.excludePatterns ?? defaults.excludePatterns),
        },
        configFile,
    };
}
