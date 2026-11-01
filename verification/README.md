# Representative selector verification experiment

This directory verifies a small **model** of the greedy selector in
`src/services/representative-selection.ts`. It changes no production behavior
and adds no runtime dependency. Lean is pinned to 4.19.0; only its bundled
standard library is used.

## Run

Install the toolchain named in `lean-toolchain`, put its `lean` executable on
PATH, then run from the repository root:

```sh
npm ci
node --experimental-strip-types verification/check.mjs
```

The GitHub Actions workflow also runs the existing lint, test and build checks.
Generated Lean fixtures and compiled files live in a temporary directory.

## Universal model guarantees

`Selection.lean` defines an executable greedy algorithm over natural-number
candidate IDs and exact, scaled natural-number distances.

- `best_le`: the chosen candidate minimizes the current step's summed cost
  among the remaining candidates. Ties retain the first candidate.
- `update_total_le`: adding a representative cannot increase the summed
  nearest-distance objective.
- `select_length`: the result has exactly `min(budget, candidate count)` entries.
- `select_subset`: every returned ID belongs to the supplied candidate pool.
- `select_nodup`: a pool of unique IDs produces unique selections.

The model accepts zero budgets; the production boundary rejects them. The
initial nearest distance is the supplied scale. Interpreting it as normalized
Jaccard distance requires distances bounded by that scale. The loop guarantees
above do not require symmetry or a metric.

The proof build treats warnings as errors and prints theorem axioms. The runner
rejects unfinished-proof and native-evaluation axioms in that output.

## Connection to the TypeScript implementation

The runner exhausts every ordered list of zero through four token sets over
`{a,b}`, with budgets from 1 through candidate count + 1. It computes exact
Jaccard distances scaled by two, runs the Lean model, and compares selected IDs
and the reported objective with the actual TypeScript selector. Empty profiles,
identical profiles, ties, insufficient budgets and the all-candidates fast path
are covered. Reversed input exercises path ordering; existing package tests
also cover relevance ordering, profile truncation and invalid inputs.

This is finite differential testing, **not a proof of TypeScript/Lean
equivalence**. Distances in this corpus are exactly representable in binary64.
General Jaccard fractions, floating-point accumulation, locale-dependent path
ordering, token extraction, the 256-token cap, candidate discovery and API
providers are outside the formal model. Unique IDs correspond to unique files
only when the input candidate paths are unique.

## What this does not establish

- Global k-median optimality or an approximation ratio: selection remains greedy.
- That selected tests catch all bugs, or that model scores are calibrated.
- A measured performance improvement or a proof about JavaScript execution time.

A future optimization can be compared with this model, but its floating-point
and tie-breaking behavior must be reviewed explicitly.
