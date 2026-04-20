import { Command } from 'commander';
import { createEmbedding } from '../services/embeddings.ts';
import { readStdinText } from '../utils/io.ts';
import { resolveConfig } from '../config.ts';

export function registerEmbedCommand(program: Command): void {
    program
        .command('embed')
        .description('Generate embeddings for text')
        .argument('[text]', 'Text to embed')
        .option('--provider <provider>', 'Embedding provider: hf or ollama')
        .option('--model <model>', 'Embedding model for selected provider')
        .option('--cache-dir <path>', 'Directory used to cache embeddings')
        .option('--json', 'Print machine-readable JSON output')
        .action(async (text: string, options: { provider?: string; model?: string; cacheDir?: string; json?: boolean }) => {
            const rootOptions = program.opts();
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
                    provider: options.provider,
                    model: options.model,
                    cacheDir: options.cacheDir,
                },
            );

            const finalText = (text || await readStdinText()).trim();
            if (!finalText) {
                console.error('No input text provided. Pass an argument or pipe text via stdin.');
                process.exitCode = 1;
                return;
            }

            const embedding = await createEmbedding({
                text: finalText,
                provider: config.provider,
                model: config.model,
                cacheDir: config.cacheDir,
                ollamaHost: config.ollamaHost,
            });

            if (options.json) {
                console.log(JSON.stringify({
                    provider: config.provider,
                    model: config.model,
                    backend: embedding.backend,
                    cacheHit: embedding.cacheHit,
                    fallbackReason: embedding.fallbackReason,
                    size: embedding.vector.length,
                    embedding: embedding.vector,
                }));
                return;
            }

            console.log(`Embedding backend: ${embedding.backend}${embedding.cacheHit ? ' (cache)' : ''}`);
            if (embedding.fallbackReason) {
                console.log(`Fallback reason: ${embedding.fallbackReason}`);
            }
            console.log('Embedding:', embedding.vector);
        });
}
