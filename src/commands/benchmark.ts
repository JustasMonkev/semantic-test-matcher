import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig, type MatchCommandOptions, type RootOptions, type RuntimeConfig } from '../config.ts';
import { isTestLike } from '../services/document-profile.ts';
import { attachModelScores, filterMatches, rankMatches, type MatchCandidate, type RankedMatchCandidate } from '../services/match.ts';
import { createScorerFromConfig } from '../services/model-scorer-factory.ts';
import { addTokenCounts, type ModelScorer, type ModelScoreResult } from '../services/model-scorer.ts';
import { collectCandidateFiles } from '../utils/files.ts';
import { findPathsOutside, normalizePathSeparators } from '../utils/paths.ts';
import { loadCandidates, RANKER_OPTION_DESCRIPTION, readSourceDocument, rootOptionsOf } from './shared.ts';

interface BenchmarkOptions extends MatchCommandOptions {
    cases: string;
    diffRoot?: string;
    json?: boolean;
}

interface BenchmarkCase {
    source: string;
    expectedTop1?: string;
    expectedTop3?: string[];
    expectedTop10Includes?: string[];
    diffText?: string;
}

type CheckName = 'top1' | 'top3' | 'top10Includes';
type CheckTally = Record<CheckName, { cases: number; hits: number }>;

interface BenchmarkMiss {
    source: string;
    failedChecks: CheckName[];
    expectedTop1?: string;
    expectedTop3?: string[];
    expectedTop10Includes?: string[];
    observedTop10: string[];
    observedRanks: Record<string, number | null>;
}

interface ModelUsage {
    requests: number;
    cacheHits: number;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    modelIdentity: 'reported' | 'requested';
    models: Set<string>;
}

interface ObservedRanking {
    source: string;
    results: Array<Pick<MatchCandidate, 'file' | 'score' | 'modelScore' | 'structuralScore'>>;
}

export function registerBenchmarkCommand(program: Command): void {
    program
        .command('benchmark')
        .description('Run benchmark cases against the current matcher')
        .requiredOption('--cases <file>', 'Benchmark case file')
        .option('-c, --candidates <patterns...>', 'Candidate file paths, directories, or file globs')
        .option('--include-file <patterns...>', 'Include only matching files (glob pattern)')
        .option('--exclude-file <patterns...>', 'Exclude matching files (glob pattern)')
        .option('--ranker <name>', RANKER_OPTION_DESCRIPTION)
        .option('--jev-model <id>', 'TypeSafe Jev model id')
        .option('--decisions-model <id>', 'OpenAI Decisions model id')
        .option('--fallback-ranker <name>', 'Only heuristics allowed; benchmark never falls back')
        .option('--cache-dir <path>', 'Directory used to cache provider answers')
        .option('--diff-root <path>', 'Base directory for relative paths in case diffs')
        .option('-t, --threshold <number>', 'Minimum similarity threshold')
        .option('--min-score <number>', 'Minimum similarity score override')
        .option('--json', 'Print machine-readable output')
        .action((options: BenchmarkOptions) => runBenchmark(options, rootOptionsOf(program)));
}

async function loadBenchmarkCases(filePath: string): Promise<BenchmarkCase[]> {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as BenchmarkCase[];
    return parsed.map((entry) => ({
        source: normalizePathSeparators(entry.source),
        expectedTop1: entry.expectedTop1 ? normalizePathSeparators(entry.expectedTop1) : undefined,
        expectedTop3: entry.expectedTop3?.map(normalizePathSeparators),
        expectedTop10Includes: entry.expectedTop10Includes?.map(normalizePathSeparators),
        diffText: entry.diffText,
    }));
}

function expectedTop3Of(entry: BenchmarkCase): string[] {
    if (entry.expectedTop3?.length) {
        return entry.expectedTop3;
    }
    return entry.expectedTop1 ? [entry.expectedTop1] : [];
}

function observedRanks(matches: MatchCandidate[], files: string[]): Record<string, number | null> {
    const ranks: Record<string, number | null> = {};
    for (const file of files) {
        const index = matches.findIndex((match) => match.file === file);
        ranks[file] = index === -1 ? null : index + 1;
    }
    return ranks;
}

function emptyTally(): CheckTally {
    return { top1: { cases: 0, hits: 0 }, top3: { cases: 0, hits: 0 }, top10Includes: { cases: 0, hits: 0 } };
}

