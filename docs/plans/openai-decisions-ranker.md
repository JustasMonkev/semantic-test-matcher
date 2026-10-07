# OpenAI Decisions ranker implementation plan

Status: Implemented locally with bounded pilot evaluation; follow-up items below

Date: 2026-10-07

## Objective

Add OpenAI Decisions as an optional alternative to Jev for scoring candidate test files. After evaluating the standalone ranker, add an explicit Jev-to-Decisions fallback option. Preserve the existing default of Jev with local heuristics as its fallback.

The implementation now supports `--ranker decisions` (alias `openai`), `--fallback-ranker decisions`, and the credential aliases `OPEN_AI` and `JEF`. Jev remains the default. The checklist below preserves the original implementation scope; it is not a claim that every proposed evaluation gate has been satisfied.

## Implementation record

The provider adapter, shared scoring contract, CLI/configuration changes, whole-run fallback, cache isolation, strict benchmark behavior, output attribution, credential filtering, and offline regression tests are implemented. A dependency-free mutation harness is available at `scripts/mutation-check.mjs`.

The [Playwright benchmark summary](../benchmarks/playwright.md) compares both live providers with heuristics on five source mutations and one compound change. It establishes API interoperability and recovery behavior, not general ranking superiority. All three rankers recovered the known failing test files; heuristics selected fewer files in this sample. No thresholds were tuned on the pilot.

Remaining limits from the original plan:

- Decisions uses the existing 60% model weighting and 0.5/0.7 selection boundaries provisionally. Held-out calibration and an agreed acceptable missed-test rate remain future work.
- Timeouts and retries are bounded per request, but there is no aggregate deadline across all sources and the fallback chain. Existing Jev retry behavior is preserved.
- Decisions batch caps are conservative local implementation budgets, not a claim about published endpoint maxima.
- Decisions responses reporting the requested model are cached for at most 24 hours. This limits staleness but does not make the model alias immutable; responses without reported model identity are not cached.

## API fit

The [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions), reviewed during the investigation, documents shared input, named `predicate` questions, and probability answers. It lists `gpt-6-luna` on `POST /v1/decisions` and describes the endpoint as public beta. Recheck availability and the API contract before implementation.

Use one independent predicate per candidate. Several tests can be relevant to the same change, so a single mutually exclusive `choice` question is not appropriate.

| Existing evidence or result | Decisions mapping |
| --- | --- |
| Changed path, exported symbols, diff or source excerpt | Shared input text |
| Candidate path and test titles | Candidate evidence referenced by a named predicate |
| Should this test rerun for this change? | Predicate instructions |
| Jev `noul` value | Predicate `probability` |
| Candidate question identifier | Answer `name`, mapped back to the candidate path |

No ranking-quality or latency advantage over Jev is established. Similar output types do not establish equivalent probability calibration.

## Scope and constraints

- Keep Jev as the default ranker and heuristics as the final fallback for `match`.
- Keep `--ranker heuristics` entirely local, regardless of configured credentials.
- Require explicit configuration before sending evidence to OpenAI. The presence of `OPENAI_API_KEY` alone must not enable the provider.
- Preserve existing source-excerpt limits, candidate metadata limits, path checks, and diff-only handling. Candidate test bodies must not be added to remote requests.
- Preserve configuration precedence: flags, environment, config file, then defaults. API keys remain environment-only.
- Keep `benchmark` strict: a provider failure must fail the benchmark rather than silently substitute another provider.
- Do not add provider ensembles, automatic quality-based routing, generated explanations, or arbitrary fallback chains in this change.

## Proposed user behavior

```sh
# Existing default, unchanged: Jev then heuristics
rbt match src/example.ts

# Standalone alternative: Decisions then heuristics
rbt match src/example.ts --ranker decisions

# Explicit remote fallback: Jev then Decisions then heuristics
rbt match src/example.ts --ranker jev --fallback-ranker decisions

# Local only
rbt match src/example.ts --ranker heuristics
```

