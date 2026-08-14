import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cosineSimilarity, filterMatches, rankMatches, type RankedMatchCandidate } from '../src/services/match.ts';
import { buildDocumentProfile } from '../src/services/document-profile.ts';
import { textToVector } from '../src/services/text-utils.ts';

const PRICE_ENGINE_SOURCE = `
export function applyDiscount(order: Order, coupon: Coupon): number {
    return order.total - coupon.amount;
}

export function calculateTax(order: Order, region: Region): number {
    return order.total * region.taxRate;
}
`;

const PRICE_ENGINE_TEST = `
import { applyDiscount, calculateTax } from '../src/price-engine.ts';

describe('price engine', () => {
    it('applies coupon discounts to the order total', () => {
        expect(applyDiscount(order, coupon)).toBe(90);
    });

    it('calculates regional tax for the order', () => {
        expect(calculateTax(order, region)).toBeCloseTo(8.25);
    });
});
`;

const UNRELATED_TEST = `
import { reconnectSocket } from '../src/socket-client.ts';

describe('socket client', () => {
    it('reconnects after a heartbeat timeout', () => {
        expect(reconnectSocket(session)).toBe(true);
    });
});
`;

function makeCandidate(file: string, text: string, cwd: string): RankedMatchCandidate {
    const profile = buildDocumentProfile(`${cwd}/${file}`, text, cwd);
    return {
        file,
        vector: textToVector(profile.embeddingText),
        preview: profile.preview,
        profile,
    };
}

describe('cosineSimilarity', () => {
    it('returns 1 for identical unit vectors and 0 for orthogonal ones', () => {
        assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
        assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    });

    it('rejects empty and mismatched-length vectors', () => {
        assert.equal(cosineSimilarity([], [1, 2]), 0);
        assert.equal(cosineSimilarity([1, 0, 0.5], [1, 0]), 0);
    });
});