function hitRate({ cases, hits }: { cases: number; hits: number }): number {
    return cases ? hits / cases : 0;
}

function evaluateCase(entry: BenchmarkCase, matches: MatchCandidate[], tally: CheckTally): BenchmarkMiss | undefined {
    const expectedTop1 = entry.expectedTop1;
    const expectedTop3 = expectedTop3Of(entry);
    const expectedTop10Includes = entry.expectedTop10Includes ?? [];
    const observedTop3 = matches.slice(0, 3).map((match) => match.file);
    const observedTop10 = matches.slice(0, 10).map((match) => match.file);

    const checks: Array<{ name: CheckName; applies: boolean; passes: () => boolean }> = [
        { name: 'top1', applies: Boolean(expectedTop1), passes: () => matches[0]?.file === expectedTop1 },
        { name: 'top3', applies: expectedTop3.length > 0, passes: () => observedTop3.some((file) => expectedTop3.includes(file)) },
        {
            name: 'top10Includes',
            applies: expectedTop10Includes.length > 0,
            passes: () => expectedTop10Includes.every((file) => observedTop10.includes(file)),
        },
    ];

    const failedChecks: CheckName[] = [];
    for (const { name, passes } of checks.filter((check) => check.applies)) {
        tally[name].cases += 1;
        if (passes()) {
            tally[name].hits += 1;
        } else {
            failedChecks.push(name);
        }
    }
    if (!failedChecks.length) {
        return undefined;
    }

    const expectedFiles = [...new Set([...(expectedTop1 ? [expectedTop1] : []), ...expectedTop3, ...expectedTop10Includes])];
    return {
        source: entry.source,
        failedChecks,
        expectedTop1,
        expectedTop3: expectedTop3.length ? expectedTop3 : undefined,
        expectedTop10Includes: expectedTop10Includes.length ? expectedTop10Includes : undefined,
        observedTop10,
        observedRanks: observedRanks(matches, expectedFiles),
    };
}

function recordUsage(usage: ModelUsage, result: ModelScoreResult): void {
    usage.requests += result.requests;
    usage.cacheHits += result.cacheHits;
    usage.inputTokens = addTokenCounts(usage.inputTokens, result.inputTokens);
    usage.outputTokens = addTokenCounts(usage.outputTokens, result.outputTokens);
    if (result.modelIdentity === 'requested') {
        usage.modelIdentity = 'requested';
    }
    result.models.forEach((model) => usage.models.add(model));
}

async function runBenchmark(options: BenchmarkOptions, rootOptions: RootOptions): Promise<void> {
    const cwd = process.cwd();
    const config = await resolveConfig(rootOptions, options, cwd);
    if (config.fallbackRanker !== 'heuristics') {
        throw new Error('Benchmark does not allow a remote fallback ranker; run each provider separately.');
    }

    const cases = await loadBenchmarkCases(path.resolve(cwd, options.cases));
    const candidateScan = await collectCandidateFiles(
        config.match.candidatePaths,
        config.match.includePatterns,
        config.match.excludePatterns,
        cwd
    );
    const scorer = config.ranker === 'heuristics' ? undefined : createScorerFromConfig(config.ranker, config);
    const sourcePaths = new Set(cases.map((entry) => path.resolve(cwd, entry.source)));
    const candidates = (await loadCandidates(candidateScan.files, cwd)).filter((candidate) =>
        isTestLike(candidate.profile) || !sourcePaths.has(path.resolve(cwd, candidate.file))
    );
    const [outsideSource] = await findPathsOutside([...sourcePaths], cwd);
    if (outsideSource) {
        throw new Error(`Benchmark source ${outsideSource} is outside the workspace ${cwd}`);
    }

    const usage: ModelUsage = { requests: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, modelIdentity: 'reported', models: new Set() };
    const tally = emptyTally();
    const observedRanking: ObservedRanking[] = [];
    const misses: BenchmarkMiss[] = [];
    try {
        for (const entry of cases) {
            const matches = await rankCase(entry, candidates, scorer, usage, config, cwd, options.diffRoot);
            observedRanking.push({
                source: entry.source,
                results: matches.map(({ file, score, modelScore, structuralScore }) => ({ file, score, modelScore, structuralScore })),
            });
            const miss = evaluateCase(entry, matches, tally);
            if (miss) {
                misses.push(miss);
            }
        }
    } finally {
        await scorer?.flush();
    }

    const models = [...usage.models].sort();
    const summary = {
        ranker: config.ranker,
        requestedRanker: config.ranker,
        effectiveRanker: config.ranker,
        observedRanking,
        modelScorer: scorer ? { provider: config.ranker, ...usage, models } : undefined,
        cases: cases.length,
        threshold: config.match.threshold,
        minScore: config.match.minScore,
        top1Cases: tally.top1.cases,
        top1Rate: hitRate(tally.top1),
        top3Cases: tally.top3.cases,
        top3Rate: hitRate(tally.top3),
        top10IncludeCases: tally.top10Includes.cases,
        top10IncludeRate: hitRate(tally.top10Includes),
        misses,
        candidateLimitReached: candidateScan.truncated,
        jev: config.ranker === 'jev' && scorer
            ? { requests: usage.requests, cacheHits: usage.cacheHits, inputTokens: usage.inputTokens, models }
            : undefined,
    };

    if (options.json) {
        console.log(JSON.stringify(summary));
        return;
    }
    printSummary(summary);
}

