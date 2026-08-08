# Library vs. hand-written internals — benchmarks and findings

This directory answers one question: **where could `semantic-test-matcher` drop a
hand-written implementation in favour of an existing library, and would that
actually be faster?**

Five areas of the codebase re-implement something a well-known package already
does. Each one is benchmarked against its library equivalents, with a parity
check first — a faster implementation that behaves differently is not a swap.

## Running

```bash
npm install        # inside benchmarks/, isolated from the published package
npm run setup      # generates tree-small / tree-big / tree-huge fixtures
npm run bench
```

Each suite runs in a fresh child process. Timings are medians of 7–15 samples
after warmup; `rsd` in the tables is the relative standard deviation, so treat
anything under ~1.2x with a high rsd as noise.

Numbers below were measured on Node 22.22.2, Linux x64, in a container. Ratios
are stable across runs; absolute values are not portable.

## Verdict

| Area | Current code | Library candidate | Faster? | Worth swapping? |
| --- | --- | --- | --- | --- |
| Glob matching | `src/utils/patterns.ts` | picomatch, minimatch | **No** — custom is 1.2–1.4x faster | No, unless you want more glob syntax |
| Directory walk | `src/utils/files.ts` | fdir, tinyglobby, fast-glob, `fs.glob` | **Yes** — fdir 2.6–9.9x faster | Yes on large repos, a wash on small ones |
| Bounded concurrency | `src/utils/async.ts` | p-map, p-limit | **No** — custom 3.9–9x lower overhead | No on perf; maybe on failure semantics |
| Cache lock + atomic write | `src/services/cache.ts` | proper-lockfile, write-file-atomic | **No** — within noise | No. The bottleneck is elsewhere (see below) |
| Config load + validate | `src/config.ts` | cosmiconfig, zod | **No** — both slower cold | No on perf; zod has a real correctness case |

One clear performance win out of five. Details follow.

---

## 1. Glob matching — keep the custom code

`normalizePattern` compiles glob strings to a `RegExp` by hand. picomatch (what
chokidar and fast-glob use) and minimatch do the same job with far more syntax
support.

**Parity: exact.** Over 3,240 paths, a faithful picomatch port — comma
splitting, backslash normalisation, `**/` anchoring for bare names, `nocase`,
`dot` — produced **0 disagreements** against the custom matcher on the shipped
default patterns, on user-style patterns, and on the comma-list extension.

**Performance: the custom code wins.**

```
compile a matcher from the 4 default exclude patterns
  custom        11.69 µs      —
  picomatch     22.74 µs      1.94x slower
  minimatch     44.38 µs      3.80x slower

match throughput, per path tested (pre-compiled matcher)
                       exclude set   include set   user-style set
  custom                    511 ns        203 ns          650 ns
  picomatch                 641 ns        291 ns          766 ns   (1.18–1.43x slower)
  minimatch                4.14 µs        637 ns         2.83 µs   (3.1–8.1x slower)
```

Adding picomatch would also add ~7 ms of cold import to every CLI invocation
(22.45 ms vs. a 15.32 ms `node:path` baseline) and 91 KB on disk.

**The real trade-off is expressiveness, not speed.** The custom builder silently
fails on syntax users are likely to try:

| Pattern | custom | picomatch |
| --- | --- | --- |
| `**/*.{ts,tsx}` | no match | matches |
| `src/[a-c]*.ts` | no match | matches |
| `!(node_modules)/**` | no match | matches |

These fail silently — a user writing `--exclude-file '**/*.{spec,test}.ts'` gets
zero exclusions and no warning. If that matters, swap for the syntax and accept
being ~25% slower on an operation that costs half a microsecond. Do not swap for
speed.

## 2. Directory walk — the one real win

`collectCandidateFilesDetailed` walks directories with a sequential recursive
`readdir`, awaiting one directory at a time. Every library here parallelises.

**Parity: exact.** Configured to match `files.ts` semantics (extension
allowlist, `SKIP_DIRS`, dot-directory skipping), all four libraries return
byte-identical result sets — 0 files unique to either side — except where the
`MAX_CANDIDATE_FILES = 1000` cap truncates the custom walker.

