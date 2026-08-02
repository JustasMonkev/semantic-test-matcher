import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectCandidateFilesDetailed, MAX_CANDIDATE_FILES } from '../utils/files.ts';
import { parseStdinList, readStdinText } from '../utils/io.ts';
import { mapWithConcurrency } from '../utils/async.ts';
import { resolveConfig } from '../config.ts';
import { EmbeddingSession, getCacheEntryCount } from '../services/embeddings.ts';
import { filterMatches, rankMatches, selectRerankCandidates, type RankedMatchCandidate } from '../services/match.ts';
import { buildDocumentProfile } from '../services/document-profile.ts';

const EMBED_CONCURRENCY = 8;
const PROFILE_CONCURRENCY = 16;

export function registerMatchCommand(program: Command): void {
    program
        .command('match')
        .description('Match code change to test cases')
        .argument('<file>', 'Changed file path')
        .option('-t, --threshold <number>', 'Minimum similarity threshold')
        .option('--min-score <number>', 'Minimum similarity score override')
        .option('--top-k <number>', 'Keep only top K matches')
        .option('--rerank-depth <number>', 'Embed only the top N structural candidates (0 embeds all)')
        .option('-c, --candidates <patterns...>', 'Candidate file paths, directories, or file globs')
        .option('--include-file <patterns...>', 'Include only matching files (glob pattern)')
        .option('--exclude-file <patterns...>', 'Exclude matching files (glob pattern)')
        .option('--candidates-from-stdin', 'Read candidate file list (JSON array or newline list) from stdin')
        .option('--model <path>', 'Path to a local GGUF embedding model')
        .option('--cache-dir <path>', 'Directory used to cache embeddings')
        .option('--diff-file <path>', 'Unified diff file used to enrich change-aware matching')
        .option('--diff-root <path>', 'Base directory for relative paths in --diff-file')
        .option('--json', 'Print machine-readable output')
        .action(async (
            file: string,
            options: {
                threshold?: string;
                minScore?: string;
                topK?: string;
                rerankDepth?: string;
                candidates?: string[];
                includeFile?: string[];
                excludeFile?: string[];
                model?: string;
                cacheDir?: string;
                diffFile?: string;
                diffRoot?: string;
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
                    rerankDepth: options.rerankDepth,
                    candidates: options.candidates?.length ? options.candidates : candidatesFromStdin,
                    includeFile: options.includeFile,
                    excludeFile: options.excludeFile,
                    model: options.model,
                    cacheDir: options.cacheDir,
                    json: options.json,
                },
            );

            const changedPath = path.resolve(process.cwd(), file);
            const diffPath = options.diffFile ? path.resolve(process.cwd(), options.diffFile) : undefined;
            const [changedText, diffText] = await Promise.all([
                fs.readFile(changedPath, 'utf8'),
                diffPath ? fs.readFile(diffPath, 'utf8') : Promise.resolve(undefined),
            ]);
            const sourceProfile = buildDocumentProfile(
                changedPath,
                changedText,
                process.cwd(),
                diffText,
                options.diffRoot
            );

            const embeddingSession = new EmbeddingSession({
                model: config.model,
                cacheDir: config.cacheDir,
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

            // Stage 1: profile every candidate. This is file I/O and string work only.
            const profiled = await mapWithConcurrency(
                candidateFiles,
                PROFILE_CONCURRENCY,
                async (candidatePath) => {
                    const candidateText = await fs.readFile(candidatePath, 'utf8');

                    return {
                        file: path.relative(process.cwd(), candidatePath),
                        profile: buildDocumentProfile(candidatePath, candidateText, process.cwd()),
                    };
                }
            );

            // Stage 2: embed only the structurally strongest candidates.
            const shortlist = selectRerankCandidates(sourceProfile, profiled, config.match.rerankDepth);
            const sourceEmbedding = await embeddingSession.embed(sourceProfile.embeddingText);
            const ranked: RankedMatchCandidate[] = await mapWithConcurrency(
                shortlist,
                EMBED_CONCURRENCY,
                async (candidate) => {
                    const candidateEmbedding = await embeddingSession.embed(candidate.profile.embeddingText);

                    return {
                        file: candidate.file,
                        vector: candidateEmbedding.vector,
                        preview: candidate.profile.preview,
                        profile: candidate.profile,
                        embeddingBackend: candidateEmbedding.backend,
                        cacheHit: candidateEmbedding.cacheHit,
                    };
                }
            );

            await embeddingSession.flush();

            const matches = rankMatches(
                { profile: sourceProfile, vector: sourceEmbedding.vector },
                ranked
            );
            const filtered = filterMatches(matches, config.match.minScore);
            const topMatches = filtered.slice(0, config.match.topK);
            const cacheEntries = await getCacheEntryCount(config.cacheDir);
            const candidateBackends = [...new Set(ranked.map((entry) => entry.embeddingBackend).filter(Boolean))];

            if (options.json) {
                console.log(
                    JSON.stringify({
                        file: path.relative(process.cwd(), changedPath),
                        model: config.model,
                        matched: topMatches.length,
                        threshold: config.match.threshold,
                        minScore: config.match.minScore,
                        topK: config.match.topK,
                        scanned: candidateFiles.length,
                        reranked: shortlist.length,
                        rerankDepth: config.match.rerankDepth,
                        source: sourceProfile.preview,
                        sourceEmbedding: {
                            backend: sourceEmbedding.backend,
                            cacheHit: sourceEmbedding.cacheHit,
                        },
                        candidateEmbeddingBackends: candidateBackends,
                        cacheEntries,
                        candidateLimitReached: candidateResult.truncated,
                        results: topMatches,
                    })
                );
                return;
            }

            if (!config.quiet) {
                console.log(
                    `Matched ${topMatches.length}/${candidateFiles.length} candidates for ${path.relative(process.cwd(), changedPath)}`
                );
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
