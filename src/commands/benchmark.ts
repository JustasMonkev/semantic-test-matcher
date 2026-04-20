import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig } from '../config.ts';
import { createEmbedding } from '../services/embeddings.ts';
import { buildDocumentProfile, type DocumentProfile } from '../services/document-profile.ts';
import type { EmbeddingBackend } from '../services/embedding-types.ts';
import { rankMatches } from '../services/match.ts';
import { collectCandidateFilesDetailed } from '../utils/files.ts';

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
    vector: number[];
    preview: string;
    profile: DocumentProfile;
    embeddingBackend: EmbeddingBackend;
    cacheHit: boolean;
    fallbackReason?: string;
}

interface EmbeddingSummary {
    sourceEmbeddingBackends: EmbeddingBackend[];
    candidateEmbeddingBackends: EmbeddingBackend[];
    fallbackCount: number;
    cacheHitCount: number;
}

function summarizeEmbeddingBackends(
    sourceEmbeddings: Array<{ backend: EmbeddingBackend; cacheHit: boolean; fallbackReason?: string }>,
    candidates: PreparedCandidate[]
): EmbeddingSummary {
    const sourceEmbeddingBackends = [...new Set(sourceEmbeddings.map((entry) => entry.backend))];
    const candidateEmbeddingBackends = [...new Set(candidates.map((entry) => entry.embeddingBackend))];
    const fallbackCount = sourceEmbeddings.filter((entry) => Boolean(entry.fallbackReason)).length +
        candidates.filter((entry) => Boolean(entry.fallbackReason)).length;
    const cacheHitCount = sourceEmbeddings.filter((entry) => entry.cacheHit).length +
        candidates.filter((entry) => entry.cacheHit).length;

    return {
        sourceEmbeddingBackends,
        candidateEmbeddingBackends,
        fallbackCount,
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
    return entry.expectedTop1 ?? entry.expectedTop3?.[0];
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
    config: Awaited<ReturnType<typeof resolveConfig>>,
    cwd: string
): Promise<PreparedCandidate[]> {
    const prepared: PreparedCandidate[] = [];

    for (const candidatePath of candidateFiles) {
        const candidateText = await fs.readFile(candidatePath, 'utf8');
        const candidateProfile = buildDocumentProfile(candidatePath, candidateText, cwd);
        const candidateVector = await createEmbedding({
            text: candidateProfile.embeddingText,
            provider: config.provider,
            model: config.model,
            cacheDir: config.cacheDir,
            ollamaHost: config.ollamaHost,
        });

        prepared.push({
            file: normalizeRelativePath(path.relative(cwd, candidatePath)),
            vector: candidateVector.vector,
            preview: candidateProfile.preview,
            profile: candidateProfile,
            embeddingBackend: candidateVector.backend,
            cacheHit: candidateVector.cacheHit,
            fallbackReason: candidateVector.fallbackReason,
        });
    }

    return prepared;
}

export function registerBenchmarkCommand(program: Command): void {
    program
        .command('benchmark')
        .description('Run benchmark cases against the current matcher')
        .requiredOption('--cases <file>', 'Benchmark case file')
        .option('-c, --candidates <patterns...>', 'Candidate file paths, directories, or file globs')
        .option('--include-file <patterns...>', 'Include only matching files (glob pattern)')
        .option('--exclude-file <patterns...>', 'Exclude matching files (glob pattern)')
        .option('--provider <provider>', 'Embedding provider: hf or ollama')
        .option('--model <model>', 'Embedding model for selected provider')
        .option('--cache-dir <path>', 'Directory used to cache embeddings')
        .option('--json', 'Print machine-readable output')
        .action(async (options: {
            cases: string;
            candidates?: string[];
            includeFile?: string[];
            excludeFile?: string[];
            provider?: string;
            model?: string;
            cacheDir?: string;
            json?: boolean;
        }) => {
            const rootOptions = program.opts();
            const cwd = process.cwd();
            const config = await resolveConfig(
                {
                    config: rootOptions.config,
                    provider: rootOptions.provider,
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
                    provider: options.provider,
                    model: options.model,
                    cacheDir: options.cacheDir,
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
            const preparedCandidates = await prepareCandidates(candidateResult.files, config, cwd);

            let top1Hits = 0;
            let top1Total = 0;
            let top3Hits = 0;
            let top3Total = 0;
            let top10IncludeHits = 0;
            let top10IncludeTotal = 0;
            const misses: BenchmarkMiss[] = [];
            const sourceEmbeddings: Array<{ backend: EmbeddingBackend; cacheHit: boolean; fallbackReason?: string }> = [];

            for (const entry of cases) {
                const sourcePath = path.resolve(cwd, entry.source);
                const sourceText = await fs.readFile(sourcePath, 'utf8');
                const sourceProfile = buildDocumentProfile(sourcePath, sourceText, cwd, entry.diffText);
                const sourceVector = await createEmbedding({
                    text: sourceProfile.embeddingText,
                    provider: config.provider,
                    model: config.model,
                    cacheDir: config.cacheDir,
                    ollamaHost: config.ollamaHost,
                });
                sourceEmbeddings.push({
                    backend: sourceVector.backend,
                    cacheHit: sourceVector.cacheHit,
                    fallbackReason: sourceVector.fallbackReason,
                });

                const matches = rankMatches(
                    { profile: sourceProfile, vector: sourceVector.vector },
                    preparedCandidates.filter((candidate) => path.resolve(cwd, candidate.file) !== sourcePath)
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

            const embeddingSummary = summarizeEmbeddingBackends(sourceEmbeddings, preparedCandidates);
            const summary = {
                cases: cases.length,
                top1Rate: top1Total ? top1Hits / top1Total : 0,
                top3Rate: top3Total ? top3Hits / top3Total : 0,
                top10IncludeRate: top10IncludeTotal ? top10IncludeHits / top10IncludeTotal : 0,
                misses,
                candidateLimitReached: candidateResult.truncated,
                ...embeddingSummary,
            };

            if (options.json) {
                console.log(JSON.stringify(summary));
                return;
            }

            console.log(`cases: ${summary.cases}`);
            console.log(`top1Rate: ${summary.top1Rate.toFixed(4)}`);
            console.log(`top3Rate: ${summary.top3Rate.toFixed(4)}`);
            console.log(`top10IncludeRate: ${summary.top10IncludeRate.toFixed(4)}`);
            console.log(`candidateLimitReached: ${summary.candidateLimitReached}`);
            console.log(`sourceEmbeddingBackends: ${summary.sourceEmbeddingBackends.join(', ') || 'none'}`);
            console.log(`candidateEmbeddingBackends: ${summary.candidateEmbeddingBackends.join(', ') || 'none'}`);
            console.log(`fallbackCount: ${summary.fallbackCount}`);
            console.log(`cacheHitCount: ${summary.cacheHitCount}`);
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
