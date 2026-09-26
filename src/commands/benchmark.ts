import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig } from '../config.ts';
import { EmbeddingSession } from '../services/embeddings.ts';
import { buildDocumentProfile, type DocumentProfile } from '../services/document-profile.ts';
import type { EmbeddingBackend } from '../services/embedding-types.ts';
import { JEV_API_KEY_ENV, JevScorer } from '../services/jev.ts';
import { filterMatches, rankMatches } from '../services/match.ts';
import { collectCandidateFilesDetailed } from '../utils/files.ts';
import { mapWithConcurrency } from '../utils/async.ts';

const EMBED_CONCURRENCY = 8;

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

interface PreparedCandidate {
    file: string;
    vector?: number[];
    jevScore?: number;
    preview: string;
    profile: DocumentProfile;
    embeddingBackend?: EmbeddingBackend;
    cacheHit?: boolean;
}

interface EmbeddingSummary {
    sourceEmbeddingBackends: EmbeddingBackend[];
    candidateEmbeddingBackends: EmbeddingBackend[];
    cacheHitCount: number;
}

function summarizeEmbeddingBackends(
    sourceEmbeddings: Array<{ backend: EmbeddingBackend; cacheHit: boolean }>,
    candidates: PreparedCandidate[]
): EmbeddingSummary {
    const sourceEmbeddingBackends = [...new Set(sourceEmbeddings.map((entry) => entry.backend))];
    const candidateEmbeddingBackends = [...new Set(
        candidates.flatMap((entry) => entry.embeddingBackend ? [entry.embeddingBackend] : [])
    )];
    const cacheHitCount = sourceEmbeddings.filter((entry) => entry.cacheHit).length +
        candidates.filter((entry) => entry.cacheHit).length;

    return {
        sourceEmbeddingBackends,
        candidateEmbeddingBackends,
        cacheHitCount,
    };
}

function normalizeRelativePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function normalizeOptionalPaths(values?: string[]): string[] | undefined {
    return values?.map(normalizeRelativePath);
}

function getExpectedTop1(entry: BenchmarkCase): string | undefined {
    return entry.expectedTop1;
}

function getExpectedTop3(entry: BenchmarkCase): string[] {
    if (entry.expectedTop3?.length) {
        return entry.expectedTop3;
    }
    const top1 = getExpectedTop1(entry);
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
        source: normalizeRelativePath(entry.source),
        expectedTop1: entry.expectedTop1 ? normalizeRelativePath(entry.expectedTop1) : undefined,
        expectedTop3: normalizeOptionalPaths(entry.expectedTop3),
        expectedTop10Includes: normalizeOptionalPaths(entry.expectedTop10Includes),
        diffText: entry.diffText,
    }));
}

async function prepareCandidates(
    candidateFiles: string[],
    session: EmbeddingSession | undefined,
    cwd: string
): Promise<PreparedCandidate[]> {
    return mapWithConcurrency(candidateFiles, EMBED_CONCURRENCY, async (candidatePath) => {
        const candidateText = await fs.readFile(candidatePath, 'utf8');
        const candidateProfile = buildDocumentProfile(candidatePath, candidateText, cwd);
        const candidate: PreparedCandidate = {
            file: normalizeRelativePath(path.relative(cwd, candidatePath)),
            preview: candidateProfile.preview,
            profile: candidateProfile,
        };
        if (!session) {
            return candidate;
        }

        const candidateVector = await session.embed(candidateProfile.embeddingText);
        return {
            ...candidate,
            vector: candidateVector.vector,
            embeddingBackend: candidateVector.backend,
            cacheHit: candidateVector.cacheHit,
        };
    });
}

