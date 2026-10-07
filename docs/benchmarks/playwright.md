# Playwright benchmark summary

Date: 2026-10-07. Playwright revision: `b9a34ac7783a1b6c2e1dfff0c08ac744c048fa59`.

## Ranker comparison

The fresh rerun used five source mutations and one compound mutation, with 100 fixed candidate files. A real Playwright runner executed 55 original test bodies across four unit spec files: the baseline and restored baseline passed, and every mutant caused test failures. Ranking used the unadapted spec files. Test bodies and failure labels were not sent to providers. No thresholds, prompts, or provider weights were tuned between the original pilot and this rerun.

| Ranker | Known failing files recovered | Mean files selected | Cold five-case run | Warm five-case run |
| --- | ---: | ---: | ---: | ---: |
| Heuristics | 5/5 | 1.8 | 0.339 s | 0.339 s |
| Jev | 5/5 | 5.4 | 4.191 s | 0.341 s |
| OpenAI Decisions | 5/5 | 7.2 | 3.719 s | 0.333 s |

Every known failing file ranked first. All three rankers also selected both known failing files for the compound mutation, selecting 3, 6, and 11 files respectively. Jev reported `jev-1.13.0`; Decisions reported `gpt-6-luna`. Each remote provider made 10 successful cold requests. Jev used 137,962 input tokens and Decisions 163,159; warm runs made zero requests with 500 cache hits per provider. Timings include CLI startup and are single observations, not latency distributions.

The other 96 candidates were not mutation-tested, so extra selections have unknown relevance, not established false-positive labels. This small pilot demonstrates interoperability and known-failure recovery, not full-suite recall or a remote-model quality advantage. Heuristics selected fewer files and had the fastest cold run. Real-CLI fallback checks recovered both compound labels when Jev credentials were omitted, then with both providers' credentials omitted; those checks cover missing credentials, not live outages.

## Matcher verification

- `npm run lint`, `npm test`, and `npm run build` passed: 320 tests across 44 suites, no failures or skips.
- The mutation harness killed 15/15 targeted mutants with passing baseline and restored controls.
- Review fixes reject oversized Jev requests before sending, reject non-`noul` answers carrying probabilities, and let an explicit local-only ranker override an inherited remote fallback.
- Three independent final review threads found no additional actionable matcher defects. This is not a guarantee of defect absence.
- The lazy-clean checker retained two reviewed findings: cache-entry counting is best-effort display metadata, and a test casts its own scorer's serialized request. Production response validation is unaffected.

## Native Playwright regressions

An isolated checkout installed its lockfile dependencies and passed its full build. All 3,122 tracked files matched the original checkout by SHA-256; the original remained clean. Environment: Node 26.5.0, macOS 26.5.2 arm64, Playwright 1.64.0-next, pinned Chromium 1247, Firefox 1551, and WebKit 2367.

| Project | Passed | Expected failure | Skipped | Unexpected |
| --- | ---: | ---: | ---: | ---: |
| Chromium library | 2,489 | 0 | 78 | 0 |
| Chromium page | 2,601 | 6 | 14 | 0 |
| Firefox library | 2,292 | 2 | 129 | 4 |
| Firefox page | 2,577 | 2 | 40 | 2 |
| WebKit library | 2,318 | 1 | 96 | 9 |
| WebKit page | 2,577 | 8 | 35 | 1 |
| **Total** | **14,854** | **19** | **392** | **16** |

The native unit directory separately passed 219/219 tests; these overlap library coverage and must not be added to the matrix as independent coverage. The matrix covers only library/page projects, not Playwright's installation, Electron, MCP, stress, or other suites.

The 16 unexpected outcomes remain recorded. Firefox cookie and keyboard failures reproduced, as did WebKit proxy and light-theme failures. Firefox's before-unload failure and two WebKit download timeouts passed focused reruns, which do not erase the initial failures. Both Firefox and WebKit projects also had a Chromium trace-viewer color-scheme failure. The host used Dark appearance; no system setting, browser preference, or assertion was changed to obtain passing results.

Two invocation mistakes were corrected before canonical reruns: conflicting color environment variables caused a warning-sensitive subprocess to exit, and external test-output directories prevented the trace viewer from serving generated traces. Sandboxed browser runs could not bind local servers or bootstrap Chromium, so valid runs used unsandboxed execution. The first Chromium installation also used the standard browser cache and automatically removed older unused revision 1231 binaries; later installs used an isolated cache. Those older binaries were not restored because an exact local installer was unavailable.

## Reproduction

Raw JSON, compressed reports, and API audit logs are retained locally, not committed. Use a new output directory so the cold run starts with an empty cache:

```sh
node benchmarks/playwright-mutations/prepare.mjs /path/to/playwright /path/to/node_modules/@playwright/test /tmp/rbt-playwright-new-run
node benchmarks/playwright-mutations/run.mjs /tmp/rbt-playwright-new-run heuristics
node --env-file=.env benchmarks/playwright-mutations/run.mjs /tmp/rbt-playwright-new-run jev
node --env-file=.env benchmarks/playwright-mutations/run.mjs /tmp/rbt-playwright-new-run decisions
node --env-file=.env benchmarks/playwright-mutations/verify-fallback.mjs /tmp/rbt-playwright-new-run
node scripts/mutation-check.mjs --output /tmp/rbt-mutations.json
```

For native tests, use a separate Playwright checkout, run `npm ci --ignore-scripts --no-audit --no-fund` and `npm run build`, and install its pinned browsers into an isolated `PLAYWRIGHT_BROWSERS_PATH`. From that checkout:

```sh
env -u OPEN_AI -u JEF -u OPENAI_API_KEY -u TYPESAFE_API_KEY -u NO_COLOR -u FORCE_COLOR \
  PLAYWRIGHT_BROWSERS_PATH=/path/to/pinned-browser-cache \
  ./node_modules/.bin/playwright test \
  --config=tests/library/playwright.config.ts \
  --project=firefox-page --workers=6 --reporter=json \
  --output=/path/to/isolated-playwright/.rbt-test-results/firefox-page
```

Repeat for the six library/page projects. Chromium library used four workers; the other projects used six. Keep test output inside the isolated checkout for trace-viewer file access. Native browser tests do not need API credentials.
