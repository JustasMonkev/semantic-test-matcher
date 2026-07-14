import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDocumentProfile } from '../src/services/document-profile.ts';

describe('buildDocumentProfile', () => {
    it('places the bounded summary before verbose sections', () => {
        const tests = Array.from({ length: 500 }, (_, index) => `test('case ${index}', () => {});`).join('\n');
        const profile = buildDocumentProfile('/repo/tests/large.spec.ts', tests, '/repo');

        assert.ok(profile.embeddingText.indexOf('summary:') < profile.embeddingText.indexOf('tests:'));
    });

    it('keeps changed identifiers ahead of verbose source metadata', () => {
        const imports = Array.from(
            { length: 90 },
            (_, index) => `import { Service${index} } from '../services/service-${index}.ts';`
        ).join('\n');
        const diff = `
--- a/packages/playwright-core/src/server/page.ts
+++ b/packages/playwright-core/src/server/page.ts
@@ -1 +1,2 @@
-return await this.screenshotter.screenshotPage(progress, options);
+const screenshot = await this.screenshotter.screenshotPage(progress, options);
+return screenshot;
`;
        const profile = buildDocumentProfile(
            '/repo/packages/playwright-core/src/server/page.ts',
            `${imports}\nexport class Page {}`,
            '/repo',
            diff
        );

        assert.ok(profile.semanticTokens.includes('screenshot'));
        assert.ok(profile.embeddingText.indexOf('changes:') < profile.embeddingText.indexOf('imports:'));
    });

    it('keeps identifiers that actually changed instead of surrounding line noise', () => {
        const diff = `
--- a/src/page.ts
+++ b/src/page.ts
@@ -1 +1,2 @@
-return await this.screenshotter.screenshotPage(progress, options);
+const screenshot = await this.screenshotter.screenshotPage(progress, options);
+return screenshot;
`;
        const profile = buildDocumentProfile(
            '/repo/src/page.ts',
            'export class Page {}',
            '/repo',
            diff
        );

        assert.deepEqual(profile.changeTokens, ['screenshot']);
        assert.deepEqual(profile.changePhraseTokens, ['screenshot']);
    });

    it('scopes changed tokens to the profiled file in multi-file diffs', () => {
        const diff = `
diff --git a/src/page.ts b/src/page.ts
--- a/src/page.ts
+++ b/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
diff --git a/src/socket.ts b/src/socket.ts
--- a/src/socket.ts
+++ b/src/socket.ts
@@ -1 +1 @@
-return screenshot();
+return heartbeat();
`;
        const profile = buildDocumentProfile('/repo/src/page.ts', '', '/repo', diff);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
        assert.deepEqual(profile.changePhraseTokens, ['screenshot', 'capture']);
    });

    it('canonicalizes changed identifiers once', () => {
        const profile = buildDocumentProfile('/repo/src/cart.ts', '', '/repo', `
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1 +1,2 @@
-return oldBonuses;
+const bonuses = oldBonuses;
+return bonuses;
`);

        assert.deepEqual(profile.changeTokens, ['bonus']);
        assert.deepEqual(profile.changePhraseTokens, ['bonuses']);
    });

    it('reserves semantic space for file identity when a diff is large', () => {
        const additions = Array.from(
            { length: 120 },
            (_, index) => `+const changedSymbol${index} = ${index};`
        ).join('\n');
        const profile = buildDocumentProfile(
            '/repo/src/widget.ts',
            'export function renderDashboard() { return criticalBehavior(); }',
            '/repo',
            `--- a/src/widget.ts\n+++ b/src/widget.ts\n@@ -0,0 +1,120 @@\n${additions}`
        );

        assert.ok(profile.semanticTokens.length <= 72);
        assert.ok(profile.semanticTokens.some((token) => token.startsWith('symbol')));
        assert.ok(profile.semanticTokens.includes('widget'));
        assert.ok(profile.semanticTokens.includes('render'));
        assert.ok(profile.semanticTokens.includes('critical'));
    });

    it('bounds verbose test names in embedding input', () => {
        const tests = Array.from(
            { length: 500 },
            (_, index) => `test('page screenshot case${index}', () => {});`
        ).join('\n');
        const profile = buildDocumentProfile('/repo/tests/page-screenshot.spec.ts', tests, '/repo');
        const testSections = profile.embeddingText.split('\n').filter((line) => line.startsWith('tests:'));
        const testSection = testSections[testSections.length - 1];

        assert.ok(testSection);
        assert.ok(testSection.split(/\s+/).length <= 33);
    });

    it('bounds the complete embedding input and emits changes once', () => {
        const imports = Array.from(
            { length: 500 },
            (_, index) => `import { Service${index} } from '../service-${index}.ts';`
        ).join('\n');
        const exports = Array.from(
            { length: 500 },
            (_, index) => `export const feature${index} = ${index};`
        ).join('\n');
        const tests = Array.from(
            { length: 500 },
            (_, index) => `test('behavior case ${index}', () => command.option('--flag-${index}'));`
        ).join('\n');
        const profile = buildDocumentProfile('/repo/tests/large.spec.ts', `${imports}\n${exports}\n${tests}`, '/repo', `
--- a/tests/large.spec.ts
+++ b/tests/large.spec.ts
@@ -1 +1,2 @@
-return oldScreenshot;
+const screenshot = oldScreenshot;
+return screenshot;
`);

        assert.ok(profile.embeddingText.split(/\s+/).length <= 512);
        assert.equal(profile.embeddingText.match(/^changes:/gm)?.length, 1);
        assert.ok(profile.embeddingText.includes('signals:'));
    });

    it('keeps all no-diff section tokens when the complete input already fits', () => {
        const tests = Array.from(
            { length: 40 },
            (_, index) => `test('behavior${index}', () => {});`
        ).join('\n');
        const profile = buildDocumentProfile('/repo/tests/behavior.spec.ts', tests, '/repo');
        const testSections = profile.embeddingText.split('\n').filter((line) => line.startsWith('tests:'));

        assert.ok(profile.embeddingText.split(/\s+/).length <= 512);
        assert.match(testSections[testSections.length - 1] || '', /\bbehavior39\b/);
    });
});