Add `decisionsModel` / `--decisions-model` / `RBT_DECISIONS_MODEL`, initially using the model verified against current documentation. Add `fallbackRanker` / `--fallback-ranker` / `RBT_FALLBACK_RANKER`, defaulting to `heuristics`. Accept `decisions` as a fallback only when the primary ranker is `jev`; reject conflicting combinations rather than silently ignoring them. Benchmarks must reject a remote fallback configuration with a clear explanation.

## Implementation sequence

### 1. Verify the Decisions contract

- [ ] Confirm model access, endpoint schema, answer names, refusal shape, usage fields, and model identification in responses.
- [ ] Verify input and question limits. Do not copy Jev's request budget or batch-size constants as OpenAI limits.
- [ ] Confirm timeout and retry guidance, including rate-limit responses.
- [ ] Prefer native `fetch` to match the existing scorer unless an SDK provides a concrete benefit. If using the SDK, verify the required version and document the dependency choice.
- [ ] Decide how to identify model revisions for cache reuse. Do not assume an alias is immutable or that the response exposes a pinned version.

Completion check: documented request/response fixtures and provider-specific limits are sufficient to implement the adapter without guessing.

### 2. Extract the shared scoring contract without changing Jev behavior

Primary files: `src/services/jev.ts`, a new `src/services/model-scorer.ts`, and `src/services/match.ts`.

- [ ] Introduce provider-neutral source, candidate, result, and scorer types. Retain `score(source, candidates)` and `flush()` responsibilities.
- [ ] Return a path-to-probability map plus provider/model attribution, request counts, cache hits, and available usage information.
- [ ] Represent unavailable usage as unavailable, not zero measured tokens.
- [ ] Extract bounded evidence construction so both providers honor the same data-disclosure rules.
- [ ] Introduce a typed provider failure for expected API, credential, and response-validation errors. Do not catch unrelated programming errors as fallback events.
- [ ] Generalize internal `jevScore` terminology and selection checks while preserving Jev's existing behavior and public compatibility.

Completion check: existing Jev and heuristics tests still pass with unchanged ranking, selection, and default fallback behavior.

### 3. Implement the Decisions scorer

Primary file: new `src/services/decisions.ts`.

- [ ] Build shared input and one stable, uniquely named predicate per candidate. Keep repository evidence distinct from instructions.
- [ ] Match returned answers by name, not array position. Reject missing, duplicate, unknown, wrong-type, non-finite, or out-of-range answers.
- [ ] Treat a refusal as an unavailable score, never as probability zero. For the first version, fail the provider attempt so whole-run fallback applies.
- [ ] Add bounded batching, concurrency, request timeouts, and retry handling. Retry transient failures; do not repeatedly retry authentication failures or refusals.
- [ ] Use a separate cache namespace or file from Jev. Key entries by provider, model identity, evidence, candidate question, and prompt/schema version.
- [ ] Define conservative expiry or disable persistent reuse when immutable model identity cannot be established.
- [ ] Reuse cache utilities where appropriate, including best-effort cache reads/writes and flushing valid completed work after a later failure.

Completion check: stubbed API tests cover successful scoring, reordered answers, malformed responses, refusals, batching, retry exhaustion, timeouts, and cache isolation/invalidation.

### 4. Wire the standalone ranker through the CLI

Primary files: `src/config.ts`, `src/commands/match.ts`, `src/commands/benchmark.ts`, `src/commands/status.ts`, `src/cli.ts`, and `src/services/test-runner.ts`.