async function rankCase(
    entry: BenchmarkCase,
    candidates: RankedMatchCandidate[],
    scorer: ModelScorer | undefined,
    usage: ModelUsage,
    config: RuntimeConfig,
    cwd: string,
    diffRoot: string | undefined
): Promise<MatchCandidate[]> {
    const sourcePath = path.resolve(cwd, entry.source);
    const source = await readSourceDocument(sourcePath, cwd, entry.diffText, diffRoot);
    if (source.missingWithoutDeletionDiff) {
        throw new Error(`Benchmark source not found: ${entry.source} (add a diffText that deletes it)`);
    }
    const caseCandidates = candidates.filter((candidate) => path.resolve(cwd, candidate.file) !== sourcePath);
    const modelResult = scorer
        ? await scorer.score({ profile: source.profile, text: source.text, diffOnly: entry.diffText !== undefined }, caseCandidates)
        : undefined;
    if (modelResult) {
        recordUsage(usage, modelResult);
    }
    const ranked = rankMatches({ profile: source.profile }, attachModelScores(caseCandidates, modelResult, config.ranker));
    return filterMatches(ranked, config.match.minScore);
}

function printSummary(summary: {
    ranker: string;
    cases: number;
    top1Cases: number;
    top1Rate: number;
    top3Cases: number;
    top3Rate: number;
    top10IncludeCases: number;
    top10IncludeRate: number;
    candidateLimitReached: boolean;
    modelScorer?: { provider: string; requests: number; cacheHits: number; inputTokens: number | undefined; models: string[] };
    misses: BenchmarkMiss[];
}): void {
    console.log(`ranker: ${summary.ranker}`);
    console.log(`cases: ${summary.cases}`);
    console.log(`top1Cases: ${summary.top1Cases}`);
    console.log(`top1Rate: ${summary.top1Rate.toFixed(4)}`);
    console.log(`top3Cases: ${summary.top3Cases}`);
    console.log(`top3Rate: ${summary.top3Rate.toFixed(4)}`);
    console.log(`top10IncludeCases: ${summary.top10IncludeCases}`);
    console.log(`top10IncludeRate: ${summary.top10IncludeRate.toFixed(4)}`);
    console.log(`candidateLimitReached: ${summary.candidateLimitReached}`);
    if (summary.modelScorer) {
        const { provider, requests, cacheHits, inputTokens, models } = summary.modelScorer;
        console.log(`${provider}Requests: ${requests}`);
        console.log(`${provider}CacheHits: ${cacheHits}`);
        console.log(`${provider}InputTokens: ${inputTokens ?? 'unknown'}`);
        console.log(`${provider}Models: ${models.join(', ') || 'none'}`);
    }
    if (!summary.misses.length) {
        console.log('misses: none');
        return;
    }
    console.log(`misses: ${summary.misses.length}`);
    for (const miss of summary.misses) {
        console.log(`- ${miss.source}: ${miss.failedChecks.join(', ')}`);
        console.log(`  observedTop10: ${miss.observedTop10.join(', ')}`);
    }
}