```
                      tree-small        tree-big         tree-huge
                    2,440 files      9,800 files      55,800 files
                     360 match       1,800 match      10,800 match

  custom (files.ts)    15.38 ms         36.81 ms         37.49 ms
  fdir                  2.57 ms          3.71 ms         14.62 ms    ← 6.0x / 9.9x / 2.6x faster
  tinyglobby            3.47 ms         12.15 ms         57.72 ms    ← 4.4x / 3.0x faster, then 1.5x SLOWER
  fast-glob             7.19 ms         25.30 ms        142.23 ms    ← 2.1x / 1.5x faster, then 3.8x SLOWER
  node fs.glob         50.91 ms        188.43 ms       1,174.58 ms   ← 3.3x / 5.1x / 31.3x slower
```

Two things fall out of this:

- **fdir is the only library that wins at every scale.** tinyglobby and
  fast-glob beat the custom walker on normal repos but lose badly on huge ones,
  because they must enumerate everything while the custom walker stops at 1,000
  matches. Any swap has to keep an equivalent early abort — fdir does not offer
  one out of the box, and still wins by 2.6x on the huge tree while returning
  10,800 files to the custom walker's 1,000.
- **Node's built-in `fs.glob` is not a viable replacement.** It is slower than
  the sequential hand-written walk at every size, by up to 31x. Ruled out.

**But check the size of the prize.** fdir saves ~13 ms on a small tree and
~33 ms on a big one, against a ~11 ms cold-import cost. On a typical repo that
nets out to roughly nothing; it only pays for itself on large monorepos. In the
end-to-end profile below, the walk is 9.3% of a run whose embeddings are
*stubbed out* — with real GGUF inference it is far less.

## 3. Bounded concurrency — keep the custom code

`mapWithConcurrency` is 14 lines. p-map and p-limit are the standard answers.

```
1,000 no-op async tasks (pure scheduler overhead, concurrency 8)
  custom         191 ns/task      —
  p-map          737 ns/task      3.86x slower
  p-limit       1.71 µs/task      8.95x slower

200 tasks x ~1 ms of real work
  custom        1.01 ms/task      —
  p-map         1.01 ms/task      1.00x slower
  p-limit       1.01 ms/task      1.01x slower
```

The custom scheduler has meaningfully lower overhead, and **once tasks do any
real work the difference vanishes entirely.** The actual workload here is GGUF
inference and file I/O, so this is the second row, not the first. Neither
direction is a performance argument.

There *is* a behavioural difference. When a task throws:

```
  custom (async.ts)  rejected "boom"; tasks started after the failure: 8 of 8
  p-map              rejected "boom"; tasks started after the failure: 3 of 8
```

The custom runners keep pulling from the queue after the returned promise has
already rejected — so a failing `rbt match` still pays for every remaining
embedding. p-map stops feeding the queue. That is the only real reason to
consider a swap, and it can also be fixed in place with an abort flag.

## 4. Embedding cache — no library fixes the actual problem

`cache.ts` hand-rolls an `open(…, 'wx')` lock with stale detection and a
temp-file-plus-rename atomic write. proper-lockfile and write-file-atomic are
the canonical packages.

```
append 1 entry to an existing cache
                                          50 entries   500 entries   2000 entries
                                            (1.1 MB)     (10.5 MB)      (42.0 MB)
  custom (cache.ts)                         18.97 ms     194.12 ms     1017.67 ms
  proper-lockfile + write-file-atomic       22.00 ms     180.10 ms      822.56 ms
```

The libraries are within noise of the custom code, and both are catastrophically
slow at scale. Profiling one write of a 2,000-entry cache shows why:

```
  JSON.stringify(cache, null, 2)    348.08 ms      ← pretty-printing dominates
  JSON.stringify(cache)             274.11 ms
  JSON.parse(raw)                   224.34 ms      ← paid twice per run
  fs.writeFile                       87.12 ms
  fs.readFile                        50.77 ms

  pretty-printed size: 42.04 MB
  compact size:        31.20 MB
```

