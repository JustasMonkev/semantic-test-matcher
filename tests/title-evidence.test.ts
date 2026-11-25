import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildDecisionQuestion } from '../src/services/decisions.ts';
import { buildDocumentProfile } from '../src/services/document-profile.ts';
import { buildJevQuestion } from '../src/services/jev.ts';

it('reserves title slots for distinct changed terms in both provider requests', () => {
    const diff = '@@ -1 +1 @@\n-return 0;\n+return mint + ledger;';
    const source = { text: '', profile: buildDocumentProfile('/repo/src.ts', '', '/repo', diff) };
    const titles = [
        ...Array.from({ length: 40 }, (_, index) => `mint example ${index}`),
        'covers the ledger', 'unrelated tail',
    ];
    const file = 'suite.test.ts';
    const code = titles.map(title => `test('${title}', () => {});`).join('\n');
    const candidate = { file, profile: buildDocumentProfile(file, code, '/repo') };
    const expected = [...titles.slice(0, 39), 'covers the ledger'];

    assert.deepEqual(buildJevQuestion(source, candidate).instructions.test_file.test_titles, expected);
    assert.ok(buildDecisionQuestion(source, candidate, 0).instructions.endsWith(
        JSON.stringify({ path: file, test_titles: expected })
    ));

    const codeWithoutDiff = 'export const ledger = 1;';
    const withoutDiff = { text: codeWithoutDiff, profile: buildDocumentProfile('/repo/math.ts', codeWithoutDiff, '/repo') };
    assert.deepEqual(buildJevQuestion(withoutDiff, candidate).instructions.test_file.test_titles, expected);

    const noOverlap = { text: '', profile: buildDocumentProfile('/repo/math.ts', '', '/repo') };
    assert.deepEqual(buildJevQuestion(noOverlap, candidate).instructions.test_file.test_titles, titles.slice(0, 40));
});
