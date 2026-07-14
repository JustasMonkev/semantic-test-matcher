# Matching and command workflows

## `match`: changed file to likely tests

```bash
rbt match src/example.ts --candidates tests --json
rbt match src/example.ts --candidates tests --diff-file change.diff --top-k 10
```

`src/commands/match.ts`:

1. Optionally reads stdin candidates as a JSON array or newline list.
2. Resolves configuration.
3. Reads the changed file and optional unified diff.
4. Profiles and embeds the source.
5. Discovers candidates and excludes the source itself.
6. Profiles/embeds candidates with concurrency 8 through one `EmbeddingSession`.
7. Flushes buffered cache entries.
8. Ranks, filters by `minScore`, and takes `topK`.
9. Prints rows/previews or JSON with component scores, backend/cache metadata, and candidate-cap status.

If `--candidates` is non-empty it wins over `--candidates-from-stdin`. Quiet mode suppresses summaries and previews, not the score/path result rows.

## Candidate discovery

Seeds come from command options, config, or defaults (`test`, `tests`). A seed may be a file or directory; despite command help mentioning globs, seed strings are resolved literally. Include/exclude patterns use the custom matcher in `src/utils/patterns.ts`, not minimatch.

Directory traversal:

- includes `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.mts`, `.cjs`, `.cts`;
- skips git, dependencies, common build/coverage/cache folders, and hidden relative directories;
- does not follow symlinks;
- silently ignores missing seeds;
- deduplicates paths;
- stops at 1,000 candidates.

Directory entries are not explicitly sorted, so the selected set at the cap can depend on filesystem order. Direct file seeds pass patterns but currently bypass the extension check used during traversal (`src/utils/files.ts`).

## Configuration workflow

Auto-discovery checks, in order:

1. `.rbt/config.json`
2. `.rbtconfig`

There is no parent/home search. `--config` checks only the supplied path; a missing explicit file currently falls back to empty config rather than failing.

Precedence is generally:

```text
command-local flag -> global flag (where applicable) -> environment -> config file -> default
```

Matching numerics use command, environment, file, then defaults. `topK` is floored and clamped to 1–1000; threshold/minimum score are clamped to 0–1. `minScore` defaults to the resolved threshold. Include flags replace configured includes; exclude flags are merged with configured/default excludes.

Common environment variables are `RBT_MODEL`, `RBT_CACHE_DIR`, `RBT_LOG_LEVEL`, `RBT_VERBOSE`, `RBT_QUIET`, `RBT_TOP_K`, `RBT_MATCH_TOP_K`, `RBT_THRESHOLD`, `RBT_MATCH_THRESHOLD`, `RBT_MIN_SCORE`, and `RBT_MATCH_MIN_SCORE` (`src/config.ts`).

All relative paths resolve against the process working directory, not the config file location.

## `benchmark`: evaluate expected rankings

```bash
rbt benchmark --cases cases.json --candidates tests --json
```

A case can contain:

```json
{
  "source": "src/page.ts",
  "expectedTop1": "tests/page.spec.ts",
  "expectedTop3": ["tests/page.spec.ts"],
  "expectedTop10Includes": ["tests/page.spec.ts", "tests/api.spec.ts"],
  "diffText": "--- a/src/page.ts\n+++ b/src/page.ts\n..."
}
```

`src/commands/benchmark.ts` profiles/embeds the candidate corpus once, then evaluates every source through the same ranking/filtering code. Top-1 is exact; top-3 passes when any expected file is present; top-10 inclusion requires all listed files. If top-3 expectations are omitted, top-1 is reused. Miss output includes expected ranks and observed top ten.

The case file is parsed without runtime schema validation. The benchmark has no `topK` option because it directly inspects ranks 1, 3, and 10 after `minScore` filtering.

## Supporting commands

### `embed`

Embeds a positional string or trimmed stdin, flushes the cache, and prints the full vector. JSON includes model, backend, cache hit, vector size, and vector (`src/commands/embed.ts`). Empty input sets exit code 1.

### `status`

Resolves config and counts cache entries without loading the model. Prefer JSON when diagnosing full matching settings because human output omits `minScore` and patterns. In JSON, `resolvedConfigFile: "auto"` can coexist with `hasConfig: "missing"`; use `hasConfig`/the actual path, not the string `auto`, to infer discovery (`src/commands/status.ts`).

### `completion`

Prints Bash or Zsh scripts that parse `rbt --help` with `awk`. It completes subcommand names only and is coupled to Commander help formatting (`src/commands/completion.ts`).

## Automation and integration points

- Use `--json` for machine consumption, but pin the package version because schemas are not versioned.
- Candidate stdin integrates with changed-file lists from build/CI systems.
- `--diff-file` or benchmark `diffText` integrates source-control changes into ranking.
- The package integrates with local `node-llama-cpp`; it does not call Hugging Face or Ollama at runtime.

## Workflow change checklist

- Flag/config change: update `src/config.ts`, relevant command, README/OpenWiki, and config tests.
- JSON output change: add an end-to-end/subprocess test before relying on compatibility.
- Candidate collection change: test files, directories, patterns, skips, cap behavior, and cross-platform separators.
- Benchmark semantics change: test hit/miss accounting and ensure `match` still uses the same ranking/filter path.
