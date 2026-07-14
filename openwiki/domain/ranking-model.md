# Ranking domain model

## Core concepts

A **source** is the changed file being evaluated. A **candidate** is usually a test file that might cover the change. Both become a `DocumentProfile`; only the source receives optional diff-derived evidence (`src/services/document-profile.ts`).

A profile includes:

- identity: absolute/relative path, basename, kind;
- lexical identity: basename, stem, path-family, content, and semantic tokens;
- code structure: exports and imports;
- test intent: literal `describe`, `it`, and `test` names;
- interface intent: Commander command names and long options;
- distinctive evidence: phrase tokens and curated rare anchors;
- change evidence: simple and phrase tokens whose added/removed occurrence counts differ;
- model input: summary, bounded embedding text, and preview.

Kinds are `source`, `test`, or `fixture` in current classification, although the type also permits `unknown`.

## Token semantics

`src/services/text-utils.ts` splits camelCase and separators, lowercases, removes short/numeric/stop-word tokens, and lightly singularizes. Phrase tokens preserve concatenated compound identities, so canonical and phrase forms can intentionally differ—for example `bonuses` may yield simple `bonus` and phrase `bonuses`.

Path families split paths and imported module paths into contiguous one-to-three-part windows after removing generic segments such as `src`, `tests`, extensions, and `utils`. Rare anchors explicitly recognize distinctive APIs and surfaces including test-ID selectors, MCP/config identifiers, browser names, codegen, and related options.

Extraction is regex-based. Namespace/dynamic imports, many CommonJS/export forms, and computed test names are not comprehensive signals.

## Diff-aware profiling

A unified diff is optional. The parser scopes changes to the profiled file and supports Git multi-file diffs, plain/concatenated unified diffs, custom prefixes, timestamps, absolute paths, and real top-level `a`/`b` directories. Hunk lengths prevent `---`/`+++`-looking content inside a hunk from becoming headers.

For the matched file, added and removed identifiers, strings, options, and path-like values are counted. A token is retained only when counts differ, removing unchanged surrounding noise. Generic terms such as `config`, `option`, and `selector` are filtered from change signals.

Limits matter:

- 72 semantic tokens total;
- at most 24 change-derived semantic tokens, placed first;
- 64 stored content tokens;
- verbose embedding sections fall back to 32 tokens each when needed;
- embedding text is designed to stay within 512 whitespace-delimited words, then the provider also truncates by model tokens.

These budgets preserve both change specificity and file identity. See `tests/document-profile.test.ts` before changing them.

## Structural score

The structural score is a weighted average. If no diff change signals exist, the inactive change weight is removed and the other weights are renormalized.

| Component | Weight | Evidence |
|---|---:|---|
| Change | 0.25 when available | Changed tokens/phrases found in candidate stem, test names, anchors, phrases, semantics, or content |
| Phrase | 0.25 | Weighted overlap of compound identities |
| Anchor | 0.18 | Source exports to candidate imports/tests and rare-anchor relations |
| Semantic | 0.12 | General bounded semantic-token overlap |
| Interface | 0.10 | CLI commands/options and related candidate evidence |
| Path family | 0.07 | Source/import path families versus candidate paths/interfaces |
| Stem | 0.02 | Filename stem overlap |
| Basename | 0.01 | Basename token overlap |

Distinctive tokens receive more weight when they contain path/namespace punctuation, digits, long names, or anchor keywords (`src/services/match.ts`).

### Special heuristics

- A source with at least five option tokens gives a config-path candidate a minimum interface score of `0.58`.
- Public query-style source exports plus matching candidate anchors can give page/browser/client candidates a path-family score of `0.7`.
- Codegen candidates can receive a `0.35` change-score boost for internal/attribute/test-ID changes.
- Change evidence without source-identity alignment is discounted to `0.75`.
- Merely sharing the source filename stem does not by itself earn change credit.

These are deliberate responses to ranking regressions, not generic semantic-search theory. Preserve or replace them with explicit regression evidence.

## Final score and ordering

```text
final = clamp(0.20 * embeddingCosine + 0.80 * structuralScore, 0, 1)
```

Vectors are normalized before cosine. Empty, zero, or dimension-mismatched vectors contribute zero. Results sort by descending final score; exact ties sort by filename for deterministic output. Filtering is inclusive (`score >= minScore`).

`threshold` is not a second ranking stage. During config resolution, it becomes the default `minScore` only when no explicit minimum score is provided (`src/config.ts`). Default threshold and minimum score are both zero.

## Change guidance

1. Start with a minimal failing profile or ranking test.
2. Decide whether the failure is extraction (`document-profile.ts`/`text-utils.ts`) or scoring (`match.ts`). Do not compensate for missing evidence only by raising a weight.
3. Check both diff and no-diff behavior; change weight activation renormalizes structural scoring.
4. Protect against an unrelated candidate, not only the desired winner.
5. Verify token/embedding bounds for large files and diffs.
6. Use `benchmark` for corpus-level impact, but keep focused unit regressions because benchmark case parsing and real model output are not schema/stability guarantees.

Primary regression suites: `tests/document-profile.test.ts`, `tests/text-utils.test.ts`, and `tests/match.test.ts`.
