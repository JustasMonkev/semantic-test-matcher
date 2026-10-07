import type { DocumentProfile } from './document-profile.ts';

export type ModelProvider = 'jev' | 'decisions';

export interface ModelSource {
    profile: DocumentProfile;
    text: string;
    diffOnly?: boolean;
}

export interface ModelCandidate {
    file: string;
    profile: DocumentProfile;
}

export interface ModelScorerOptions {
    apiKey: string;
    model: string;
    cacheDir: string;
    skipCache?: boolean;
    fetch?: typeof fetch;
    retryBaseMs?: number;
}

export interface ModelScoreResult {
    provider: ModelProvider;
    scores: Map<string, number>;
    requests: number;
    cacheHits: number;
    inputTokens: number | undefined;
    outputTokens?: number;
    models: string[];
    modelIdentity?: 'reported' | 'requested';
}

export interface ModelScorer {
    score(source: ModelSource, candidates: ModelCandidate[]): Promise<ModelScoreResult>;
    flush(): Promise<void>;
}

export class ModelScorerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ModelScorerError';
    }
}

function truncate(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…(truncated)`;
}

export function buildModelEvidence(source: ModelSource): { changed_file: Record<string, unknown> } {
    const changedFile: Record<string, unknown> = {
        path: source.profile.relativePath,
        exported_symbols: source.profile.exports.slice(0, 20),
    };
    if (source.profile.diffExcerpt) {
        changedFile.diff = truncate(source.profile.diffExcerpt, 8000);
    } else if (!source.diffOnly) {
        changedFile.source_code = truncate(source.text.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''), 6000);
    }
    return { changed_file: changedFile };
}

export function buildCandidateEvidence(candidate: ModelCandidate): { path: string; test_titles: string[] } {
    return { path: candidate.file, test_titles: candidate.profile.testTitles.slice(0, 40) };
}
