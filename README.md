# cli-ai-tool

`cli-ai-tool` is a TypeScript CLI for semantic test matching. It exposes the `rbt` command, which can embed free-form text, inspect resolved runtime configuration, print shell completion scripts, and rank likely test files for a changed source file.

The matching flow combines:

- document profiling from file paths and code structure
- embeddings from Hugging Face or Ollama
- a local embedding cache
- score blending for semantic and structural signals

## Features

- `rbt match <file>` ranks candidate tests for a changed file
- `rbt embed [text]` generates an embedding for text or stdin
- `rbt status` shows the resolved runtime configuration
- `rbt completion [bash|zsh]` prints a shell completion script
- supports `hf` and `ollama` embedding providers
- caches embeddings in `.rbt/cache` by default
- accepts candidate file lists from CLI flags, config, or stdin

## Architecture

```mermaid
flowchart TD
    A["CLI entry<br/>src/cli.ts"] --> B["Commander program<br/>global options + subcommands"]
    B --> C["Command layer<br/>embed / match / status / completion"]

    C --> D["Config resolution<br/>src/config.ts"]
    D --> D1["Sources<br/>CLI flags -> env vars -> config file -> defaults"]

    C --> E["Input handling"]
    E --> E1["Changed file / text / stdin"]
    E --> E2["Candidate discovery<br/>src/utils/files.ts"]

    E1 --> F["Document profiling<br/>src/services/document-profile.ts"]
    E2 --> F2["Candidate profiles"]

    F --> G["Embedding service<br/>src/services/embeddings.ts"]
    F2 --> G

    G --> H["Cache layer<br/>src/services/cache.ts"]
    G --> I["Provider factory<br/>src/services/embedding-provider.ts"]
    I --> I1["Hugging Face transformers"]
    I --> I2["Ollama embeddings"]
    I2 --> I3["Fallback digest / local vectorizer"]

    G --> J["Vectors"]
    J --> K["Ranking engine<br/>src/services/match.ts"]
    F --> K
    F2 --> K

    K --> L["Scoring blend"]
    L --> L1["Embedding similarity"]
    L --> L2["Basename overlap"]
    L --> L3["Semantic token overlap"]
    L --> L4["Export/import/test anchor overlap"]

    C --> M["Output"]
    K --> M
    D --> M
    M --> M1["Human-readable CLI output"]
    M --> M2["JSON output for automation"]
```

## Install

```bash
npm install
npm run build
```

Run the compiled CLI:

```bash
node dist/cli.js --help
```

Run in development mode:

```bash
npm run dev -- --help
```

If you want the `rbt` binary directly, install the package in a way that exposes the `bin` entry from `package.json`.

## Quick Start

Generate an embedding:

```bash
node dist/cli.js embed "discount and tax edge cases" --json
```

Match a changed file to likely tests:

```bash
node dist/cli.js match prompts-idea/src/price-engine.ts --candidates prompts-idea/tests --json
```

Inspect resolved settings:

```bash
node dist/cli.js status --json
```

Print shell completion:

```bash
node dist/cli.js completion zsh
```

## Commands

### `embed`

Embeds the provided text or stdin input.

Examples:

```bash
node dist/cli.js embed "checkout pricing logic"
printf "coupon validation" | node dist/cli.js embed --json
```

Useful flags:

- `--provider <hf|ollama>`
- `--model <model>`
- `--cache-dir <path>`
- `--json`

### `match`

Ranks likely candidate files for a changed source file.

Examples:

```bash
node dist/cli.js match prompts-idea/src/price-engine.ts --candidates prompts-idea/tests

cat prompts-idea/candidate-list.txt | \
  node dist/cli.js match prompts-idea/src/price-engine.ts \
    --candidates-from-stdin \
    --top-k 4 \
    --threshold 0.35 \
    --json
```

Useful flags:

