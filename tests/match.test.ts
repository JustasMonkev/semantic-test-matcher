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
--- a/src/page.ts
+++ b/src/page.ts
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
--- a/src/page.ts
+++ b/src/page.ts
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
--- a/src/page.ts
+++ b/src/page.ts
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

    it('uses distinctive changed phrases when simple change tokens are generic', () => {
        const diff = `
--- a/src/config.ts
+++ b/src/config.ts
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
--- a/src/settings.ts
+++ b/src/settings.ts
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

    it('uses source identity to disambiguate a common changed identifier', () => {
        const diff = `
--- a/src/dialog.ts
+++ b/src/dialog.ts
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
        const matches = rankMatches(
            { profile: dialogProfile, vector: textToVector(dialogProfile.embeddingText) },
            [
                makeCandidate(
                    'tests/page-dialog.spec.ts',
                    `test('dialog can accept a prompt', () => dialog.accept());`,
                    cwd
                ),
                makeCandidate(
                    'tests/tracing.spec.ts',
                    `test('trace accepts downloads', () => acceptDownloads());`,
                    cwd
                ),
            ]
        );
        const dialog = matches.find((match) => match.file === 'tests/page-dialog.spec.ts');
        const tracing = matches.find((match) => match.file === 'tests/tracing.spec.ts');

        assert.ok(dialog && tracing);
        assert.ok(dialog.changeScore > tracing.changeScore);
        assert.equal(matches[0].file, 'tests/page-dialog.spec.ts');
    });
});
