import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findPathsOutside, normalizePathSeparators } from '../utils/paths.ts';
import { resolveConfig } from '../config.ts';
import { buildDocumentProfile, isTestLike } from '../services/document-profile.ts';
import { JEV_API_KEY_ENV, getJevKey } from '../services/jev.ts';
import { getOpenAIKey } from '../services/decisions.ts';
import { createModelScorer } from '../services/model-scorer-factory.ts';
import { filterMatches, rankMatches, type RankedMatchCandidate } from '../services/match.ts';
import { collectCandidateFilesDetailed, readCandidateText } from '../utils/files.ts';
import { mapWithConcurrency } from '../utils/async.ts';
import { readFileIfExists } from '../utils/io.ts';

const READ_CONCURRENCY = 8;

interface BenchmarkCase {
    source: string;
    expectedTop1?: string;
    expectedTop3?: string[];
    expectedTop10Includes?: string[];
    diffText?: string;
}

interface BenchmarkMiss {
    source: string;
    failedChecks: string[];
    expectedTop1?: string;
    expectedTop3?: string[];
    expectedTop10Includes?: string[];
    observedTop10: string[];
    observedRanks: Record<string, number | null>;
}

function getExpectedTop3(entry: BenchmarkCase): string[] {
    if (entry.expectedTop3?.length) {
        return entry.expectedTop3;
    }
    const top1 = entry.expectedTop1;
    return top1 ? [top1] : [];
}

function getObservedRanks(matches: Array<{ file: string }>, expectedFiles: string[]): Record<string, number | null> {
    const ranks: Record<string, number | null> = {};
    for (const file of expectedFiles) {
        const index = matches.findIndex((match) => match.file === file);
        ranks[file] = index === -1 ? null : index + 1;
    }
    return ranks;
}

async function loadBenchmarkCases(filePath: string): Promise<BenchmarkCase[]> {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BenchmarkCase[];

    return parsed.map((entry) => ({
        source: normalizePathSeparators(entry.source),
        expectedTop1: entry.expectedTop1 ? normalizePathSeparators(entry.expectedTop1) : undefined,
        expectedTop3: entry.expectedTop3?.map(normalizePathSeparators),
        expectedTop10Includes: entry.expectedTop10Includes?.map(normalizePathSeparators),
        diffText: entry.diffText,
    }));
}

async function prepareCandidates(candidateFiles: string[], cwd: string): Promise<RankedMatchCandidate[]> {
    const candidates = await mapWithConcurrency(candidateFiles, READ_CONCURRENCY, async (candidatePath) => {
        const candidateText = await readCandidateText(candidatePath);
        if (candidateText === undefined) {
            return undefined;
        }
        const candidateProfile = buildDocumentProfile(candidatePath, candidateText, cwd);
        return {
            file: normalizePathSeparators(path.relative(cwd, candidatePath)),
            preview: candidateProfile.preview,
            profile: candidateProfile,
        };
    });
    return candidates.filter((candidate) => candidate !== undefined);
}