describe('rankMatches', () => {
    const cwd = '/repo';
    const sourceProfile = buildDocumentProfile(`${cwd}/src/price-engine.ts`, PRICE_ENGINE_SOURCE, cwd);
    const source = { profile: sourceProfile, vector: textToVector(sourceProfile.embeddingText) };

    it('ranks the related test above an unrelated test', () => {
        const matches = rankMatches(source, [
            makeCandidate('tests/socket-client.test.ts', UNRELATED_TEST, cwd),
            makeCandidate('tests/price-engine.test.ts', PRICE_ENGINE_TEST, cwd),
        ]);

        assert.equal(matches[0].file, 'tests/price-engine.test.ts');
        assert.ok(matches[0].score > matches[1].score);
    });

    it('separates a related test from an unrelated test at the default threshold', () => {
        const matches = rankMatches(source, [
            makeCandidate('tests/socket-client.test.ts', UNRELATED_TEST, cwd),
            makeCandidate('tests/price-engine.test.ts', PRICE_ENGINE_TEST, cwd),
        ]);

        assert.deepEqual(filterMatches(matches, 0.45).map((match) => match.file), [
            'tests/price-engine.test.ts',
        ]);
    });

    it('returns scores and component scores within [0, 1]', () => {
        const matches = rankMatches(source, [
            makeCandidate('tests/price-engine.test.ts', PRICE_ENGINE_TEST, cwd),
        ]);

        const [match] = matches;
        for (const value of [match.score, match.structuralScore, match.anchorScore, match.phraseScore]) {
            assert.ok(value >= 0 && value <= 1, `score out of range: ${value}`);
        }
    });

    const COMPONENT_KEYS = [
        'score',
        'structuralScore',
        'embeddingScore',
        'stemScore',
        'basenameScore',
        'semanticScore',
        'anchorScore',
        'interfaceScore',
        'phraseScore',
        'pathFamilyScore',
        'changeScore',
    ] as const;

    it('keeps every reported component finite and within [0, 1] with and without a diff', () => {
        const diff = [
            '--- src/price-engine.ts',
            '+++ src/price-engine.ts',
            '@@ -1 +1 @@',
            '-return order.total;',
            '+return calculateTax(order, region);',
            '',
        ].join('\n');
        const changedProfile = buildDocumentProfile(`${cwd}/src/price-engine.ts`, PRICE_ENGINE_SOURCE, cwd, diff);
        const candidates = [
            makeCandidate('tests/price-engine.test.ts', PRICE_ENGINE_TEST, cwd),
            makeCandidate('tests/socket-client.test.ts', UNRELATED_TEST, cwd),
        ];

        for (const ranked of [
            rankMatches(source, candidates),
            rankMatches({ profile: changedProfile, vector: textToVector(changedProfile.embeddingText) }, candidates),
        ]) {
            for (const match of ranked) {
                for (const key of COMPONENT_KEYS) {
                    const value = match[key];
                    assert.ok(Number.isFinite(value), `${match.file}.${key} is not finite: ${value}`);
                    assert.ok(value >= 0 && value <= 1, `${match.file}.${key} out of range: ${value}`);
                }
            }
        }
    });

    // Nothing else in this suite fails if the embedding term is dropped from the
    // blend, because structure alone already orders the fixtures correctly.
    it('lets embedding similarity break a tie between structurally identical candidates', () => {
        const sharedProfile = buildDocumentProfile(`${cwd}/tests/shared.test.ts`, PRICE_ENGINE_TEST, cwd);
        const matches = rankMatches(
            { profile: sourceProfile, vector: [1, 0] },
            [
                { file: 'tests/orthogonal.test.ts', vector: [0, 1], preview: '', profile: sharedProfile },
                { file: 'tests/aligned.test.ts', vector: [1, 0], preview: '', profile: sharedProfile },
            ]
        );
        const aligned = matches.find((match) => match.file === 'tests/aligned.test.ts');
        const orthogonal = matches.find((match) => match.file === 'tests/orthogonal.test.ts');

        assert.ok(aligned && orthogonal);
        assert.equal(aligned.structuralScore, orthogonal.structuralScore);
        assert.equal(aligned.embeddingScore, 1);
        assert.equal(orthogonal.embeddingScore, 0);
        assert.ok(
            aligned.score > orthogonal.score,
            'embedding similarity must still contribute to the blended score'
        );
        assert.equal(matches[0].file, 'tests/aligned.test.ts');
    });

    it('scores an unrelated candidate with a zero vector without producing NaN', () => {
        const candidate = makeCandidate('tests/socket-client.test.ts', UNRELATED_TEST, cwd);
        const matches = rankMatches(
            { profile: sourceProfile, vector: [0, 0, 0] },
            [{ ...candidate, vector: [0, 0, 0] }]
        );

        assert.equal(matches[0].embeddingScore, 0);
        assert.ok(Number.isFinite(matches[0].score));
    });

    it('treats a mismatched-length candidate vector as zero similarity', () => {
        const candidate = makeCandidate('tests/price-engine.test.ts', PRICE_ENGINE_TEST, cwd);
        const matches = rankMatches({ profile: sourceProfile, vector: [1, 0] }, [{ ...candidate, vector: [1, 0, 0] }]);

        assert.equal(matches[0].embeddingScore, 0);
        assert.ok(matches[0].score > 0, 'structural signal should still be scored');
    });

    // An option-heavy entrypoint (a CLI surface) is expected to pull config-shaped
    // tests up even when it shares little else with them.
    it('boosts a config-path candidate for an option-heavy source', () => {
        const cliSource = buildDocumentProfile(
            `${cwd}/src/cli-entry.ts`,
            `program
                .option('--browser-name <name>')
                .option('--test-id-attribute <attr>')
                .option('--output-dir <dir>')
                .option('--connect-timeout <ms>')
                .option('--headless-mode <mode>')
                .option('--trace-level <level>');`,
            cwd
        );
        const configCandidate = makeCandidate(
            'tests/config/resolve-config.test.ts',
            "describe('config resolution', () => { it('reads the browser name option', () => resolveConfig()); });",
            cwd
        );
        const plainCandidate = makeCandidate('tests/socket-client.test.ts', UNRELATED_TEST, cwd);

        const matches = rankMatches(
            { profile: cliSource, vector: textToVector(cliSource.embeddingText) },
            [plainCandidate, configCandidate]
        );
        const config = matches.find((match) => match.file === 'tests/config/resolve-config.test.ts');
        const plain = matches.find((match) => match.file === 'tests/socket-client.test.ts');

        assert.ok(config && plain);
        assert.ok(config.interfaceScore >= 0.58, `interfaceScore was ${config.interfaceScore}`);
        assert.ok(config.score > plain.score);
        assert.equal(matches[0].file, 'tests/config/resolve-config.test.ts');
    });

    it('weights long, numeric, and anchor-like tokens above plain ones', () => {
        const numericSource = buildDocumentProfile(
            `${cwd}/src/protocol.ts`,
            'export const browserName = "chromium"; export const retryAfter2Seconds = 2;',
            cwd
        );
        const sharing = makeCandidate(
            'tests/protocol.test.ts',
            "describe('protocol', () => { it('uses browserName and retryAfter2Seconds', () => check(browserName, retryAfter2Seconds)); });",
            cwd
        );
        const unrelated = makeCandidate('tests/socket-client.test.ts', UNRELATED_TEST, cwd);

        const matches = rankMatches(
            { profile: numericSource, vector: textToVector(numericSource.embeddingText) },
            [unrelated, sharing]
        );

        assert.equal(matches[0].file, 'tests/protocol.test.ts');
        assert.ok(matches[0].phraseScore > 0);
    });

    it('produces identical results when ranked twice', () => {
        const candidates = [
            makeCandidate('tests/socket-client.test.ts', UNRELATED_TEST, cwd),
            makeCandidate('tests/price-engine.test.ts', PRICE_ENGINE_TEST, cwd),
        ];

        assert.deepEqual(rankMatches(source, candidates), rankMatches(source, candidates));
    });
});

