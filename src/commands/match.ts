import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectCandidateFilesDetailed, MAX_CANDIDATE_FILES } from '../utils/files.ts';
import { readStdinText } from '../utils/io.ts';
import { resolveConfig } from '../config.ts';
import { createEmbedding, getCacheEntryCount } from '../services/embeddings.ts';
import { rankMatches } from '../services/match.ts';
import { buildDocumentProfile, type DocumentProfile } from '../services/document-profile.ts';
import type { EmbeddingBackend } from '../services/embedding-types.ts';

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
            let candidatesFromStdin: string[] | undefined;
            if (options.candidatesFromStdin) {
                const stdinText = await readStdinText();
                if (stdinText) {
                    try {
                        const parsed = JSON.parse(stdinText);
                        if (Array.isArray(parsed)) {
                            candidatesFromStdin = parsed.map((value) => String(value).trim()).filter(Boolean);
                        } else {
                            candidatesFromStdin = stdinText.split('\n').map((line) => line.trim()).filter(Boolean);
                        }
                    } catch {
                        candidatesFromStdin = stdinText.split('\n').map((line) => line.trim()).filter(Boolean);
                    }
                }
            }
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

            const changedPath = path.resolve(process.cwd(), file);
            const changedText = await fs.readFile(changedPath, 'utf8');
            const diffText = options.diffFile
                ? await fs.readFile(path.resolve(process.cwd(), options.diffFile), 'utf8')
                : undefined;
            const sourceProfile = buildDocumentProfile(changedPath, changedText, process.cwd(), diffText);

            const sourceEmbedding = await createEmbedding({
                text: sourceProfile.embeddingText,
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
            const candidateFiles = candidateResult.files;

            const ranked: Array<{
                file: string;
                vector: number[];
                preview: string;
                profile: DocumentProfile;
                embeddingBackend?: EmbeddingBackend;
                cacheHit?: boolean;
                fallbackReason?: string;
            }> = [];
            for (const candidatePath of candidateFiles) {
                if (path.resolve(candidatePath) === changedPath) {
                    continue;
                }

                const candidateText = await fs.readFile(candidatePath, 'utf8');
                const candidateProfile = buildDocumentProfile(candidatePath, candidateText, process.cwd());
                const candidateEmbedding = await createEmbedding({
                    text: candidateProfile.embeddingText,
                    provider: config.provider,
                    model: config.model,
                    cacheDir: config.cacheDir,
                    ollamaHost: config.ollamaHost,
                });

                ranked.push({
                    file: path.relative(process.cwd(), candidatePath),
                    vector: candidateEmbedding.vector,
                    preview: candidateProfile.preview,
                    profile: candidateProfile,
                    embeddingBackend: candidateEmbedding.backend,
                    cacheHit: candidateEmbedding.cacheHit,
                    fallbackReason: candidateEmbedding.fallbackReason,
                });
            }

            const matches = rankMatches(
                { profile: sourceProfile, vector: sourceEmbedding.vector },
                ranked
            );
            const filtered = matches.filter((entry) => entry.score >= config.match.minScore);
            const topMatches = filtered.slice(0, config.match.topK);
            const cacheEntries = await getCacheEntryCount(config.cacheDir);
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
                        results: topMatches,
                    })
                );
                return;
            }

            if (!config.quiet) {
                console.log(
                    `Matched ${topMatches.length}/${matches.length} candidates for ${path.relative(process.cwd(), changedPath)}`
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
