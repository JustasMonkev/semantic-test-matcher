# Representative selection on lazy-clean

Target: `lazy-clean` main at `71c2d8c2923c28db41bb38899d4773ac3ca5d110` (2026-10-29 evaluation), Node `v24.22.1`, Linux x64. The matcher runs its current working source with the local `heuristics` ranker. The final implementation is commit `82417238d58d7e5a83d6f2d869abdd00f5d6bd6f`. Exact source fingerprints and raw observations are in [`results.json`](../benchmarks/lazy-clean-representative/results/results.json).

## Method

The candidate inventory is the eleven entrypoints explicitly named by lazy-clean's `npm test` script, including `skills/slop-check/scripts/check.test.mjs`. It is not a recursive `node --test` invocation: that would change execution and accidentally include fixtures. Selected suites preserve package-script order, sequential scheduling, fail-fast behavior, and the `--test` flag used only for `tests/skill-token-paths.test.mjs`.

Compare uncapped adaptive selection, adaptive selection capped at rank three, and representative selection capped globally at three. All use the same local ranker and diffs. The representative policy first uses uncapped adaptive eligibility, then greedily reduces the sum of nearest test-profile Jaccard distances with medoids. For each scenario, three separate CLI invocations measure selector startup, file reading, ranking, and selection together. These are wall times, not a microbenchmark of the medoid function alone. The full baseline includes npm startup; selected-suite times include the benchmark runner's sequential subprocess launches. Small differences should not be attributed to the medoid algorithm.

Five single-fault scenarios exercise array-checker method ordering, blocked verification exit status, lowercase Windows path redaction, generated-case replay guidance, and a grader that accepts premature exit. A sixth scenario batches the last four faults. It is a multi-file stress case, not four additional independent samples. Every changed byte lives in a temporary clone of the pinned target. Each intended witness must fail with a normal exit and a captured failure marker, then pass after restoration. Signals, launch errors and timeouts invalidate the measurement instead of counting as detections. The raw `failures` arrays contain filtered diagnostic lines, including expected bad-fixture messages from passing harnesses; normal process exit status determines the outcome.

Actual selected mutant suites are executed once per distinct selection within each scenario; equal selections share that execution. Full-suite mutation detection is inferred from the confirmed failing constituent tests. The six full mutant `npm test` runs are **not** executed. Full clean `npm test` and clean selected suites are actually executed for timing. Clean selection sets are shared across scenarios when identical. The full-inventory adaptive selection reuses the one timed full baseline; smaller unique sets run three times.

## Results

Adaptive selection detected all five distinct single faults. Ranked-three and representative-three each detected four, missing the generated-case replay guidance contract regression. All four runtime-code single faults were detected by all three policies. In the four-fault batch, every policy detected at least one fault. Adaptive selected all four known failing witnesses, ranked-three selected three, and representative-three selected two. The medoid objective measures representation of test-file text; it did not preserve all observed failure coverage.

The complete clean `npm test` passed in **116.325 seconds** (one timed sample). For the two broad changes, representative selection chose three tests with a **20.464-second** median clean suite time. Including CLI selection gives about **20.8 seconds**, roughly **82% less wall time** than the observed full baseline. Ranked-three took about **27.0 seconds** for the guidance change and **30.3 seconds** for the compound change. Those differences reflect the test files selected; they do not establish a general advantage for medoids.

Estimated end-to-end seconds below add median CLI selection time to median clean suite time. Mutation detection comes from actual selected mutant executions, separately from these passing-suite cost measurements.

| Scenario | Adaptive: files / seconds | Ranked-three: files / seconds | Representative-three: files / seconds | Detected: adaptive / ranked / representative |
| --- | ---: | ---: | ---: | --- |
| array-method-order | 2 / 16.12 | 2 / 16.13 | 2 / 16.11 | yes / yes / yes |
| verify-failed-gate | 1 / 11.61 | 1 / 11.85 | 1 / 11.60 | yes / yes / yes |
| private-windows-path | 1 / 0.54 | 1 / 0.52 | 1 / 0.56 | yes / yes / yes |
| generated-case-replay | 11 / 116.66 | 3 / 26.95 | 3 / 20.83 | yes / no / no |
| grader-early-exit | 3 / 44.92 | 3 / 44.91 | 3 / 44.89 | yes / yes / yes |
| compound-four-families | 11 / 116.64 | 3 / 30.28 | 3 / 20.77 | yes / yes / yes |

