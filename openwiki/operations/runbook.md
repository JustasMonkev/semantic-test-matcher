# Operations runbook

## Install and build

Requirements are Node.js 20+ and native support required by `node-llama-cpp` (`package.json`).

```bash
npm install
npm run lint
npm test
npm run build
```

Build output goes from `src/` to `dist/` using `tsconfig.build.json`. The npm package publishes only `dist`; `prepack` runs the build and `rbt` maps to `dist/cli.js`.

For release verification:

```bash
npm run lint && npm test && npm run build
npm pack --dry-run
node dist/cli.js --version
node dist/cli.js status
```

The CLI version is read from `package.json`, so bump that file rather than hard-coding a CLI version.

## Model setup

The default is `models/embeddinggemma-300M-Q4_0.gguf`:

```bash
npx --yes node-llama-cpp@3.19.0 pull \
  --dir models \
  --filename embeddinggemma-300M-Q4_0.gguf \
  hf:ggml-org/embeddinggemma-300M-qat-q4_0-GGUF:Q4_0
```

Override with `--model`, `RBT_MODEL`, or config. Model existence is not checked during config resolution; load errors occur on the first cache miss. A complete cache hit may therefore avoid loading the model.

Inference is in-process and local. The provider uses an embedding context no larger than 2,048 tokens and prefixes `task: sentence similarity | query:` (`src/services/embedding-provider.ts`).

## Cache operations

Default cache file: `.rbt/cache/embeddings.json`.

A key hashes backend, resolved model path, and whitespace-normalized embedding text. The cache does not hash model contents or explicitly version the profiling algorithm.

Writes are batched and best-effort:

- an adjacent `embeddings.lock` is acquired exclusively;
- polling is every 20 ms, timeout 10 seconds;
- locks older than 30 seconds are treated as stale;
- disk contents are reloaded and merged while locked;
- a temporary file is renamed over the cache file.

Malformed JSON is treated as an empty cache. Read/write failures generally do not fail matching and are logged only with `RBT_DEBUG=1` (`src/services/cache.ts`, `src/services/embeddings.ts`).

Safe recovery for suspected corruption or stale semantics is to stop active `rbt` processes and remove the configured cache directory; embeddings will be recomputed. Do not remove a live lock while another process may be writing.

## Diagnostics

```bash
rbt status --json
RBT_DEBUG=1 rbt match src/example.ts --candidates tests --json
```

Check, in order:

1. working directory—relative model, cache, source, diff, and candidate paths depend on it;
2. resolved model/cache/candidate settings from `status --json`;
3. model file presence and native `node-llama-cpp` install health;
4. include/exclude patterns and the candidate-cap flag;
5. diff headers resolving to the same source path;
6. cache permissions/lock files;
7. component scores in JSON to separate extraction from embedding problems.

`logLevel` and `verbose` are resolved but do not currently drive most diagnostics; `RBT_DEBUG=1` is the effective low-level switch.

## Common symptoms

### No results

Defaults filter at zero, so likely causes are no candidates, restrictive include/exclude patterns, a positive `minScore`/threshold, or missing candidate roots. Remember that `minScore` is the actual filter.

### Wrong tests rank highly

Inspect `changeScore`, phrase/anchor/interface/path components, then source/candidate previews. Reproduce with deterministic stub unit tests before changing weights. A unified diff must be scoped to the source path to produce change tokens.

### Candidate scan truncated

The cap is 1,000. Narrow roots/includes. Traversal order is not guaranteed at the cap, so broad scans are not a stable benchmark corpus.

### Config appears ignored

Auto-discovery does not walk parent directories. Relative values are cwd-relative. Include CLI flags replace configured includes, while excludes merge. A misspelled explicit `--config` path currently fails open to defaults.

### Cache never grows

The command can still succeed because persistence is best-effort. Retry with `RBT_DEBUG=1`; check directory permissions, active lock ownership, and free disk space.

## Testing strategy

The project uses Node's test runner directly on TypeScript with `--experimental-strip-types`.

| Suite | Primary responsibility |
|---|---|
| `config.test.ts` | defaults, precedence, numeric normalization, patterns |
| `files.test.ts`, `patterns.test.ts`, `io.test.ts`, `async.test.ts` | utility boundaries |
| `document-profile.test.ts`, `text-utils.test.ts` | feature extraction, diff parsing, token/vector rules |
| `match.test.ts` | score invariants and ranking regressions |
| `embeddings.test.ts`, `cache.test.ts` | session/cache lifecycle |
| `benchmark.test.ts` | one benchmark command integration path |

Tests set `RBT_EMBEDDING_TEST_MODE=stub` when inference is needed. This keeps them deterministic and avoids a GGUF/native dependency, but does not prove real-model compatibility.

For ranking work, add both extraction and ordering assertions. For cache work, use temporary directories and avoid depending on the developer cache. For CLI output/config integration, add subprocess tests—the current suite has no direct coverage for `cli.ts`, `match` output, `embed`, `status`, or completion.

## Current verification status

For this PR, `git diff --check`, `npm run lint`, all 96 tests, and `npm run build` passed. Re-run the full checks after source changes and before merging or releasing.
