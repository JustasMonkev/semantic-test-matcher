import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectCandidateFilesDetailed, MAX_CANDIDATE_FILES } from '../utils/files.ts';
import { parseStdinList, readStdinText } from '../utils/io.ts';
import { mapWithConcurrency } from '../utils/concurrency.ts';
import { createProgressReporter } from '../utils/progress.ts';
import { resolveConfig } from '../config.ts';
import { EmbeddingSession, resolveEmbedConcurrency } from '../services/embeddings.ts';
import type { EmbeddingResult } from '../services/embedding-types.ts';
import { rankMatches, type RankedMatchCandidate } from '../services/match.ts';
import { buildDocumentProfile } from '../services/document-profile.ts';

async function readRequiredFile(filePath: string, label: string): Promise<string> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`${label} not found: ${filePath}`);
        }
        throw error;
    }
}

export function registerMatchCommand(program: Command): void {
    program
        .command('match')
        .description('Match code change to test cases')
        .argument('<file>', 'Changed file path')
        .option('-t, --threshold <number>', 'Minimum similarity threshold')
        .option('--min-score <number>', 'Minimum similarity score override')
        .option('--top-k <number>', 'Keep only top K matches')
        .option('-c, --candidates <patterns...>', 'Candidate file paths, directories, or file globs')
        .option('--include-file <patterns...>', 'Include only matching files (glob pattern)')
        .option('--exclude-file <patterns...>', 'Exclude matching files (glob pattern)')
        .option('--candidates-from-stdin', 'Read candidate file list (JSON array or newline list) from stdin')
        .option('--provider <provider>', 'Embedding provider: hf or ollama')
        .option('--model <model>', 'Embedding model for selected provider')
        .option('--cache-dir <path>', 'Directory used to cache embeddings')
        .option('--diff-file <path>', 'Unified diff file used to enrich change-aware matching')
        .option('--json', 'Print machine-readable output')
        .action(async (
            file: string,
            options: {
                threshold?: string;
                minScore?: string;
                topK?: string;
                candidates?: string[];
                includeFile?: string[];
                excludeFile?: string[];
                provider?: string;
                model?: string;
                cacheDir?: string;
                diffFile?: string;
                json?: boolean;
                candidatesFromStdin?: boolean;
            }
        ) => {
            const rootOptions = program.opts();
            const candidatesFromStdin = options.candidatesFromStdin
                ? parseStdinList(await readStdinText())
                : undefined;
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
                    threshold: options.threshold,
                    minScore: options.minScore,
                    topK: options.topK,
                    candidates: options.candidates?.length ? options.candidates : candidatesFromStdin,
                    includeFile: options.includeFile,
                    excludeFile: options.excludeFile,
                    provider: options.provider,
                    model: options.model,
                    cacheDir: options.cacheDir,
                    json: options.json,
                },
            );

            const startedAt = Date.now();
            const changedPath = path.resolve(process.cwd(), file);
            const diffPath = options.diffFile ? path.resolve(process.cwd(), options.diffFile) : undefined;
            const [changedText, diffText] = await Promise.all([
                readRequiredFile(changedPath, 'Changed file'),
                diffPath ? readRequiredFile(diffPath, 'Diff file') : Promise.resolve(undefined),
            ]);
            const sourceProfile = buildDocumentProfile(changedPath, changedText, process.cwd(), diffText);

            const session = new EmbeddingSession({
                provider: config.provider,
                model: config.model,
                cacheDir: config.cacheDir,
                ollamaHost: config.ollamaHost,
            });

            const candidateResult = await collectCandidateFilesDetailed(
                config.match.candidatePaths,
                config.match.includePatterns,
                config.match.excludePatterns,
                process.cwd()
            );
            const candidateFiles = candidateResult.files.filter(
                (candidatePath) => path.resolve(candidatePath) !== changedPath
            );

            if (!candidateFiles.length && !options.json && !config.quiet) {
                console.log(`No candidate files found in: ${config.match.candidatePaths.join(', ')}`);
                console.log('Pass --candidates <paths...> or set match.candidatePaths in the config file.');
            }

            const showProgress = !options.json && !config.quiet;
            const progress = createProgressReporter('Embedding candidates', candidateFiles.length + 1, showProgress);
            let sourceEmbedding: EmbeddingResult;
            let ranked: RankedMatchCandidate[];
            try {
                sourceEmbedding = await session.embed(sourceProfile.embeddingText);
                progress.tick();

                ranked = await mapWithConcurrency(
                    candidateFiles,
                    resolveEmbedConcurrency(config.provider),
                    async (candidatePath) => {
                        const candidateText = await fs.readFile(candidatePath, 'utf8');
                        const candidateProfile = buildDocumentProfile(candidatePath, candidateText, process.cwd());
                        const candidateEmbedding = await session.embed(candidateProfile.embeddingText);
                        progress.tick();

                        return {
                            file: path.relative(process.cwd(), candidatePath),
                            vector: candidateEmbedding.vector,
                            preview: candidateProfile.preview,
                            profile: candidateProfile,
                            embeddingBackend: candidateEmbedding.backend,
                            cacheHit: candidateEmbedding.cacheHit,
                            fallbackReason: candidateEmbedding.fallbackReason,
                        };
                    }
                );
            } finally {
                progress.done();
                await session.flush();
            }

            const matches = rankMatches(
                { profile: sourceProfile, vector: sourceEmbedding.vector },
                ranked
            );
            const filtered = matches.filter((entry) => entry.score >= config.match.minScore);
            const topMatches = filtered.slice(0, config.match.topK);
            const cacheEntries = await session.cacheEntryCount();
            const elapsedMs = Date.now() - startedAt;
            const candidateBackends = [...new Set(ranked.map((entry) => entry.embeddingBackend).filter(Boolean))];
            const candidateFallbackCount = ranked.filter((entry) => Boolean(entry.fallbackReason)).length;

            if (options.json) {
                console.log(
                    JSON.stringify({
                        file: path.relative(process.cwd(), changedPath),
                        provider: config.provider,
                        model: config.model,
                        matched: topMatches.length,
                        threshold: config.match.threshold,
                        minScore: config.match.minScore,
                        topK: config.match.topK,
                        source: sourceProfile.preview,
                        sourceEmbedding: {
                            backend: sourceEmbedding.backend,
                            cacheHit: sourceEmbedding.cacheHit,
                            fallbackReason: sourceEmbedding.fallbackReason,
                        },
                        candidateEmbeddingBackends: candidateBackends,
                        candidateFallbackCount,
                        cacheEntries,
                        candidateLimitReached: candidateResult.truncated,
                        elapsedMs,
                        results: topMatches,
                    })
                );
                return;
            }

            if (!config.quiet) {
                const cacheHits = ranked.filter((entry) => entry.cacheHit).length + (sourceEmbedding.cacheHit ? 1 : 0);
                console.log(
                    `Matched ${topMatches.length}/${matches.length} candidates for ${path.relative(process.cwd(), changedPath)} ` +
                    `in ${(elapsedMs / 1000).toFixed(1)}s (${cacheHits}/${ranked.length + 1} embeddings cached)`
                );
                if (config.provider === 'ollama' || sourceEmbedding.backend !== 'hf' || candidateFallbackCount > 0) {
                    console.log(`Source embedding backend: ${sourceEmbedding.backend}${sourceEmbedding.cacheHit ? ' (cache)' : ''}`);
                    if (sourceEmbedding.fallbackReason) {
                        console.log(`Source fallback: ${sourceEmbedding.fallbackReason}`);
                    }
                    if (candidateBackends.length) {
                        console.log(`Candidate embedding backends: ${candidateBackends.join(', ')}${candidateFallbackCount ? `; fallbacks: ${candidateFallbackCount}` : ''}`);
                    }
                }
                if (candidateResult.truncated) {
                    console.log(`Candidate scan truncated at ${MAX_CANDIDATE_FILES} files`);
                }
            }

            if (!topMatches.length) {
                if (!config.quiet) {
                    console.log(`No matches reached minimum score ${config.match.minScore}`);
                }
                return;
            }

            for (const match of topMatches) {
                console.log(`${match.score.toFixed(4)} ${match.file}`);
                if (!config.quiet && match.preview) {
                    console.log(`  ${match.preview}`);
                }
            }
        });
}
