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
--- packages/playwright-core/src/server/page.ts
+++ packages/playwright-core/src/server/page.ts
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
--- src/page.ts
+++ src/page.ts
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

    it('accepts custom git diff prefixes', () => {
        const profile = buildDocumentProfile('/repo/src/page.ts', '', '/repo', `
diff --git old/source/src/page.ts new/destination/src/page.ts
--- old/source/src/page.ts
+++ new/destination/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('accepts git diff paths containing spaces', () => {
        const profile = buildDocumentProfile('/repo/src dir/page file.ts', '', '/repo', `
diff --git a/src dir/page file.ts b/src dir/page file.ts
--- a/src dir/page file.ts
+++ b/src dir/page file.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('strips complete multi-segment custom git prefixes', () => {
        const profile = buildDocumentProfile('/repo/src/page.ts', '', '/repo', `
diff --git a/old/src/page.ts b/new/src/page.ts
--- a/old/src/page.ts
+++ b/new/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('accepts renamed files in standard git diffs', () => {
        const profile = buildDocumentProfile('/repo/src/new.ts', '', '/repo', `
diff --git a/src/old.ts b/src/new.ts
similarity index 80%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('accepts renamed files with custom git prefixes', () => {
        const profile = buildDocumentProfile('/repo/src/new.ts', '', '/repo', `
diff --git old/src/old.ts new/src/new.ts
similarity index 80%
rename from src/old.ts
rename to src/new.ts
--- old/src/old.ts
+++ new/src/new.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('accepts spaced custom prefixes and filenames in rename diffs', () => {
        const profile = buildDocumentProfile('/repo/src/new file.ts', '', '/repo', `
diff --git old tree/src/old file.ts new tree/src/new file.ts
similarity index 80%
rename from src/old file.ts
rename to src/new file.ts
--- old tree/src/old file.ts
+++ new tree/src/new file.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('does not infer prefixes from partial filename suffixes', () => {
        const diff = `
diff --git oldfile.ts newfile.ts
--- oldfile.ts
+++ newfile.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;
        const target = buildDocumentProfile('/repo/newfile.ts', '', '/repo', diff);
        const unrelated = buildDocumentProfile('/repo/file.ts', '', '/repo', diff);

        assert.deepEqual(target.changeTokens, ['screenshot', 'capture']);
        assert.deepEqual(unrelated.changeTokens, []);
    });

    it('preserves real top-level paths in no-prefix rename diffs', () => {
        const diff = `
diff --git a/src/old.ts b/src/new.ts
similarity index 80%
rename from a/src/old.ts
rename to b/src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;
        const target = buildDocumentProfile('/repo/b/src/new.ts', '', '/repo', diff);
        const unrelated = buildDocumentProfile('/repo/src/new.ts', '', '/repo', diff);

        assert.deepEqual(target.changeTokens, ['screenshot', 'capture']);
        assert.deepEqual(unrelated.changeTokens, []);
    });

    it('unescapes Git-quoted paths before matching', () => {
        const profile = buildDocumentProfile('/repo/src/café.ts', '', '/repo', `
diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
--- "a/src/caf\\303\\251.ts"
+++ "b/src/caf\\303\\251.ts"
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('matches repo-root git paths when run from a subdirectory', () => {
        const profile = buildDocumentProfile('/repo/packages/foo/src/page.ts', '', '/repo/packages/foo', `
diff --git a/packages/foo/src/page.ts b/packages/foo/src/page.ts
--- a/packages/foo/src/page.ts
+++ b/packages/foo/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('does not treat parent directories as custom git prefixes', () => {
        const diff = `
diff --git a/packages/foo/src/page.ts b/packages/foo/src/page.ts
--- a/packages/foo/src/page.ts
+++ b/packages/foo/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;
        const target = buildDocumentProfile('/repo/packages/foo/src/page.ts', '', '/repo', diff);
        const unrelated = buildDocumentProfile('/repo/src/page.ts', '', '/repo', diff);

        assert.deepEqual(target.changeTokens, ['screenshot', 'capture']);
        assert.deepEqual(unrelated.changeTokens, []);
    });

    it('does not infer custom prefixes from another file path suffix', () => {
        const diff = `
diff --git old/packages/foo/src/page.ts new/packages/foo/src/page.ts
--- old/packages/foo/src/page.ts
+++ new/packages/foo/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;
        const target = buildDocumentProfile('/repo/packages/foo/src/page.ts', '', '/repo', diff);
        const unrelated = buildDocumentProfile('/repo/src/page.ts', '', '/repo', diff);

        assert.deepEqual(target.changeTokens, ['screenshot', 'capture']);
        assert.deepEqual(unrelated.changeTokens, []);
    });

    it('treats header-like lines inside hunks as changed content', () => {
        const profile = buildDocumentProfile('/repo/src/template.ts', '', '/repo', `
--- src/template.ts
+++ src/template.ts
@@ -1 +1 @@
--- section
+const screenshot = true;
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'section']);
        assert.deepEqual(profile.changePhraseTokens, ['screenshot', 'section']);
    });

    it('accepts timestamps in plain unified diff headers', () => {
        const profile = buildDocumentProfile('/repo/src/page.ts', '', '/repo', `
--- src/page.ts\t2026-07-14 10:00:00
+++ src/page.ts\t2026-07-14 10:01:00
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('accepts absolute paths in plain unified diff headers', () => {
        const profile = buildDocumentProfile('/repo/src/page.ts', '', '/repo', `
--- /repo/src/page.ts
+++ /repo/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('preserves real top-level a and b path segments in no-prefix diffs', () => {
        const diff = `
diff --git a/src/page.ts a/src/page.ts
--- a/src/page.ts
+++ a/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;
        const target = buildDocumentProfile('/repo/a/src/page.ts', '', '/repo', diff);
        const unrelated = buildDocumentProfile('/repo/src/page.ts', '', '/repo', diff);

        assert.deepEqual(target.changeTokens, ['screenshot', 'capture']);
        assert.deepEqual(unrelated.changeTokens, []);
    });

    it('preserves real top-level path segments in plain unified diffs', () => {
        const diff = `
--- a/src/page.ts
+++ a/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;
        const target = buildDocumentProfile('/repo/a/src/page.ts', '', '/repo', diff);
        const unrelated = buildDocumentProfile('/repo/src/page.ts', '', '/repo', diff);

        assert.deepEqual(target.changeTokens, ['screenshot', 'capture']);
        assert.deepEqual(unrelated.changeTokens, []);
    });

    it('accepts paired a and b headers in plain unified diffs', () => {
        const profile = buildDocumentProfile('/repo/src/page.ts', '', '/repo', `
--- a/src/page.ts
+++ b/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('scopes concatenated plain unified diffs by file', () => {
        const profile = buildDocumentProfile('/repo/src/page.ts', '', '/repo', `
--- src/page.ts
+++ src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
--- src/socket.ts
+++ src/socket.ts
@@ -1 +1 @@
-return reconnect();
+return heartbeat();
`);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('canonicalizes changed identifiers once', () => {
        const profile = buildDocumentProfile('/repo/src/cart.ts', '', '/repo', `
--- src/cart.ts
+++ src/cart.ts
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
            `--- src/widget.ts\n+++ src/widget.ts\n@@ -0,0 +1,120 @@\n${additions}`
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
--- tests/large.spec.ts
+++ tests/large.spec.ts
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
