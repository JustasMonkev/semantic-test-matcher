import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDocumentProfile } from '../src/services/document-profile.ts';

describe('buildDocumentProfile', () => {
    it('places the bounded summary before verbose sections that Ollama may truncate', () => {
        const tests = Array.from({ length: 500 }, (_, index) => `test('case ${index}', () => {});`).join('\n');
        const profile = buildDocumentProfile('/repo/tests/large.spec.ts', tests, '/repo');

        assert.ok(profile.embeddingText.indexOf('summary:') < profile.embeddingText.indexOf('tests:'));
    });
});
