import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectCandidateFilesDetailed, MAX_CANDIDATE_FILES } from '../utils/files.ts';
import { parseStdinList, readStdinText } from '../utils/io.ts';
import { mapWithConcurrency } from '../utils/async.ts';
import { resolveConfig } from '../config.ts';
import { EmbeddingSession, getCacheEntryCount } from '../services/embeddings.ts';
import { filterMatches, rankMatches, type RankedMatchCandidate } from '../services/match.ts';
import { buildDocumentProfile } from '../services/document-profile.ts';

const EMBED_CONCURRENCY = 8;

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
        .option('--model <path>', 'Path to a local GGUF embedding model')
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
            const sourceProfile = buildDocumentProfile(changedPath, changedText, process.cwd(), diffText);

            const embeddingSession = new EmbeddingSession({
                model: config.model,
                cacheDir: config.cacheDir,
            });

            const sourceEmbedding = await embeddingSession.embed(sourceProfile.embeddingText);

            const candidateResult = await collectCandidateFilesDetailed(
                config.match.candidatePaths,
                config.match.includePatterns,
                config.match.excludePatterns,
                process.cwd()
            );
            const candidateFiles = candidateResult.files.filter(
                (candidatePath) => path.resolve(candidatePath) !== changedPath
            );

            const ranked: RankedMatchCandidate[] = await mapWithConcurrency(
                candidateFiles,
                EMBED_CONCURRENCY,
                async (candidatePath) => {
                    const candidateText = await fs.readFile(candidatePath, 'utf8');
                    const candidateProfile = buildDocumentProfile(candidatePath, candidateText, process.cwd());
                    const candidateEmbedding = await embeddingSession.embed(candidateProfile.embeddingText);

                    return {
                        file: path.relative(process.cwd(), candidatePath),
                        vector: candidateEmbedding.vector,
                        preview: candidateProfile.preview,
                        profile: candidateProfile,
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
                    `Matched ${topMatches.length}/${matches.length} candidates for ${path.relative(process.cwd(), changedPath)}`
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
