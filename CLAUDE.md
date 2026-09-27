# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run lint      # tsc --noEmit over src + tests (the only linter; strict, noUnused*)
npm test          # node:test over tests/**/*.test.ts via --experimental-strip-types
npm run build     # tsc -p tsconfig.build.json -> dist/
npm run dev -- match src/foo.ts --candidates tests   # run CLI from source in watch mode

# single file / single test
node --experimental-strip-types --test tests/jev.test.ts
node --experimental-strip-types --test --test-name-pattern="adaptive" tests/selection.test.ts
```

No bundler is used for the build. Source runs directly under Node type stripping, so:
- relative imports must use the `.ts` extension (`rewriteRelativeImportExtensions` turns them into `.js` in `dist/`)
- `erasableSyntaxOnly` is on: no `enum`, `namespace`, or constructor parameter properties

Tests never hit the network: `JevScorer` takes an injectable `fetch` (see `makeScorer` in `tests/jev.test.ts`).

## What it is

`rbt` is a CLI that ranks which test files should re-run for a source change. It blends a TypeSafe **Jev** model probability (one yes/no question per candidate, `POST https://api.typesafe.ai/v1/systemone`, key from `TYPESAFE_API_KEY` env only) with local structural heuristics.

## Architecture

Flow for `rbt match` (`src/commands/match.ts`):

1. **Changed files.** With file args, those are ranked. With `--diff-file`, files come from the diff (`listDiffFiles`). With neither, it is *automatic mode*: `services/git-changes.ts` reads tracked + untracked changes against `HEAD` (read-only git), and after ranking the CLI offers to run the chosen tests (`services/test-runner.ts` guesses vitest/jest/playwright/mocha from `package.json`).
2. **Candidates.** `utils/files.ts` walks candidate paths with include/exclude globs (`utils/patterns.ts`), capped at `MAX_CANDIDATE_FILES`.
3. **Profiles.** `services/document-profile.ts` turns each file (and the changed file plus its diff hunks via `services/unified-diff.ts`) into a `DocumentProfile`: kind, symbols, tokens, change evidence, preview. Diff path handling (prefixes, renames, `--diff-root`) is subtle and heavily tested; see git log before changing it.
4. **Jev scoring.** `services/jev.ts` `JevScorer` batches all candidates for one change into as few requests as it can, retries retryable failures, and caches answers in `<cacheDir>/jev.json` (`services/cache.ts`, locked best-effort writes; `flush()` must run, it is in a `finally`). Any `JevError` in `match` downgrades to `heuristics` with a stderr warning and a `rankerFallback` field in JSON. `benchmark` fails instead of falling back.
5. **Ranking + selection.** `services/match.ts`: `rankMatches` blends 60% Jev + 40% structural (structural alone under `heuristics`), `filterMatches` applies min score, `selectMatches` applies the selection policy (`adaptive` default, `conservative`, `targeted`). Weights and thresholds were tuned on a Playwright corpus. Treat them as measured choices, not arbitrary constants.
6. **Output.** Several changed files are merged by best score per test file. Output modes are text, `--json`, and `--paths-only`.

Config (`src/config.ts`) resolves in this order: CLI flags, then `RBT_*` env vars (empty string counts as unset), then `--config` / `.rbt/config.json` / `.rbtconfig`, then defaults.

Other commands: `benchmark` (JSON cases with `expectedTop1/Top3/Top10Includes`; it reports ranking hit rates, not selection policies), `status`, `completion`.

## Notes

- `README.md` mentions a `prompts-idea/` sample dataset. It is not in the repo.
- The Playwright evaluation (scripts and results) is not in the repo.
