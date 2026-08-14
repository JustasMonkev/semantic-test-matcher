# Testing and change validation

## Standard checks

```bash
npm run lint
npm test
npm run build
```

- `lint` is strict TypeScript checking with no emit (`tsconfig.json`), covering `src` and `tests`.
- `test` runs `node:test` over `tests/**/*.test.ts` using Node's type stripping.
- `build` compiles only `src/` to ESM under `dist/` with source maps (`tsconfig.build.json`).

For package-facing changes, also run `npm pack --dry-run` and smoke-test `dist/cli.js`.

Coverage is available through Node's built-in reporter:

```bash
node --experimental-strip-types --experimental-test-coverage \
  --test-coverage-exclude='tests/**' --test "tests/**/*.test.ts"
```

## Test map

- `async.test.ts`: concurrency limit, ordering, empty input, failure propagation.
- `benchmark.test.ts`: registration, hit/miss metrics, observed ranks, diff cases, case-file validation.
- `cache.test.ts`: key identity, malformed/missing files, batch merge, lock cleanup.
- `cache-resilience.test.ts`: corrupt entries, lock contention, stale locks, lock timeout, atomic replace, cross-process writers.
- `cli.test.ts`: every subcommand as a real subprocess — exit codes, stdout/stderr routing, JSON shape.
- `config.test.ts`: defaults, precedence, clamping, boolean/blank env parsing, malformed JSON.
- `config-security.test.ts`: workspace containment for model, cacheDir, and candidate paths; symlink escapes; discovery order and cwd threading.
- `document-profile.test.ts`: profile bounds, net change signals, unified-diff path cases, unicode, empty input.
- `embeddings.test.ts`: memory/disk hits, batching, flush, skip-cache, best-effort write failure.
- `files.test.ts`: extension filtering, skipped directories, patterns, cap and truncation, symlinks, dedup.
- `io.test.ts`: stdin candidate parsing, TTY short-circuit, debug flag.
- `match.test.ts`: cosine/score invariants, stable ordering, component bounds, ranking regressions.
- `match-weights.test.ts`: each structural component isolated on a hand-built profile, proving its weight still reaches the blended score.
- `model-smoke.test.ts`: the real GGUF backend. Skipped when `models/` has no model.
- `patterns.test.ts`: custom glob semantics, metacharacter literals, parent-path checks.
- `ranking-quality.test.ts`: end-to-end top1/top3 hit rate over a multi-module workspace.
- `text-utils.test.ts`: canonicalization, tokenization, overlaps, deterministic vectors.

## High-risk change matrices

### Profiling or tokenization

Test camelCase/acronyms, plural forms, Windows/Unix paths, large files, generic-token suppression, and preservation of distinctive compounds. Tokenization keeps letters and digits from any script, so cover non-ASCII names alongside ASCII ones. If diff-aware, test added, removed, and unchanged repeated tokens.

### Unified diff parsing

Test Git and plain formats, multiple files, custom/no prefixes, absolute paths, timestamps, omitted hunk counts, concatenated diffs, quoted/escaped paths, CRLF, and header-looking hunk content. Confirm unrelated file changes are excluded.

### Ranking

Assert desired ordering, component bounds, and an unrelated control candidate. Cover source-identity alignment, direct callers versus filename matches, and both diff/no-diff paths. Because active weights renormalize, a change component can alter every structural score.

Fixture-based ordering tests are not enough on their own: real profiles feed several components from the same tokens, so a component can be switched off without moving any fixture. Isolate the component on a hand-built `DocumentProfile` (see `match-weights.test.ts`) when changing weights.

### Configuration/discovery

Test precedence, cwd-relative resolution, workspace containment/symlinks, include replacement versus exclude merging, missing roots, direct files, cap behavior, and separators. Discovery follows the `cwd` passed to `resolveConfig`, not `process.cwd()`.

### Embedding/cache

Use `RBT_EMBEDDING_TEST_MODE=stub`. Test cache misses/hits, backend/model/text key separation, one-session batching, failed flush behavior, malformed entries, concurrent writers, stale locks, and no-cache mode. `RBT_CACHE_WRITE_DELAY_MS` widens the read-modify-write window and `RBT_CACHE_LOCK_TIMEOUT_MS` shortens the lock deadline.

## Known coverage gaps

- No CI workflow runs these checks automatically.
- Debug-only logging branches behind `RBT_DEBUG=1` are not asserted.
- `resolveRealPath` error paths needing a non-ENOENT filesystem error (for example EACCES) are unexercised.
- A literal backslash in a diff path cannot round-trip on POSIX, so that decode branch is untested.
- The ranking quality gate uses the stub embedder; real-model ranking quality is not pinned.

## Verification note

Keep running lint, tests, and build after source changes; generated `dist/` alone is not proof that the current source passes.
