# Testing and change validation

## Standard checks

```bash
npm run lint
npm test
npm run build
```

- `lint` is strict TypeScript checking with no emit (`tsconfig.json`).
- `test` runs `node:test` over `tests/**/*.test.ts` using Node's experimental type stripping.
- `build` compiles only `src/` to ESM under `dist/` with source maps (`tsconfig.build.json`).

For package-facing changes, also run `npm pack --dry-run` and smoke-test `dist/cli.js`.

## Test map

- `async.test.ts`: concurrency limit, ordering, empty input, failure propagation.
- `benchmark.test.ts`: benchmark registration/execution and threshold-derived filtering.
- `cache.test.ts`: key identity, malformed/missing files, batch merge, lock cleanup.
- `config.test.ts`: defaults, selected precedence, clamping, malformed JSON, pattern behavior.
- `document-profile.test.ts`: profile bounds, net change signals, multi-file/unified-diff path cases.
- `embeddings.test.ts`: memory/disk hits, batching, flush and skip-cache behavior.
- `files.test.ts`: extension filtering, skipped directories, patterns, missing seeds, deduplication.
- `io.test.ts`: stdin candidate parsing.
- `match.test.ts`: cosine/score invariants, stable ordering, and ranking regressions.
- `patterns.test.ts`: custom glob and parent-path semantics.
- `text-utils.test.ts`: canonicalization, tokenization, overlaps, deterministic vectors.

## High-risk change matrices

### Profiling or tokenization

Test camelCase/acronyms, plural forms, Windows/Unix paths, large files, generic-token suppression, and preservation of distinctive compounds. If diff-aware, test added, removed, and unchanged repeated tokens.

### Unified diff parsing

Test Git and plain formats, multiple files, custom/no prefixes, absolute paths, timestamps, omitted hunk counts, concatenated diffs, and header-looking hunk content. Confirm unrelated file changes are excluded.

### Ranking

Assert desired ordering, component bounds, and an unrelated control candidate. Cover source-identity alignment, direct callers versus filename matches, and both diff/no-diff paths. Because active weights renormalize, a change component can alter every structural score.

### Configuration/discovery

Test precedence, cwd-relative resolution, workspace containment/symlinks, include replacement versus exclude merging, missing roots, direct files, cap behavior, and separators.

### Embedding/cache

Use `RBT_EMBEDDING_TEST_MODE=stub`. Test cache misses/hits, backend/model/text key separation, one-session batching, failed flush retry behavior, malformed entries, concurrent writers, stale locks, and no-cache mode.

## Known coverage gaps

- No real GGUF smoke test.
- No end-to-end `match` subprocess/output test.
- No direct `embed`, `status`, `completion`, or top-level CLI error tests.
- Benchmark metric semantics and malformed case schemas have little coverage.
- Candidate cap ordering, hidden directories, symlinks, and direct unsupported-extension seeds are not fully tested.
- Cache timeout/stale-lock recovery and multiprocess races are not exercised.
- No formal coverage threshold/report is configured.

## Verification note

For this PR, `npm run lint`, all 96 tests, `npm run build`, and `git diff --check` passed. Keep running these checks after source changes; generated `dist/` alone is not proof that the current source passes.