- `--threshold <number>`
- `--min-score <number>`
- `--top-k <number>`
- `--candidates <paths...>`
- `--include-file <glob...>`
- `--exclude-file <glob...>`
- `--candidates-from-stdin`
- `--provider <hf|ollama>`
- `--model <model>`
- `--cache-dir <path>`
- `--json`

How matching works:

1. The changed file is read and converted into a `DocumentProfile`.
2. Candidate files are collected from configured paths or stdin.
3. Each profile is embedded with the selected provider.
4. `rankMatches` blends embedding similarity with structural overlap.
5. Results are filtered by threshold and truncated to `topK`.

### `status`

Prints the resolved runtime configuration and cache stats.

```bash
node dist/cli.js status
node dist/cli.js status --json
```

### `completion`

Prints a bash or zsh completion script.

```bash
node dist/cli.js completion bash
node dist/cli.js completion zsh
```

## Configuration

The CLI resolves settings in this order:

1. command flags
2. environment variables
3. config file
4. built-in defaults

Config files are loaded from:

- `--config <path>` if provided
- `.rbt/config.json`
- `.rbtconfig`

Example config:

```json
{
  "provider": "hf",
  "model": "Xenova/all-MiniLM-L6-v2",
  "ollamaHost": "http://127.0.0.1:11434",
  "cacheDir": ".rbt/cache",
  "logLevel": "info",
  "match": {
    "topK": 5,
    "threshold": 0.45,
    "minScore": 0.45,
    "candidatePaths": ["test", "tests"],
    "includePatterns": ["**/*"],
    "excludePatterns": [
      "**/dist/**",
      "**/.git/**",
      "**/node_modules/**",
      "**/build/**"
    ]
  }
}
```

Environment variables used by the resolver include:

- `RBT_PROVIDER`
- `RBT_MODEL`
- `RBT_CACHE_DIR`
- `RBT_LOG_LEVEL`
- `RBT_VERBOSE`
- `RBT_QUIET`
- `RBT_TOP_K`
- `RBT_MATCH_TOP_K`
- `RBT_THRESHOLD`
- `RBT_MATCH_THRESHOLD`
- `RBT_MIN_SCORE`
- `RBT_MATCH_MIN_SCORE`
- `OLLAMA_HOST`
- `OLLAMA_MODEL`
- `RBT_OLLAMA_MODEL`

## Providers and Caching

### Hugging Face

- default provider
- uses `@huggingface/transformers`
- the first run may download model assets, depending on the selected model and local cache state

### Ollama

- uses the configured `OLLAMA_HOST` or `ollamaHost`
- prefers `/api/embeddings`
- falls back to an Ollama-generated semantic digest and then to a local text vectorizer if needed

### Cache

- embeddings are cached under `.rbt/cache` by default
- cache writes are best-effort and do not fail the command if they break
- `status` reports the current cache entry count

## Repo Layout

```text
src/
  cli.ts                CLI entrypoint
  commands/             Commander subcommands
  services/             embeddings, ranking, document profiling, cache
  utils/                candidate collection, stdin helpers, glob matching
prompts-idea/
  src/                  synthetic source files for matching experiments
  tests/                synthetic tests used as candidates
  candidate-list.txt    sample stdin input for --candidates-from-stdin
  README.md             dataset-specific usage notes
```

## Sample Dataset: `prompts-idea/`

`prompts-idea/` is a small synthetic workspace for exercising the matcher. It includes source files, related and unrelated tests, and a candidate list file for stdin-driven matching flows.

Useful commands:

```bash
npm test

node dist/cli.js match prompts-idea/src/price-engine.ts \
  --candidates prompts-idea/tests \
  --json

cat prompts-idea/candidate-list.txt | \
  node dist/cli.js match prompts-idea/src/price-engine.ts \
    --candidates-from-stdin \
    --json
```

For dataset-specific notes, see [prompts-idea/README.md](./prompts-idea/README.md).

## Development

```bash
npm run lint
npm test
npm run build
```

The repo currently uses `node:test` for tests and TypeScript for type-checking and build output.
