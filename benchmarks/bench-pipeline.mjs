// Puts the per-area numbers in context: how much of a real `rbt match` run
// does each replaceable component actually account for?
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectCandidateFilesDetailed } from '../src/utils/files.ts';
import { buildDocumentProfile } from '../src/services/document-profile.ts';
import { EmbeddingSession } from '../src/services/embeddings.ts';
import { rankMatches } from '../src/services/match.ts';
import { mapWithConcurrency } from '../src/utils/async.ts';
import { resolveConfig } from '../src/config.ts';
import { formatNs, section } from './harness.mjs';

process.env.RBT_EMBEDDING_TEST_MODE = 'stub';

const ROOT = path.resolve(process.argv[2] ?? './tree-small');
const CACHE_DIR = path.join(import.meta.dirname, '.pipeline-cache');
await fs.rm(CACHE_DIR, { recursive: true, force: true });

const stages = [];
async function stage(name, fn) {
    const start = process.hrtime.bigint();
    const value = await fn();
    stages.push({ name, ns: Number(process.hrtime.bigint() - start) });
    return value;
}

const changedPath = path.join(ROOT, 'packages/pkg-0/src/group-0/mod-0.ts');

await stage('resolve config', () => resolveConfig({}, {}, ROOT));
const collected = await stage('collect candidates (files.ts walk)', () =>
    collectCandidateFilesDetailed([ROOT], ['**/*'], [], ROOT));
const files = collected.files;

const changedText = await fs.readFile(changedPath, 'utf8');
const sourceProfile = await stage('profile changed file', async () =>
    buildDocumentProfile(changedPath, changedText, ROOT));

const profiles = await stage(`read + profile ${files.length} candidates`, () =>
    mapWithConcurrency(files, 8, async (file) => {
        const text = await fs.readFile(file, 'utf8');
        return { file, profile: buildDocumentProfile(file, text, ROOT) };
    }));

const session = new EmbeddingSession({ model: 'stub.gguf', cacheDir: CACHE_DIR });
const sourceVector = await stage('embed source (stub)', () => session.embed(sourceProfile.embeddingText));
const candidates = await stage(`embed ${files.length} candidates (stub)`, () =>
    mapWithConcurrency(profiles, 8, async (entry) => {
        const embedded = await session.embed(entry.profile.embeddingText);
        return {
            file: entry.file,
            vector: embedded.vector,
            preview: entry.profile.preview,
            profile: entry.profile,
            embeddingBackend: embedded.backend,
            cacheHit: embedded.cacheHit,
        };
    }));

await stage('rank matches', async () => rankMatches({ profile: sourceProfile, vector: sourceVector.vector }, candidates));
await stage('flush cache (write)', () => session.flush());

section(`END-TO-END PIPELINE — ${files.length} candidates, stubbed embeddings`);
const total = stages.reduce((sum, entry) => sum + entry.ns, 0);
const width = Math.max(...stages.map((entry) => entry.name.length));
for (const entry of stages) {
    const share = (entry.ns / total) * 100;
    console.log(`${entry.name.padEnd(width)}  ${formatNs(entry.ns).padStart(10)}  ${`${share.toFixed(1)}%`.padStart(7)}  ${'#'.repeat(Math.round(share / 2))}`);
}
console.log(`${'TOTAL'.padEnd(width)}  ${formatNs(total).padStart(10)}`);
console.log('\nNote: real GGUF inference replaces the stub and dominates everything above.');

await fs.rm(CACHE_DIR, { recursive: true, force: true });