The cap changes no selected tests in the four runtime-code single-fault scenarios: their adaptive pools already contain at most three tests. Representative selection therefore provides no additional test reduction in those cases. The guidance fault is a static instruction-contract regression; the capped suites exit successfully despite it.

In the compound batch, known failing-witness membership is **4/4 adaptive, 3/4 ranked, 2/4 representative**. Both capped suites fail quickly on the grader fault. That batch-level detection does not mean they cover the omitted verification or guidance faults; sequential execution stops at the first failure.

Actual clean suite measurements, shared for identical selections:

| Selection used by | Test files | Median seconds | Min–max seconds | Timed samples |
| --- | ---: | ---: | ---: | ---: |
| Array scenario, all policies | 2 | 15.795 | 15.261–16.038 | 3 |
| Verification scenario, all policies | 1 | 11.306 | 11.215–11.493 | 3 |
| Windows-path scenario, all policies | 1 | 0.239 | 0.230–0.262 | 3 |
| Broad guidance and compound, adaptive | 11 | 116.325 | 116.325–116.325 | 1 (reused full baseline) |
| Broad guidance, ranked-three | 3 | 26.655 | 26.546–26.793 | 3 |
| Broad guidance and compound, representative-three | 3 | 20.464 | 20.007–21.889 | 3 |
| Grader scenario, all policies | 3 | 44.597 | 44.373–44.787 | 3 |
| Compound, ranked-three | 3 | 29.979 | 29.878–30.042 | 3 |

CLI selection overhead, including Node startup and ranking, is measured separately (18 process starts per policy):

| Policy | Median seconds | Min–max seconds |
| --- | ---: | ---: |
| adaptive | 0.319 | 0.281–0.378 |
| ranked-k3 | 0.308 | 0.277–0.592 |
| representative-k3 | 0.313 | 0.289–0.594 |

## Limits and reproducibility

This is a small, hand-authored fault sample in one repository using local heuristics. It does not measure Jev or OpenAI provider latency, cost, or ranking quality. It does not establish a production missed-bug probability, general superiority over ranked selection, or a guarantee that selected tests cover changed behavior. A selected suite can detect one fault in a multi-fault batch while missing other faults. Report batch detection and selected failing-witness coverage separately.

The full baseline has one timed sample plus an earlier untimed passing `npm test`; it has no reliable variance estimate. Selected timing samples run on the same host with the original scheduling, but process startup, cache state and host noise still affect them. End-to-end figures add median selector wall time to median clean suite wall time; they are additive estimates, not timings of a single combined command.

One initial attempt aborted because a restored verification witness exited nonzero. That failure's exact assertion output was not retained. A separate clean verification run and the recorded rerun controls passed. Its cause is unclassified; it is not counted as mutation detection or as a completed measurement.

From the semantic-test-matcher root:

```sh
npm ci
node scripts/benchmark-lazy-clean.mjs ../lazy-clean benchmarks/lazy-clean-representative/results
```

An interrupted run can resume when the matcher source fingerprint is unchanged or an explicit source revalidation record matches it:

```sh
node scripts/benchmark-lazy-clean.mjs ../lazy-clean benchmarks/lazy-clean-representative/results --resume
```

The script strips `RBT_*` settings and known provider credentials, pins the target commit, checks mutation anchors, requires deterministic repeated selections, validates witness restoration, and removes its temporary checkout. The scenario definitions are in [`cases.json`](../benchmarks/lazy-clean-representative/cases.json). The source checkout is left untouched. During evaluation an unused export was removed from the matcher. All eighteen scenario/policy selections were rerun on the final committed source and matched exactly; the raw data retains both source fingerprints. A deliberately interrupted baseline prefix used to change the timing checkpoint is recorded separately and excluded from runtime comparisons.

## Implementation validation

The implementation passed TypeScript lint and build, and the full matcher suite passed **348/348** tests. All **26/26** mutation checks passed, including inverted Jaccard distance and applying the relevance cap before representative selection; their baseline and restored controls passed. These validate the implemented policy and its guarded paths, not a general claim about which bugs selected suites will catch.

The final task-owned slop scan was clean (nine TS/JS files checked against the task base), and the benchmark script's explicit scan returned `[]`. Scanning complete touched implementation/test files also found two inherited findings in the configuration JSON assertion and the test configuration object helper. They were retained outside the changed behavior; no checks were weakened to suppress them.