describe('filterMatches', () => {
    const cwd = '/repo';
    const sourceProfile = buildDocumentProfile(`${cwd}/src/price-engine.ts`, PRICE_ENGINE_SOURCE, cwd);
    const source = { profile: sourceProfile, vector: textToVector(sourceProfile.embeddingText) };
    const candidates = [
        makeCandidate('tests/price-engine.test.ts', PRICE_ENGINE_TEST, cwd),
        makeCandidate('tests/socket-client.test.ts', UNRELATED_TEST, cwd),
    ];

    it('keeps a candidate whose score is exactly the minimum', () => {
        const matches = rankMatches(source, candidates);
        const exact = matches[0].score;

        assert.ok(filterMatches(matches, exact).some((match) => match.file === matches[0].file));
    });

    it('drops a candidate just below the minimum', () => {
        const matches = rankMatches(source, candidates);
        const justAbove = matches[0].score + Number.EPSILON * 8;

        assert.ok(!filterMatches(matches, justAbove).some((match) => match.file === matches[0].file));
    });

    it('keeps everything at a minimum of zero', () => {
        const matches = rankMatches(source, candidates);

        assert.equal(filterMatches(matches, 0).length, matches.length);
    });

    it('returns an empty list for an unreachable minimum', () => {
        assert.deepEqual(filterMatches(rankMatches(source, candidates), 1.0000001), []);
    });

    it('preserves ranking order', () => {
        const matches = rankMatches(source, candidates);

        assert.deepEqual(
            filterMatches(matches, 0).map((match) => match.file),
            matches.map((match) => match.file)
        );
    });

    it('breaks score ties by file name for stable output', () => {
        const candidateA = makeCandidate('tests/a.test.ts', UNRELATED_TEST, cwd);
        const candidateB = { ...candidateA, file: 'tests/b.test.ts' };
        const matches = rankMatches(source, [candidateB, candidateA]);
        assert.deepEqual(matches.map((match) => match.file), ['tests/a.test.ts', 'tests/b.test.ts']);
    });

    it('returns an empty list for no candidates', () => {
        assert.deepEqual(rankMatches(source, []), []);
    });

    it('scores tests for changed symbols above unrelated source anchors', () => {
        const diff = `
--- src/page.ts
+++ src/page.ts
@@ -1 +1,2 @@
-return await this.screenshotter.screenshotPage(progress, options);
+const screenshot = await this.screenshotter.screenshotPage(progress, options);
+return screenshot;
`;
        const pageProfile = buildDocumentProfile(
            `${cwd}/src/page.ts`,
            `
export function getByTestIdSelector() {}
export class Page {
    async screenshot(progress, options) {
        return await this.screenshotter.screenshotPage(progress, options);
    }
}
`,
            cwd,
            diff
        );
        const matches = rankMatches(
            { profile: pageProfile, vector: [1, 0] },
            [
                makeCandidate(
                    'tests/page-screenshot.spec.ts',
                    `test('page screenshot captures image', async () => page.screenshot());`,
                    cwd
                ),
                makeCandidate(
                    'tests/codegen.spec.ts',
                    `test('getByTestId selector codegen output', () => {});`,
                    cwd
                ),
            ].map((candidate) => ({ ...candidate, vector: [1, 0] }))
        );
        const screenshot = matches.find((match) => match.file === 'tests/page-screenshot.spec.ts');
        const codegen = matches.find((match) => match.file === 'tests/codegen.spec.ts');

        assert.ok(screenshot && codegen);
        assert.ok(screenshot.changeScore > codegen.changeScore);
    });

    it('prefers a changed symbol in the test filename over generic diff parameters', () => {
        const diff = `
--- src/page.ts
+++ src/page.ts
@@ -1 +1,2 @@
-return await this.screenshotter.screenshotPage(progress, options);
+const screenshot = await this.screenshotter.screenshotPage(progress, options);
+return screenshot;
`;
        const pageProfile = buildDocumentProfile(
            `${cwd}/src/page.ts`,
            `export class Page { async screenshot(progress, options) {} }`,
            cwd,
            diff
        );
        const matches = rankMatches(
            { profile: pageProfile, vector: [1, 0] },
            [
                makeCandidate(
                    'tests/page/page-screenshot.spec.ts',
                    `test('page screenshot', () => {});`,
                    cwd
                ),
                makeCandidate(
                    'tests/page/page-options.spec.ts',
                    `test('page options progress', () => {});`,
                    cwd
                ),
            ].map((candidate) => ({ ...candidate, vector: [1, 0] }))
        );
        const screenshot = matches.find((match) => match.file === 'tests/page/page-screenshot.spec.ts');
        const options = matches.find((match) => match.file === 'tests/page/page-options.spec.ts');

        assert.ok(screenshot && options);
        assert.ok(screenshot.changeScore > options.changeScore);
    });

    it('ranks a direct caller of changed APIs above a one-token filename match', () => {
        const diff = `
--- src/page.ts
+++ src/page.ts
@@ -1 +1,2 @@
-return await capture();
+const screenshot = await capture();
+return screenshotWithTimeout(screenshot);
`;
        const pageProfile = buildDocumentProfile(
            `${cwd}/src/page.ts`,
            'export class Page { screenshot(timeout) { return screenshotWithTimeout(timeout); } }',
            cwd,
            diff
        );
        const matches = rankMatches(
            { profile: pageProfile, vector: textToVector(pageProfile.embeddingText) },
            [
                makeCandidate(
                    'tests/api-behavior.spec.ts',
                    `test('captures output', async () => page.screenshot({ timeout: 1000 }));`,
                    cwd
                ),
                makeCandidate(
                    'tests/timeout.spec.ts',
                    `test('timeout', async () => waitForTimeout());`,
                    cwd
                ),
            ]
        );

        assert.equal(matches[0].file, 'tests/api-behavior.spec.ts');
        assert.ok(matches[0].changeScore > matches[1].changeScore);
    });

    it('keeps direct-call evidence after the first 64 content tokens', () => {
        const diff = `
--- src/page.ts
+++ src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;
        const pageProfile = buildDocumentProfile(
            `${cwd}/src/page.ts`,
            'export function screenshot() {}',
            cwd,
            diff
        );
        const setup = Array.from({ length: 80 }, (_, index) => `feature${index}();`).join('\n');
        const tail = Array.from({ length: 140 }, (_, index) => `trailing${index}();`).join('\n');
        const directCandidate = makeCandidate(
            'tests/late-direct-call.spec.ts',
            `test('late behavior', () => {\n${setup}\nscreenshot();\n${tail}\n});`,
            cwd
        );
        const matches = rankMatches(
            { profile: pageProfile, vector: [1, 0] },
            [
                directCandidate,
                makeCandidate(
                    'tests/unrelated.spec.ts',
                    `test('other behavior', () => {\n${setup}\nheartbeat();\n${tail}\nheartbeat();\n});`,
                    cwd
                ),
            ].map((candidate) => ({ ...candidate, vector: [1, 0] }))
        );
        const direct = matches.find((match) => match.file === 'tests/late-direct-call.spec.ts');
        const unrelated = matches.find((match) => match.file === 'tests/unrelated.spec.ts');

        assert.ok(directCandidate.profile.contentTokens.length <= 64);
        assert.ok(directCandidate.profile.lateCallTokens.includes('screenshot'));
        assert.ok(direct && unrelated);
        assert.ok(direct.changeScore > 0);
        assert.ok(direct.changeScore > unrelated.changeScore);
    });

    it('does not award change credit for source-stem matches alone', () => {
        const diff = `
--- src/page.ts
+++ src/page.ts
@@ -1 +1,2 @@
-return capture();
+const screenshot = capture();
+return screenshot;
`;
        const pageProfile = buildDocumentProfile(
            `${cwd}/src/page.ts`,
            'export class Page { screenshot() {} }',
            cwd,
            diff
        );
        const matches = rankMatches(
            { profile: pageProfile, vector: [1, 0] },
            [
                makeCandidate(
                    'tests/page-options.spec.ts',
                    `test('uses page options', () => configureOptions());`,
                    cwd
                ),
                makeCandidate(
                    'tests/api-behavior.spec.ts',
                    `test('captures an image', () => screenshot());`,
                    cwd
                ),
            ].map((candidate) => ({ ...candidate, vector: [1, 0] }))
        );
        const stemOnly = matches.find((match) => match.file === 'tests/page-options.spec.ts');
        const direct = matches.find((match) => match.file === 'tests/api-behavior.spec.ts');

        assert.ok(stemOnly && direct);
        assert.equal(stemOnly.changeScore, 0);
        assert.ok(direct.changeScore > stemOnly.changeScore);
    });

    it('uses distinctive changed phrases when simple change tokens are generic', () => {
        const diff = `
--- src/config.ts
+++ src/config.ts
@@ -1 +1,2 @@
-return selector;
+const testIdAttributeName = selector;
+return testIdAttributeName;
`;
        const configProfile = buildDocumentProfile(
            `${cwd}/src/config.ts`,
            'export const testIdAttributeName = selector;',
            cwd,
            diff
        );
        const matches = rankMatches(
            { profile: configProfile, vector: textToVector(configProfile.embeddingText) },
            [
                makeCandidate(
                    'tests/codegen.spec.ts',
                    `test('uses getByTestId codegen', () => getByTestId());`,
                    cwd
                ),
                makeCandidate(
                    'tests/network.spec.ts',
                    `test('sends request', () => request());`,
                    cwd
                ),
            ]
        );

        assert.deepEqual(configProfile.changeTokens, []);
        assert.equal(matches[0].file, 'tests/codegen.spec.ts');
        assert.ok(matches[0].changeScore > 0);
    });

    it('matches changed camel-case APIs that only survive as phrase tokens', () => {
        const diff = `
--- src/settings.ts
+++ src/settings.ts
@@ -1 +1 @@
-return config;
+return getConfig();
`;
        const settingsProfile = buildDocumentProfile(
            `${cwd}/src/settings.ts`,
            'export function getConfig() {}',
            cwd,
            diff
        );
        const matches = rankMatches(
            { profile: settingsProfile, vector: [1, 0] },
            [
                makeCandidate(
                    'tests/settings-api.spec.ts',
                    `test('loads settings', () => getConfig());`,
                    cwd
                ),
                makeCandidate(
                    'tests/settings-storage.spec.ts',
                    `test('loads settings', () => readConfig());`,
                    cwd
                ),
            ].map((candidate) => ({ ...candidate, vector: [1, 0] }))
        );
        const direct = matches.find((match) => match.file === 'tests/settings-api.spec.ts');
        const unrelated = matches.find((match) => match.file === 'tests/settings-storage.spec.ts');

        assert.deepEqual(settingsProfile.changeTokens, []);
        assert.deepEqual(settingsProfile.changePhraseTokens, ['getconfig']);
        assert.ok(direct && unrelated);
        assert.ok(direct.changeScore > 0);
        assert.ok(direct.changeScore > unrelated.changeScore);
    });

    it('uses late source identity to disambiguate a common changed identifier', () => {
        const diff = `
--- src/dialog.ts
+++ src/dialog.ts
@@ -1 +1,2 @@
-return this._accept();
+const accept = this._accept();
+return accept;
`;
        const dialogProfile = buildDocumentProfile(
            `${cwd}/src/dialog.ts`,
            'export class Dialog { accept() {} }',
            cwd,
            diff
        );
        const setup = Array.from({ length: 80 }, (_, index) => `feature${index}();`).join('\n');
        const matches = rankMatches(
            { profile: dialogProfile, vector: textToVector(dialogProfile.embeddingText) },
            [
                makeCandidate(
                    'tests/prompt.spec.ts',
                    `test('accepts a prompt', () => {\n${setup}\ndialog.accept();\n});`,
                    cwd
                ),
                makeCandidate(
                    'tests/tracing.spec.ts',
                    `test('accepts downloads', () => {\n${setup}\nacceptDownloads();\n});`,
                    cwd
                ),
            ]
        );
        const dialog = matches.find((match) => match.file === 'tests/prompt.spec.ts');
        const tracing = matches.find((match) => match.file === 'tests/tracing.spec.ts');

        assert.ok(dialog && tracing);
        assert.ok(dialog.changeScore > tracing.changeScore);
        assert.equal(matches[0].file, 'tests/prompt.spec.ts');
    });
});