export function registerBenchmarkCommand(program: Command): void {
    program
        .command('benchmark')
        .description('Run benchmark cases against the current matcher')
        .requiredOption('--cases <file>', 'Benchmark case file')
        .option('-c, --candidates <patterns...>', 'Candidate file paths, directories, or file globs')
        .option('--include-file <patterns...>', 'Include only matching files (glob pattern)')
        .option('--exclude-file <patterns...>', 'Exclude matching files (glob pattern)')
        .option('--ranker <name>', 'embedding (local GGUF, default), jev (TypeSafe API), or heuristics')
        .option('--jev-model <id>', `TypeSafe Jev model for --ranker jev (API key from ${JEV_API_KEY_ENV})`)
        .option('--model <path>', 'Path to a local GGUF embedding model')
        .option('--cache-dir <path>', 'Directory used to cache embeddings and Jev answers')
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
            model?: string;
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
                    model: rootOptions.model,
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
                    model: options.model,
                    cacheDir: options.cacheDir,
                    threshold: options.threshold,
                    minScore: options.minScore,
                    json: options.json,
                },
                cwd
            );

            const casesPath = path.resolve(cwd, options.cases);
            const cases = await loadBenchmarkCases(casesPath);
            const candidateResult = await collectCandidateFilesDetailed(
                config.match.candidatePaths,
                config.match.includePatterns,
                config.match.excludePatterns,
                cwd
            );
            // Unlike match, a benchmark never falls back: a missing key or API failure is an error.
            const embeddingSession = config.ranker === 'embedding'
                ? new EmbeddingSession({ model: config.model, cacheDir: config.cacheDir })
                : undefined;
            const jevScorer = config.ranker === 'jev'
                ? new JevScorer({
                    apiKey: process.env[JEV_API_KEY_ENV] ?? '',
                    model: config.jevModel,
                    cacheDir: config.cacheDir,
                })
                : undefined;
            const jevStats = { requests: 0, cacheHits: 0, inputTokens: 0 };
            const preparedCandidates = await prepareCandidates(candidateResult.files, embeddingSession, cwd);

            let top1Hits = 0;
            let top1Total = 0;
            let top3Hits = 0;
            let top3Total = 0;
            let top10IncludeHits = 0;
            let top10IncludeTotal = 0;
            const misses: BenchmarkMiss[] = [];
            const sourceEmbeddings: Array<{ backend: EmbeddingBackend; cacheHit: boolean }> = [];

            for (const entry of cases) {
                const sourcePath = path.resolve(cwd, entry.source);
                const sourceText = await fs.readFile(sourcePath, 'utf8');
                const sourceProfile = buildDocumentProfile(
                    sourcePath,
                    sourceText,
                    cwd,
                    entry.diffText,
                    options.diffRoot
                );
                let sourceVector: number[] | undefined;
                if (embeddingSession) {
                    const sourceEmbedding = await embeddingSession.embed(sourceProfile.embeddingText);
                    sourceEmbeddings.push({
                        backend: sourceEmbedding.backend,
                        cacheHit: sourceEmbedding.cacheHit,
                    });
                    sourceVector = sourceEmbedding.vector;
                }

                let caseCandidates = preparedCandidates.filter(
                    (candidate) => path.resolve(cwd, candidate.file) !== sourcePath
                );
                if (jevScorer) {
                    const result = await jevScorer.score({ profile: sourceProfile, text: sourceText }, caseCandidates);
                    jevStats.requests += result.requests;
                    jevStats.cacheHits += result.cacheHits;
                    jevStats.inputTokens += result.inputTokens;
                    caseCandidates = caseCandidates.map((candidate) => ({
                        ...candidate,
                        jevScore: result.scores.get(candidate.file),
                    }));
                }

                const matches = filterMatches(
                    rankMatches({ profile: sourceProfile, vector: sourceVector }, caseCandidates),
                    config.match.minScore
                );
                const topThree = matches.slice(0, 3);
                const topTen = matches.slice(0, 10);
                const failedChecks: string[] = [];

                const expectedTop1 = getExpectedTop1(entry);
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

            await embeddingSession?.flush();
            await jevScorer?.flush();

            const embeddingSummary = summarizeEmbeddingBackends(sourceEmbeddings, preparedCandidates);
            const summary = {
                ranker: config.ranker,
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
                ...embeddingSummary,
                jev: jevScorer ? jevStats : undefined,
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
            console.log(`sourceEmbeddingBackends: ${summary.sourceEmbeddingBackends.join(', ') || 'none'}`);
            console.log(`candidateEmbeddingBackends: ${summary.candidateEmbeddingBackends.join(', ') || 'none'}`);
            console.log(`cacheHitCount: ${summary.cacheHitCount}`);
            if (summary.jev) {
                console.log(`jevRequests: ${summary.jev.requests}`);
                console.log(`jevCacheHits: ${summary.jev.cacheHits}`);
                console.log(`jevInputTokens: ${summary.jev.inputTokens}`);
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
