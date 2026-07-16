# Architecture overview

## Purpose and shape

`semantic-test-matcher` is a single-process Node.js CLI. It converts a changed JS/TS file and possible test candidates into bounded document profiles, embeds those profiles with a local GGUF model, and ranks candidates with a structural-heavy hybrid score. There is no server, database, cloud API, or long-running daemon (`src/cli.ts`, `src/commands/match.ts`).

```text
CLI / Commander
  -> command handler
     -> configuration resolver
     -> file and stdin utilities
     -> DocumentProfile builder
     -> EmbeddingSession
        -> disk cache
        -> node-llama-cpp provider on cache miss
     -> ranking engine
     -> human or JSON output
```

## Runtime layers

### Entry and command layer

`src/cli.ts` constructs Commander, defines global options, registers commands through `src/commands/index.ts`, and owns top-level error presentation. `RBT_DEBUG=1` changes uncaught errors from a concise message to a stack trace (`src/utils/io.ts`).

The command files are orchestration boundaries:

- `match.ts`: changed file to ranked candidates.
- `benchmark.ts`: repeated ranking against expected outcomes.
- `embed.ts`: raw embedding utility.
- `status.ts`: resolved config and cache count without loading a model.
- `completion.ts`: basic Bash/Zsh command-name completion.

Keep business scoring out of command handlers; commands should compose services and serialize results.

### Configuration boundary

`src/config.ts` merges command options, global options, environment variables, a JSON config, and defaults. It resolves model/cache paths against the working directory and clamps numeric matching settings. Auto-discovered `.rbt/config.json` or `.rbtconfig` files cannot point model, cache, or candidates outside the workspace; explicit config, CLI, and environment overrides are treated as trusted inputs.

A notable semantic: `threshold` is used as the fallback for `minScore`. Filtering itself receives `minScore` (`src/config.ts`, `src/services/match.ts`).

### Candidate and input utilities

`src/utils/files.ts` walks configured seeds, applies the custom glob matcher in `src/utils/patterns.ts`, excludes common generated/hidden directories, accepts JS/TS-family extensions, deduplicates paths, and stops at 1,000 candidates. `src/utils/io.ts` handles text and JSON/newline stdin; `src/utils/async.ts` preserves input order while limiting concurrent work.

### Profiling and ranking domain

`src/services/document-profile.ts` is the feature-extraction boundary. It derives path/stem tokens, exports/imports, test names, CLI interfaces, phrase and rare-anchor signals, and optional net change signals from a unified diff. Profiles are bounded before embedding.

`src/services/match.ts` compares a source profile to candidates. The final score is 20% normalized embedding cosine and 80% normalized structural score. See [Ranking model](../domain/ranking-model.md) for the feature semantics and weights.

### Local embeddings and cache

`src/services/embedding-provider.ts` lazily loads one local GGUF through `node-llama-cpp`, creates an embedding context capped at 2,048 tokens, prefixes the sentence-similarity task, and truncates input to fit. `RBT_EMBEDDING_TEST_MODE=stub` replaces native inference with the deterministic vectorizer in `text-utils.ts`.

`EmbeddingSession` (`src/services/embeddings.ts`) reads the cache once, buffers misses, lazily creates the provider only if needed, and flushes in one batch. `src/services/cache.ts` protects writes with an exclusive lock and atomically renames a temporary file. Cache failures are best-effort and visible only in debug mode.

## Match data flow

1. Resolve configuration and working-directory-relative paths.
2. Read the changed file and optional unified diff in parallel.
3. Build the source profile and request its embedding.
4. Discover candidates; exclude the source file itself.
5. With concurrency 8, read each candidate, profile it, and embed it through the shared session.
6. Flush pending cache entries.
7. Compute score components, sort by descending score, then filename for ties.
8. Filter by inclusive `minScore`, slice to `topK`, and serialize.

Candidate reading/inference failure aborts the command. Cache persistence failure does not.

## Design evolution

Recent history explains current boundaries:

- The original CLI evolved into tested service/util layers; the reliability pass added bounded concurrency, batched cache writes, validation, and broad unit coverage.
- Embeddings moved from Hugging Face/Ollama alternatives to one in-process `node-llama-cpp` backend. This removed network/daemon behavior and made a local GGUF path part of runtime identity.
- npm-release work made `dist/cli.js` the published `rbt` executable and derives the CLI version from `package.json`.
- Matcher defaults were reset to zero threshold/minimum score so default use returns ranked evidence rather than silently dropping weaker results.
- The current branch added change-aware ranking, then iterated on false positives, bounded profile budgets, and unified-diff path/hunk edge cases. Those fixes are concentrated in `document-profile.ts`, `text-utils.ts`, and `match.ts` and should be changed together with their tests.

## Architectural constraints and extension points

- **Local-only inference:** adding a remote provider would affect config, provider/result types, cache identity, status output, and tests—not just `embedding-provider.ts`.
- **Regex profiling:** source extraction is intentionally lightweight but does not fully understand TypeScript syntax. AST adoption would be a domain-model change.
- **Benchmark-shaped heuristics:** rare anchors and special path/interface boosts encode Playwright/MCP/codegen/test-ID scenarios. Treat them as product policy until tests and benchmark evidence justify generalization.
- **Profile/cache versioning:** cache keys include backend, model path, and normalized embedding text. There is no explicit profile algorithm or model-file-content version, so behavior changes can leave reusable but semantically old entries.
- **CLI as integration surface:** JSON output from `match`, `benchmark`, `embed`, and `status` is the practical automation API, although no formal schema/version is declared.

## Where to start changing code

- Command/flag/output change: `src/commands/*`, then CLI subprocess coverage (currently missing).
- Config/default/security change: `src/config.ts` + `tests/config.test.ts`.
- Candidate scope/glob change: `src/utils/files.ts`, `patterns.ts` + corresponding tests.
- Feature extraction/diff change: `document-profile.ts`, `text-utils.ts` + profile/token tests.
- Weight/order change: `match.ts` + ordering regressions and benchmark cases.
- Model/cache change: embedding and cache services + both service test suites.
