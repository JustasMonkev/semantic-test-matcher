# semantic-test-matcher: engineer quickstart

`semantic-test-matcher` is a TypeScript CLI published as `rbt`. Given a changed JavaScript/TypeScript file, it ranks likely test files by combining local GGUF embeddings with path, symbol, test-name, interface, phrase, and optional unified-diff signals. Inference and caching are local; there is no cloud or daemon integration (`README.md`, `src/commands/match.ts`).

> **Branch context:** these pages were generated from source commit `32f9e93` on `agent/fix-change-aware-ranking`. This branch contains ranking, configuration, and npm-release work not yet in local `main` at documentation time.

## Get running

Requirements: Node.js 20+ and a compatible local GGUF embedding model. The package declares Node `>=20`, although development scripts use `--experimental-strip-types`; verify them on the exact Node version used by CI or release (`package.json`).

```bash
npm install

npx --yes node-llama-cpp@3.19.0 pull \
  --dir models \
  --filename embeddinggemma-300M-Q4_0.gguf \
  hf:ggml-org/embeddinggemma-300M-qat-q4_0-GGUF:Q4_0

npm run lint
npm test
npm run build
node dist/cli.js status
```

The default model is `models/embeddinggemma-300M-Q4_0.gguf`; the default cache is `.rbt/cache/embeddings.json` (`src/config.ts`). Both generated locations are ignored by git.

## Use the CLI

```bash
# Rank tests for a changed source file
node dist/cli.js match src/services/match.ts --candidates tests --json

# Add change-specific evidence from a unified diff
node dist/cli.js match src/services/match.ts \
  --candidates tests \
  --diff-file /path/to/change.diff \
  --json

# Inspect resolved configuration and cache size
node dist/cli.js status --json

# Embed text directly
node dist/cli.js embed "change-aware test ranking" --json

# Evaluate a corpus of expected rankings
node dist/cli.js benchmark --cases cases.json --candidates tests --json

# Generate basic command-name completion
node dist/cli.js completion zsh
```

When installed globally, replace `node dist/cli.js` with `rbt`. Candidate lists can also be supplied to `match` as a JSON array or newline list on stdin with `--candidates-from-stdin`.

## Mental model

1. Commander dispatches a command and resolves flags, environment, config file, and defaults.
2. `match` reads the changed file and optional diff, then builds a `DocumentProfile`.
3. Candidate test files are collected from configured paths, with include/exclude filters and a 1,000-file cap.
4. Source and candidate profiles are embedded by one local `node-llama-cpp` session; misses are buffered for one cache write.
5. Ranking blends normalized cosine similarity (20%) with structural evidence (80%).
6. Results below `minScore` are removed, then the first `topK` are emitted. `threshold` is a compatibility/default input for `minScore`, not the value directly used by `filterMatches`.

See [Architecture](architecture/overview.md), [Matching workflow](workflows/matching.md), and [Ranking model](domain/ranking-model.md).

## Documentation map

- [Architecture overview](architecture/overview.md) — layers, data flow, boundaries, and extension points.
- [Matching and benchmark workflows](workflows/matching.md) — end-to-end behavior and practical change guidance.
- [Ranking domain model](domain/ranking-model.md) — profiles, token semantics, score weights, and heuristics.
- [Operations runbook](operations/runbook.md) — model/config/cache setup, troubleshooting, packaging, and integration notes.
- [Testing guide](testing.md) — suites, commands, regression strategy, and known coverage gaps.
- [Source map](source-map.md) — where to start for each kind of change.

## Important repository facts

- `src/` is the source of truth; `dist/` is generated and excluded from source control.
- The npm package publishes only `dist/`, and `prepack` runs the build (`package.json`).
- The current profiler and candidate scanner are JS/TS-oriented. Profiling is regex-based, not AST-based.
- Auto-discovered repository config is prevented from redirecting the model, cache, or candidate roots outside the workspace, including through existing symlink ancestors. Explicit config/CLI/environment paths are treated as trusted input (`src/config.ts`).
- The README architecture is broadly useful, but its `prompts-idea/` sample directory is absent from this checkout. It also omits the implemented `benchmark` command and `match --diff-file` option.
- No matcher validation CI workflow is tracked; the OpenWiki workflow only updates documentation. Run lint, tests, build, and package verification locally before release.

## Change checklist

Before modifying ranking behavior:

1. Add a focused profile/token regression test.
2. Add a ranking test that demonstrates the intended ordering and guards unrelated candidates.
3. Test both diff-aware and no-diff behavior when weights or token budgets change.
4. Run `npm run lint && npm test && npm run build`.
5. If packaging changes, also run `npm pack --dry-run` and inspect the file list.

## Backlog

- **Real-model compatibility** — `src/services/embedding-provider.ts`: add an opt-in GGUF smoke test; current tests use the deterministic stub.
- **End-to-end CLI/package behavior** — `src/cli.ts`, `dist/cli.js`: add subprocess tests for help, JSON schemas, errors, completion, and packed output.
- **Cache robustness** — `src/services/cache.ts`: validate cache entries, fingerprint model contents/profile versions, test multiprocess locking, and define growth/eviction policy.
- **Configuration schemas** — `src/config.ts`, `src/commands/benchmark.ts`: validate loaded JSON shapes and benchmark case files before use.
- **Candidate discovery determinism** — `src/utils/files.ts`: test and define ordering at the 1,000-file cap; clarify that seed “globs” are not expanded.
- **Release automation** — `package.json`: establish tracked CI for minimum/current Node, lint, tests, build, and `npm pack --dry-run`.
