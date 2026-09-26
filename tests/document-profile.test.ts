import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildDocumentProfile, listDiffFiles } from '../src/services/document-profile.ts';

describe('buildDocumentProfile', () => {
    it('keeps raw test titles, including describe blocks and modifiers', () => {
        const profile = buildDocumentProfile(
            '/workspace/tests/tabs.spec.ts',
            [
                "test.describe('tab management', () => {",
                "    test('selects a tab by index', async () => {});",
                '    test.skip("closes the last tab", async () => {});',
                "    it('selects a tab by index', () => {});",
                '});',
            ].join('\n'),
            '/workspace'
        );

        assert.deepEqual(profile.testTitles, ['tab management', 'selects a tab by index', 'closes the last tab']);
    });

    it('keeps the profiled file\'s own diff hunks as an excerpt', () => {
        const diff = [
            'diff --git a/src/tabs.ts b/src/tabs.ts',
            '--- a/src/tabs.ts',
            '+++ b/src/tabs.ts',
            '@@ -2,2 +2,2 @@ export function selectTab(index: number) {',
            '     const tab = tabs[index];',
            '-    return index && tab;',
            '+    return tab;',
            'diff --git a/src/other.ts b/src/other.ts',
            '--- a/src/other.ts',
            '+++ b/src/other.ts',
            '@@ -1 +1 @@',
            '-export const other = 1;',
            '+export const other = 2;',
        ].join('\n');
        const source = 'export function selectTab(index: number) {\n    const tab = tabs[index];\n    return tab;\n}\n';

        assert.equal(
            buildDocumentProfile('/workspace/src/tabs.ts', source, '/workspace', diff).diffExcerpt,
            [
                '@@ -2,2 +2,2 @@ export function selectTab(index: number) {',
                '     const tab = tabs[index];',
                '-    return index && tab;',
                '+    return tab;',
            ].join('\n')
        );
        assert.equal(buildDocumentProfile('/workspace/src/tabs.ts', source, '/workspace').diffExcerpt, '');
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

    it('attributes plain-diff hunks labelled against /dev/null to the unlabelled path', () => {
        const diff = [
            '--- /dev/null',
            '+++ b/src/created.ts',
            '@@ -0,0 +1 @@',
            '+export const createdTotal = 1;',
            '--- a/src/gone.ts',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-export const goneTotal = 1;',
        ].join('\n');

        assert.equal(
            buildDocumentProfile('/repo/src/created.ts', '', '/repo', diff, '.').diffExcerpt,
            '@@ -0,0 +1 @@\n+export const createdTotal = 1;'
        );
        assert.equal(
            buildDocumentProfile('/repo/src/gone.ts', '', '/repo', diff, '.').diffExcerpt,
            '@@ -1 +0,0 @@\n-export const goneTotal = 1;'
        );
    });

    it('treats files under __tests__ as tests', () => {
        assert.equal(buildDocumentProfile('/repo/src/__tests__/checkout.ts', '', '/repo').kind, 'test');
        assert.equal(buildDocumentProfile('/repo/src/checkout.ts', '', '/repo').kind, 'source');
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

    it('accepts diff-root-relative Git paths containing spaces', () => {
        const profile = buildDocumentProfile('/repo/packages/foo/src dir/page file.ts', '', '/repo', `
diff --git a/src dir/page file.ts b/src dir/page file.ts
--- a/src dir/page file.ts
+++ b/src dir/page file.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`, '/repo/packages/foo');

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

    it('preserves directory moves in standard no-index diffs', () => {
        const diff = `
diff --git a/old/src/page.ts b/new/lib/page.ts
--- a/old/src/page.ts
+++ b/new/lib/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;
        const target = buildDocumentProfile('/repo/new/lib/page.ts', '', '/repo', diff);
        const basenameOnly = buildDocumentProfile('/repo/page.ts', '', '/repo', diff);

        assert.deepEqual(target.changeTokens, ['screenshot', 'capture']);
        assert.deepEqual(basenameOnly.changeTokens, []);
    });

    it('does not strip real top-level dirs onto an existing suffix path', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-profile-'));
        try {
            await fs.mkdir(path.join(root, 'new/src'), { recursive: true });
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(path.join(root, 'new/src/page.ts'), 'export const screenshot = true;');
            await fs.writeFile(path.join(root, 'src/page.ts'), 'export const unrelated = true;');
            const diff = `
diff --git old/src/page.ts new/src/page.ts
--- old/src/page.ts
+++ new/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;

            const target = buildDocumentProfile(path.join(root, 'new/src/page.ts'), '', root, diff);
            const unrelated = buildDocumentProfile(path.join(root, 'src/page.ts'), '', root, diff);

            assert.deepEqual(target.changeTokens, ['screenshot', 'capture']);
            assert.deepEqual(unrelated.changeTokens, []);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('strips canonical Git prefixes when matching top-level dirs exist', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-profile-'));
        try {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.mkdir(path.join(root, 'b/src'), { recursive: true });
            await fs.writeFile(path.join(root, 'src/page.ts'), 'export const screenshot = true;');
            await fs.writeFile(path.join(root, 'b/src/page.ts'), 'export const unrelated = true;');
            const diff = `
diff --git a/src/page.ts b/src/page.ts
--- a/src/page.ts
+++ b/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;

            const target = buildDocumentProfile(path.join(root, 'src/page.ts'), '', root, diff);
            const unrelated = buildDocumentProfile(path.join(root, 'b/src/page.ts'), '', root, diff);

            assert.deepEqual(target.changeTokens, ['screenshot', 'capture']);
            assert.deepEqual(unrelated.changeTokens, []);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('preserves real a and b paths in no-prefix moves', () => {
        const profile = buildDocumentProfile('/repo/b/src/new.ts', '', '/repo', `
diff --git a/src/old.ts b/src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
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

    it('attributes copied-file hunks only to the copy target', () => {
        const diff = `
diff --git a/src/template.ts b/src/page.ts
similarity index 90%
copy from src/template.ts
copy to src/page.ts
--- a/src/template.ts
+++ b/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;
        const target = buildDocumentProfile('/repo/src/page.ts', '', '/repo', diff);
        const source = buildDocumentProfile('/repo/src/template.ts', '', '/repo', diff);

        assert.deepEqual(target.changeTokens, ['screenshot', 'capture']);
        assert.deepEqual(source.changeTokens, []);
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
`, '/repo');

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('honors an explicit diff root for plain unified headers', () => {
        const profile = buildDocumentProfile('/repo/packages/foo/src/page.ts', '', '/repo/packages/foo', `
--- packages/foo/src/page.ts
+++ packages/foo/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`, '/repo');

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('requires an explicit root for ambiguous cwd-relative git paths', () => {
        const cwd = path.join(process.cwd(), 'src');
        const diff = `
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-return capture();
+return screenshot();
`;

        assert.throws(
            () => buildDocumentProfile(path.join(cwd, 'package.json'), '', cwd, diff),
            /Ambiguous diff path/
        );
        const profile = buildDocumentProfile(path.join(cwd, 'package.json'), '', cwd, diff, cwd);

        assert.deepEqual(profile.changeTokens, ['screenshot', 'capture']);
    });

    it('uses the git root to disambiguate duplicate relative paths', () => {
        const diff = `
diff --git a/src/page.ts b/src/page.ts
--- a/src/page.ts
+++ b/src/page.ts
@@ -1 +1 @@
-return capture();
+return screenshot();
`;
        const root = buildDocumentProfile('/repo/src/page.ts', '', '/repo/packages/foo', diff, '/repo');
        const nested = buildDocumentProfile('/repo/packages/foo/src/page.ts', '', '/repo/packages/foo', diff, '/repo');

        assert.deepEqual(root.changeTokens, ['screenshot', 'capture']);
        assert.deepEqual(nested.changeTokens, []);
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

    it('accepts space-separated timestamps in plain unified diff headers', () => {
        const profile = buildDocumentProfile('/repo/src/page.ts', '', '/repo', `
--- src/page.ts 2026-07-14 10:00:00
+++ src/page.ts 2026-07-14 10:01:00
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

    it('preserves real a and b paths in paired plain unified diffs', () => {
        const profile = buildDocumentProfile('/repo/b/src/page.ts', '', '/repo', `
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

    it('keeps changed-line context for literal-only edits', () => {
        const profile = buildDocumentProfile('/repo/src/config.ts', '', '/repo', `
--- src/config.ts
+++ src/config.ts
@@ -1 +1 @@
-const defaultTimeout = 30000;
+const defaultTimeout = 10000;
`);

        assert.ok(profile.changeTokens.includes('timeout'));
        assert.ok(profile.changePhraseTokens.includes('defaulttimeout'));
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

    it('keeps titles of parameterized, concurrent, and conditional tests', () => {
        const profile = buildDocumentProfile('/workspace/tests/price.test.ts', [
            "test.each([[1, 2], [total(3), 4]])('applies discount %i', () => {});",
            'it.concurrent("works concurrently", async () => {});',
            'describe.each`\n  a | b\n  ${1} | ${2}\n`(\'adds $a\', () => {});',
            "test.skipIf(process.env.CI)('skips on CI', () => {});",
            "it.concurrent.each(cases)('runs case %s', async () => {});",
            "test.step('is a step, not a test', async () => {});",
            "const isNumber = /^\\d+$/.test('42');",
        ].join('\n'), '/workspace');

        assert.deepEqual(profile.testTitles, ['applies discount %i', 'works concurrently', 'adds $a', 'skips on CI', 'runs case %s']);
    });

    it('keeps escaped quotes inside test titles', () => {
        const profile = buildDocumentProfile('/workspace/tests/a.spec.ts', 'test("says \\"hi\\"", () => {});', '/workspace');

        assert.deepEqual(profile.testTitles, ['says \\"hi\\"']);
    });

    // Each payload took seconds, or hung, when a regex could backtrack over it.
    for (const [name, text, diffText] of [
        ['an unterminated test title of backslashes', `test("${'\\'.repeat(40)}`, undefined],
        ['many unclosed parameterized tests', `test.each(${'a'.repeat(3000)} `.repeat(300), undefined],
        ['many escaped quotes', "\\'aaaaaaaaaa".repeat(20_000), undefined],
        ['a quoted diff header of backslashes', 'export const a = 1;', `diff --git "${'\\'.repeat(48)}\n`],
    ] as const) {
        it(`profiles ${name} quickly`, () => {
            const started = performance.now();
            buildDocumentProfile('/workspace/src/evil.spec.ts', text, '/workspace', diffText);

            assert.ok(performance.now() - started < 1000);
        });
    }
});

describe('listDiffFiles', () => {
    it('lists changed, added, renamed, and deleted files from a Git diff', () => {
        const diff = [
            'diff --git a/src/price.ts b/src/price.ts',
            '--- a/src/price.ts',
            '+++ b/src/price.ts',
            '@@ -1,2 +1,2 @@',
            '--- a removed line that looks like a header',
            '+++ an added line that looks like a header',
            ' unchanged',
            'diff --git a/src/new.ts b/src/new.ts',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/src/new.ts',
            '@@ -0,0 +1 @@',
            '+export const created = true;',
            'diff --git a/src/old-name.ts b/src/new-name.ts',
            'similarity index 90%',
            'rename from src/old-name.ts',
            'rename to src/new-name.ts',
            '--- a/src/old-name.ts',
            '+++ b/src/new-name.ts',
            '@@ -1 +1 @@',
            '-export const name = 1;',
            '+export const name = 2;',
            'diff --git a/src/gone.ts b/src/gone.ts',
            'deleted file mode 100644',
            '--- a/src/gone.ts',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-export const gone = true;',
            'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
            '--- "a/src/caf\\303\\251.ts"',
            '+++ "b/src/caf\\303\\251.ts"',
            '@@ -1 +1 @@',
            '-a',
            '+b',
        ].join('\n');

        assert.deepEqual(listDiffFiles(diff, '/repo', '.'), [
            '/repo/src/price.ts',
            '/repo/src/new.ts',
            '/repo/src/new-name.ts',
            '/repo/src/gone.ts',
            '/repo/src/café.ts',
        ]);
    });

    it('strips custom Git prefixes taken from the diff --git line', () => {
        const diff = [
            'diff --git old/src/price.ts new/src/price.ts',
            '--- old/src/price.ts',
            '+++ new/src/price.ts',
            '@@ -1 +1 @@',
            '-1',
            '+2',
            'diff --git a/old/src/tax.ts b/new/src/tax.ts',
            '--- a/old/src/tax.ts',
            '+++ b/new/src/tax.ts',
            '@@ -1 +1 @@',
            '-1',
            '+2',
            'diff --git a/src dir/page file.ts b/src dir/page file.ts',
            '--- a/src dir/page file.ts',
            '+++ b/src dir/page file.ts',
            '@@ -1 +1 @@',
            '-1',
            '+2',
            'diff --git src/no-prefix.ts src/no-prefix.ts',
            '--- src/no-prefix.ts',
            '+++ src/no-prefix.ts',
            '@@ -1 +1 @@',
            '-1',
            '+2',
        ].join('\n');

        assert.deepEqual(listDiffFiles(diff, '/repo', '.'), [
            '/repo/src/price.ts',
            '/repo/src/tax.ts',
            '/repo/src dir/page file.ts',
            '/repo/src/no-prefix.ts',
        ]);
    });

    it('strips one-segment custom prefixes from repository-root files', () => {
        const diff = [
            'diff --git old/foo.ts new/foo.ts',
            '--- old/foo.ts',
            '+++ new/foo.ts',
            '@@ -1 +1 @@',
            '-export const fooTotal = 1;',
            '+export const fooTotal = 2;',
        ].join('\n');

        assert.deepEqual(listDiffFiles(diff, '/repo', '.'), ['/repo/foo.ts']);
        assert.equal(
            buildDocumentProfile('/repo/foo.ts', '', '/repo', diff, '.').diffExcerpt,
            '@@ -1 +1 @@\n-export const fooTotal = 1;\n+export const fooTotal = 2;'
        );
    });

    it('lists header-less renames, copies, binary changes, and empty new files', () => {
        const diff = [
            'diff --git a/src/old-name.ts b/src/new-name.ts',
            'similarity index 100%',
            'rename from src/old-name.ts',
            'rename to src/new-name.ts',
            'diff --git a/src/mode.ts b/src/mode.ts',
            'old mode 100644',
            'new mode 100755',
            'diff --git old/src/base.ts new/src/base copy.ts',
            'similarity index 100%',
            'copy from src/base.ts',
            'copy to src/base copy.ts',
            'diff --git old/src/icon.ts new/src/icon.ts',
            'index 1234567..89abcde 100644',
            'Binary files old/src/icon.ts and new/src/icon.ts differ',
            'diff --git a/src/packed.ts b/src/packed.ts',
            'index 1234567..89abcde 100644',
            'GIT binary patch',
            'literal 4',
            'LcmZ?wU|;|M00aO5',
            '',
            'diff --git a/src/empty.ts b/src/empty.ts',
            'new file mode 100644',
            'index 0000000..e69de29',
            'diff --git a/src/removed.ts b/src/removed.ts',
            'deleted file mode 100644',
            'index e69de29..0000000',
            'diff --git a/src/removed-binary.ts b/src/removed-binary.ts',
            'deleted file mode 100644',
            'index 1234567..0000000',
            'Binary files a/src/removed-binary.ts and /dev/null differ',
        ].join('\n');

        assert.deepEqual(listDiffFiles(diff, '/repo', '.'), [
            '/repo/src/new-name.ts',
            '/repo/src/base copy.ts',
            '/repo/src/icon.ts',
            '/repo/src/packed.ts',
            '/repo/src/empty.ts',
        ]);
    });

    it('strips a/ and b/ labels paired with /dev/null in plain diffs unless they are real', async () => {
        const diff = [
            '--- /dev/null',
            '+++ b/src/new.ts',
            '@@ -0,0 +1 @@',
            '+export const created = true;',
            '--- a/src/gone.ts',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-export const gone = true;',
        ].join('\n');
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-plain-null-'));

        assert.deepEqual(listDiffFiles(diff, root, '.'), [path.join(root, 'src/new.ts'), path.join(root, 'src/gone.ts')]);
        await fs.mkdir(path.join(root, 'b/src'), { recursive: true });
        await fs.writeFile(path.join(root, 'b/src/new.ts'), '');
        await fs.mkdir(path.join(root, 'a/src'), { recursive: true });
        assert.deepEqual(listDiffFiles(diff, root, '.'), [path.join(root, 'b/src/new.ts'), path.join(root, 'a/src/gone.ts')]);
        await fs.rm(root, { recursive: true, force: true });
    });

    it('keeps plain unified diff paths and drops their timestamps', () => {
        const diff = [
            '--- a/src/price.ts\t2026-01-01 00:00:00.000000000 +0000',
            '+++ a/src/price.ts\t2026-01-02 00:00:00.000000000 +0000',
            '@@ -1 +1 @@',
            '-1',
            '+2',
        ].join('\n');

        assert.deepEqual(listDiffFiles(diff, '/repo', 'root'), ['/repo/root/a/src/price.ts']);
    });

    it('drops space-separated timestamps from plain unified diff paths', () => {
        const diff = [
            '--- src/price.ts 2026-01-01 00:00:00 +0000',
            '+++ src/price.ts 2026-01-02 00:00:01 +0000',
            '@@ -1 +1 @@',
            '-1',
            '+2',
        ].join('\n');

        assert.deepEqual(listDiffFiles(diff, '/repo', '.'), ['/repo/src/price.ts']);
    });

    it('strips paired a/ and b/ prefixes from plain unified diffs unless the prefixed path exists', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-list-diff-'));
        const diff = [
            '--- a/src/price.ts',
            '+++ b/src/price.ts',
            '@@ -1 +1 @@',
            '-1',
            '+2',
        ].join('\n');

        assert.deepEqual(listDiffFiles(diff, root, '.'), [path.join(root, 'src/price.ts')]);
        await fs.mkdir(path.join(root, 'b/src'), { recursive: true });
        await fs.writeFile(path.join(root, 'b/src/price.ts'), '');
        assert.deepEqual(listDiffFiles(diff, root, '.'), [path.join(root, 'b/src/price.ts')]);
        await fs.rm(root, { recursive: true, force: true });
    });
});