- [ ] Add `decisions` to the ranker union, validation, CLI help, config-file support, and environment resolution.
- [ ] Construct the selected scorer through a small provider factory shared by match and benchmark orchestration.
- [ ] Add provider-neutral output metadata for requested/effective ranker, model identity, usage, and cache statistics.
- [ ] Preserve existing Jev JSON fields for Jev runs during migration. Never put OpenAI results under a `jev` label. Add output fixtures defining compatibility.
- [ ] Make adaptive and targeted selection recognize valid model evidence from either provider instead of checking only `ranker === 'jev'`.
- [ ] Keep Jev's current weighting and boundaries unchanged. Treat the current 60% model weight and 0.5/0.7 boundaries as provisional for Decisions until evaluated.
- [ ] Update status/cache reporting without making network requests or printing credentials.
- [ ] Extend the existing test-runner environment filtering to remove `OPENAI_API_KEY`, including case-insensitive handling.

Completion check: explicit Decisions selection works with a stubbed endpoint; absent credentials produce a visible heuristic fallback in match and a failure in benchmark. Heuristics invokes neither remote scorer.

### 5. Evaluate standalone ranking and selection

Primary files: `src/commands/benchmark.ts`, benchmark fixtures, and relevant tests.

- [ ] Compare Jev, Decisions, and heuristics on the same labeled changes and candidate sets.
- [ ] Include localized edits, shared-code changes, renames/deletions, weak structural matches, and multiple relevant tests.
- [ ] Keep existing ranking hit-rate metrics, but add selection-level relevant-test recall and selected-set size. Existing top-1/top-3/top-10 expectations alone cannot establish full selection recall.
- [ ] Record model/prompt versions, request counts, cache state, input usage when available, elapsed time, and provider failures. Separate cold-cache from warm-cache runs.
- [ ] Tune Decisions-specific thresholds or weighting on calibration examples and assess them on held-out cases. Do not interpret the blended structural/model score as a calibrated failure probability.
- [ ] Establish and record an acceptable missed-test rate and selection-size tradeoff before enabling the fallback feature. If quality is insufficient, retain the standalone experimental option and defer fallback.

Live evaluation is a separate, explicitly configured step using suitable fixtures and credentials. Automated tests remain offline. Recheck current pricing before estimating costs; the Decisions guide's speed comparison with Responses does not establish performance relative to Jev.

### 6. Add the opt-in fallback path

Primary file: `src/commands/match.ts`, with config validation and command tests.

- [ ] Implement `jev -> decisions -> heuristics` only when configured, and `decisions -> heuristics` for direct Decisions use.
- [ ] Apply fallback to the whole run. If any changed file fails under Jev, score every changed file with Decisions before ranking/merging. Never mix partial Jev, Decisions, and heuristic results within one output run.
- [ ] Flush valid cached results from failed attempts without reusing their partial scores in the effective run.
- [ ] Record each attempted provider and sanitized failure reason, plus the effective provider. Preserve the existing `rankerFallback` behavior for default Jev-to-heuristics runs.
- [ ] Set a bounded retry/time budget across the chain so two remote providers cannot cause unexpectedly long CI waits.
- [ ] Do not trigger fallback merely because probabilities are low. Valid low scores belong to selection logic, not provider availability handling.

Completion check: command tests cover missing primary credentials, successful secondary scoring, failure of both providers, a later changed-file failure, cache reuse, and explicit local-only mode.

### 7. Update documentation and verify the implementation

- [ ] Update README options, configuration examples, architecture overview, JSON examples, benchmark behavior, and provider-specific data handling.
- [ ] Explain which metadata leaves the machine for each provider, how fallback is enabled, and how to stay local.
- [ ] Document cache identity/expiry rules and the provisional or evaluated status of Decisions selection thresholds.
- [ ] Add regression coverage for config precedence, output compatibility, diff-only payloads, credential filtering, and provider-neutral selection.
- [ ] Run `npm run lint`, `npm test`, and `npm run build`. Do not commit generated `dist/` output.

## Delivery order

1. Provider-neutral refactor with no behavior change.
2. Standalone Decisions adapter, CLI support, and offline tests.
3. Recorded comparative evaluation and selection-policy calibration.
4. Opt-in remote fallback, complete reporting, and user documentation.

Each stage should remain independently reviewable. This plan does not authorize changing the default provider or enabling remote fallback for existing users.