export function registerBenchmarkCommand(program: Command): void {
    program
        .command('benchmark')
        .description('Run benchmark cases against the current matcher')
        .requiredOption('--cases <file>', 'Benchmark case file')
        .option('-c, --candidates <patterns...>', 'Candidate file paths, directories, or file globs')
        .option('--include-file <patterns...>', 'Include only matching files (glob pattern)')
        .option('--exclude-file <patterns...>', 'Exclude matching files (glob pattern)')
        .option('--ranker <name>', `jev (TypeSafe API, default; key from ${JEV_API_KEY_ENV} or JEF) decisions (OpenAI API; key from OPENAI_API_KEY or OPEN_AI), or heuristics (local only)`)
        .option('--jev-model <id>', 'TypeSafe Jev model id')
        .option('--decisions-model <id>', 'OpenAI Decisions model id')
        .option('--fallback-ranker <name>', 'Only heuristics allowed; benchmark never falls back')
        .option('--cache-dir <path>', 'Directory used to cache provider answers')
        .option('--diff-root <path>', 'Base directory for relative paths in case diffs')
        .option('-t, --threshold <number>', 'Minimum similarity threshold')
        .option('--min-score <number>', 'Minimum similarity score override')
        .option('--json', 'Print machine-readable output')
        .action(async (options: {
            cases: string;
            candidates?: string[];
            includeFile?: string[];
            excludeFile?: string[];
            ranker?: string;
            jevModel?: string;
            decisionsModel?: string;
            fallbackRanker?: string;
            cacheDir?: string;
            diffRoot?: string;
            threshold?: string;
            minScore?: string;
            json?: boolean;
        }) => {
            const rootOptions = program.opts();
            const cwd = process.cwd();
            const config = await resolveConfig(
                {
                    config: rootOptions.config,
                    cacheDir: rootOptions.cacheDir,
                    logLevel: rootOptions.logLevel,
                    verbose: rootOptions.verbose,
                    quiet: rootOptions.quiet,
                },
                {
                    candidates: options.candidates,
                    includeFile: options.includeFile,
                    excludeFile: options.excludeFile,
                    ranker: options.ranker,
                    jevModel: options.jevModel,
                    decisionsModel: options.decisionsModel,
                    fallbackRanker: options.fallbackRanker,
                    cacheDir: options.cacheDir,
                    threshold: options.threshold,
                    minScore: options.minScore,
                    json: options.json,
                },
                cwd
            );

            if (config.fallbackRanker !== 'heuristics') {
                throw new Error('Benchmark does not allow a remote fallback ranker; run each provider separately.');
            }
            const casesPath = path.resolve(cwd, options.cases);
            const cases = await loadBenchmarkCases(casesPath);
            const candidateResult = await collectCandidateFilesDetailed(
                config.match.candidatePaths,
                config.match.includePatterns,
                config.match.excludePatterns,
                cwd
            );
            const scorer = config.ranker === 'heuristics' ? undefined
                : createModelScorer(config.ranker, {
                    apiKey: config.ranker === 'jev' ? getJevKey() ?? '' : getOpenAIKey() ?? '',
                    model: config.ranker === 'jev' ? config.jevModel : config.decisionsModel,
                    cacheDir: config.cacheDir,
                });
            const modelStats: { requests: number; cacheHits: number; inputTokens: number | undefined; outputTokens: number | undefined; modelIdentity: 'reported' | 'requested'; models: Set<string> } = {
                requests: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, modelIdentity: 'reported', models: new Set(),
            };
            const observedRanking: Array<{ source: string; results: Array<{ file: string; score: number; modelScore?: number; structuralScore: number }> }> = [];
            const sourcePaths = new Set(cases.map((entry) => path.resolve(cwd, entry.source)));
            // As in match, no case's source module is a candidate test; a test-like source stays one.
            const preparedCandidates = (await prepareCandidates(candidateResult.files, cwd)).filter((candidate) =>
                isTestLike(candidate.profile) || !sourcePaths.has(path.resolve(cwd, candidate.file))
            );

            let top1Hits = 0;
            let top1Total = 0;
            let top3Hits = 0;
            let top3Total = 0;
            let top10IncludeHits = 0;
            let top10IncludeTotal = 0;
            const misses: BenchmarkMiss[] = [];

            // A cases file may come from an untrusted checkout; its sources are read and sent to Jev.
            const [outsideSource] = await findPathsOutside([...sourcePaths], cwd);
            if (outsideSource) {
                throw new Error(`Benchmark source ${outsideSource} is outside the workspace ${cwd}`);
            }

            // Flush even when a later case fails, so answers already paid for stay cached.
            try {
                for (const entry of cases) {
                    const sourcePath = path.resolve(cwd, entry.source);
                    const sourceFileText = await readFileIfExists(sourcePath);
                    const sourceText = sourceFileText ?? '';
                    const sourceProfile = buildDocumentProfile(
                        sourcePath,
                        sourceText,
                        cwd,
                        entry.diffText,
                        options.diffRoot
                    );
                    if (sourceFileText === undefined && !sourceProfile.diffExcerpt) {
                        throw new Error(`Benchmark source not found: ${entry.source} (add a diffText that deletes it)`);
                    }
                    let caseCandidates = preparedCandidates.filter(
                        (candidate) => path.resolve(cwd, candidate.file) !== sourcePath
                    );
                    if (scorer) {
                        const result = await scorer.score(
                            { profile: sourceProfile, text: sourceText, diffOnly: entry.diffText !== undefined },
                            caseCandidates
                        );
                        modelStats.requests += result.requests;
                        modelStats.cacheHits += result.cacheHits;
                        modelStats.inputTokens = modelStats.inputTokens === undefined || result.inputTokens === undefined
                            ? undefined : modelStats.inputTokens + result.inputTokens;
                        modelStats.outputTokens = modelStats.outputTokens === undefined || result.outputTokens === undefined
                            ? undefined : modelStats.outputTokens + result.outputTokens;
                        if (result.modelIdentity === 'requested') modelStats.modelIdentity = 'requested';
                        result.models.forEach((model) => modelStats.models.add(model));
                        caseCandidates = caseCandidates.map((candidate) => ({
                            ...candidate,
                            modelScore: result.scores.get(candidate.file),
                            jevScore: config.ranker === 'jev' ? result.scores.get(candidate.file) : undefined,
                        }));
                    }

                    const matches = filterMatches(
                        rankMatches({ profile: sourceProfile }, caseCandidates),
                        config.match.minScore
                    );
                    observedRanking.push({ source: entry.source, results: matches.map(({ file, score, modelScore, structuralScore }) => ({ file, score, modelScore, structuralScore })) });
                    const topThree = matches.slice(0, 3);
                    const topTen = matches.slice(0, 10);
                    const failedChecks: string[] = [];

                    const expectedTop1 = entry.expectedTop1;
                    if (expectedTop1) {
                        top1Total += 1;
                        if ((matches[0]?.file ?? '') === expectedTop1) {
                            top1Hits += 1;
                        } else {
                            failedChecks.push('top1');
                        }
                    }

                    const expectedTop3 = getExpectedTop3(entry);
                    if (expectedTop3.length) {
                        top3Total += 1;
                        if (topThree.some((match) => expectedTop3.includes(match.file))) {
                            top3Hits += 1;
                        } else {
                            failedChecks.push('top3');
                        }
                    }

                    const expectedTop10Includes = entry.expectedTop10Includes ?? [];
                    if (expectedTop10Includes.length) {
                        top10IncludeTotal += 1;
                        if (expectedTop10Includes.every((file) => topTen.some((match) => match.file === file))) {
                            top10IncludeHits += 1;
                        } else {
                            failedChecks.push('top10Includes');
                        }
                    }

                    if (failedChecks.length) {
                        const expectedFiles = uniqueExpectedFiles(expectedTop1, expectedTop3, expectedTop10Includes);
                        misses.push({
                            source: entry.source,
                            failedChecks,
                            expectedTop1,
                            expectedTop3: expectedTop3.length ? expectedTop3 : undefined,
                            expectedTop10Includes: expectedTop10Includes.length ? expectedTop10Includes : undefined,
                            observedTop10: topTen.map((match) => match.file),
                            observedRanks: getObservedRanks(matches, expectedFiles),
                        });
                    }
                }
            } finally {
                await scorer?.flush();
            }

            const summary = {
                ranker: config.ranker,
                requestedRanker: config.ranker,
                effectiveRanker: config.ranker,
                observedRanking,
                modelScorer: scorer ? { provider: config.ranker, ...modelStats, models: [...modelStats.models].sort() } : undefined,
                cases: cases.length,
                threshold: config.match.threshold,
                minScore: config.match.minScore,
                top1Cases: top1Total,
                top1Rate: top1Total ? top1Hits / top1Total : 0,
                top3Cases: top3Total,
                top3Rate: top3Total ? top3Hits / top3Total : 0,
                top10IncludeCases: top10IncludeTotal,
                top10IncludeRate: top10IncludeTotal ? top10IncludeHits / top10IncludeTotal : 0,
                misses,
                candidateLimitReached: candidateResult.truncated,
                jev: config.ranker === 'jev' && scorer ? { requests: modelStats.requests, cacheHits: modelStats.cacheHits,
                    inputTokens: modelStats.inputTokens, models: [...modelStats.models].sort() } : undefined,
            };

            if (options.json) {
                console.log(JSON.stringify(summary));
                return;
            }

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
                const label = summary.modelScorer.provider;
                console.log(`${label}Requests: ${summary.modelScorer.requests}`);
                console.log(`${label}CacheHits: ${summary.modelScorer.cacheHits}`);
                console.log(`${label}InputTokens: ${summary.modelScorer.inputTokens ?? 'unknown'}`);
                console.log(`${label}Models: ${summary.modelScorer.models.join(', ') || 'none'}`);
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
        });
}

function uniqueExpectedFiles(
    expectedTop1: string | undefined,
    expectedTop3: string[],
    expectedTop10Includes: string[]
): string[] {
    return [...new Set([
        ...(expectedTop1 ? [expectedTop1] : []),
        ...expectedTop3,
        ...expectedTop10Includes,
    ])];
}