**The cost is the storage format, not the locking or the write.** The cache is
one JSON object holding every 768-float vector, fully parsed on session open,
fully parsed again under the lock, then fully re-serialised with 2-space
indentation. That is O(entire cache) per `rbt match`, and no locking library
changes it. `getCacheEntryCount` in `rbt status` parses all 42 MB just to count
keys.

Things that would actually help, none of which is a dependency:

- Drop the `null, 2` indent — 42.0 MB → 31.2 MB, 348 ms → 274 ms, for free.
- Store vectors as `Float32Array` in a binary sidecar instead of JSON floats.
- Move to per-key files or an append-only log so a write is O(new entries).

## 5. Config loading and validation — no on perf, maybe on correctness

```
load .rbt/config.json
  custom (config.ts)             512.26 µs      —
  cosmiconfig (cache cleared)      1.30 ms      2.53x slower
  cosmiconfig (warm cache)        50.20 µs      10.20x faster

validate one config object
  custom (cast, no validation)    35.32 µs      —
  zod schema.parse                82.22 µs      2.33x slower
```

cosmiconfig is only faster warm, which never happens in a one-shot CLI that
loads config exactly once. It also costs ~15 ms of cold import. No reason to
swap.

zod costs ~47 µs per run plus ~44 ms of cold import and 4.4 MB on disk — the
heaviest candidate here by far. But it catches something real. `config.ts`
casts parsed JSON straight to `AppConfig` with no shape check:

```
input: {"logLevel":"verbose","match":{"topK":"five","candidatePaths":"tests"}}

custom cast  -> accepted; match.topK is the string "five",
                candidatePaths is a string
zod          -> rejected: logLevel: expected one of "debug"|"info"|"warn"|"error";
                match.topK: expected number, received string;
                match.candidatePaths: expected array, received string
```

`logLevel` does throw (`parseLogLevel`) and `topK` degrades safely
(`firstFiniteNumber` discards `"five"`), but `candidatePaths` as a string is
accepted and then iterated character by character:

```
collectCandidateFilesDetailed('tests', …)   -> { files: [], truncated: false }
collectCandidateFilesDetailed(['tests'], …) -> 11 files
```

A typo'd config yields **zero candidates and no error**. That is worth fixing —
but a dozen lines of hand-written shape checking fixes it for 0 µs and 0 KB.
Reach for zod only if config validation grows past that.

## Context: where the time actually goes

Per-area ratios mean little without the whole picture. This is a full `rbt
match` over 360 candidates with embeddings **stubbed out** — i.e. the most
favourable possible framing for these optimisations:

```
resolve config                          1.20 ms    0.5%
collect candidates (files.ts walk)     21.37 ms    9.3%   ← area 2
profile changed file                    4.83 ms    2.1%
read + profile 360 candidates         124.95 ms   54.5%   ← no library candidate
embed source (stub)                     2.01 ms    0.9%
embed 360 candidates (stub)            38.74 ms   16.9%
rank matches                           22.63 ms    9.9%   ← no library candidate
flush cache (write)                    13.51 ms    5.9%   ← area 4, small cache
TOTAL                                 229.24 ms
```

With a real GGUF model, the two embed rows grow by orders of magnitude and
everything else becomes a rounding error. The majority of the remaining time
sits in `buildDocumentProfile` and `rankMatches` — hand-written domain logic
with no library equivalent at all.

## Bottom line

Four of the five hand-written components are already faster than the libraries
that would replace them, and the fifth (the directory walk) is the only genuine
performance win — worth roughly 13–33 ms, partly eaten by import cost, on a
command dominated by model inference.

If any of these swaps happen, the argument should be **capability or
correctness**, not speed: picomatch for real glob syntax, p-map for
stop-on-error, zod for config validation. The single largest performance problem
in the codebase — the whole-file JSON embedding cache — has no library answer
and needs a format change.
