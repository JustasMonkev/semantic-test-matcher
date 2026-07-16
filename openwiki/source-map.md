# Source map

Use this as a change-oriented index, not a complete file inventory.

## Product and packaging

| Source | Responsibility | Verify with |
|---|---|---|
| `package.json` | npm identity, Node requirement, scripts, published `dist`, `rbt` bin | build, `npm pack --dry-run`, version smoke test |
| `README.md` | public installation and command documentation | compare against registered commands/options |
| `src/cli.ts` | Commander root, global flags, version, top-level errors | CLI subprocess tests |
| `src/commands/index.ts` | command registration | `--help` smoke test |

## Commands and workflows

| Source | Responsibility | Closest tests / caveat |
|---|---|---|
| `src/commands/match.ts` | main profile/embed/rank/filter/output flow | ranking/services tested; no end-to-end command test |
| `src/commands/benchmark.ts` | corpus metrics and misses | `tests/benchmark.test.ts` is narrow |
| `src/commands/embed.ts` | raw text/stdin embedding | service tests only |
| `src/commands/status.ts` | config/cache inspection | no direct test |
| `src/commands/completion.ts` | Bash/Zsh command completion | no direct test |
| `src/config.ts` | defaults, precedence, normalization, workspace containment | `tests/config.test.ts` |

## Matching domain

| Source | Responsibility | Verify with |
|---|---|---|
| `src/services/document-profile.ts` | source/test feature extraction and diff scoping | `tests/document-profile.test.ts` |
| `src/services/text-utils.ts` | canonical tokens, overlaps, normalization, stub vectors | `tests/text-utils.test.ts` |
| `src/services/match.ts` | component scoring, hybrid blend, ordering/filter | `tests/match.test.ts` |

The current branch's highest-risk coupled area is this three-file group. Recent commits repeatedly changed all three to fix change-aware ranking, diff parsing, path prefixes, and acronym/plural handling.

## Embeddings and persistence

| Source | Responsibility | Verify with |
|---|---|---|
| `src/services/embedding-provider.ts` | lazy local GGUF context, prompt, token truncation, stub | no real-model test |
| `src/services/embedding-types.ts` | backend/result types | TypeScript check |
| `src/services/embeddings.ts` | session cache/provider lifecycle and batch flush | `tests/embeddings.test.ts` |
| `src/services/cache.ts` | cache format, key, lock, atomic persistence | `tests/cache.test.ts` |

## File/input utilities

| Source | Responsibility | Verify with |
|---|---|---|
| `src/utils/files.ts` | candidate traversal, filtering, deduplication, cap | `tests/files.test.ts` |
| `src/utils/patterns.ts` | lightweight glob matching and parent checks | `tests/patterns.test.ts` |
| `src/utils/io.ts` | stdin text/list parsing and debug switch | `tests/io.test.ts` |
| `src/utils/async.ts` | ordered concurrency-limited mapping | `tests/async.test.ts` |

## Generated and operational material

- `dist/`: generated build output; do not edit directly.
- `models/*.gguf`: external model files, ignored by git.
- `.rbt/cache/`: runtime embeddings, ignored by convention/default.
- `openwiki/INSTRUCTIONS.md`: user-authored wiki brief; do not rewrite during normal maintenance.
- `AGENTS.md`, `CLAUDE.md`: repository guidance pointers maintained with the OpenWiki documentation.

## Change recipes

- **Add a CLI option:** command declaration -> `resolveConfig` type/precedence if persistent -> status/README/OpenWiki -> config and subprocess tests.
- **Add a profile signal:** `DocumentProfile` -> extraction/bounds/embedding text -> score consumer -> profile and ranking regressions -> consider cache semantics.
- **Change score weights:** `match.ts` -> component/order tests -> benchmark corpus -> document rationale.
- **Add a backend:** config/types/provider -> session/cache identity -> status/JSON output -> operational docs -> deterministic and live smoke tests.
- **Change candidate scope:** files/pattern utilities -> config defaults/containment -> traversal and cross-platform tests.
- **Prepare a release:** full checks -> build -> pack dry run -> CLI smoke tests -> verify README against `--help`.
