import { tokenizeText } from './text-utils.ts';
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

const MAX_EXPORTED_SYMBOLS = 20;
const MAX_DIFF_CHARS = 8000;
const MAX_SOURCE_CHARS = 6000;
const MAX_TEST_TITLES = 40;
const LEADING_BLOCK_COMMENT = /^\s*\/\*[\s\S]*?\*\/\s*/;

function truncate(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…(truncated)`;
}

export function buildModelEvidence(source: ModelSource): { changed_file: Record<string, unknown> } {
    const changedFile: Record<string, unknown> = {
        path: source.profile.relativePath,
        exported_symbols: source.profile.exports.slice(0, MAX_EXPORTED_SYMBOLS),
    };
    if (source.profile.diffExcerpt) {
        changedFile.diff = truncate(source.profile.diffExcerpt, MAX_DIFF_CHARS);
    } else if (!source.diffOnly) {
        changedFile.source_code = truncate(source.text.replace(LEADING_BLOCK_COMMENT, ''), MAX_SOURCE_CHARS);
    }
    return { changed_file: changedFile };
}

export function buildCandidateEvidence(source: ModelSource, candidate: ModelCandidate): { path: string; test_titles: string[] } {
    const titles = candidate.profile.testTitles;
    const { changeTokens, exports } = source.profile;
    const uncovered = new Set(changeTokens.length ? changeTokens : exports);
    if (titles.length <= MAX_TEST_TITLES || !uncovered.size) {
        return { path: candidate.file, test_titles: titles.slice(0, MAX_TEST_TITLES) };
    }

    // Keep the first witness for each source term, then fill unused slots in declaration order.
    const selected = new Set<number>();
    for (const [index, title] of titles.entries()) {
        for (const token of tokenizeText(title.replace(/[^a-z0-9]+/gi, ' '))) {
            if (uncovered.delete(token)) {
                selected.add(index);
            }
        }
        if (!uncovered.size || selected.size === MAX_TEST_TITLES) {
            break;
        }
    }
    for (let index = 0; selected.size < MAX_TEST_TITLES; index += 1) {
        selected.add(index);
    }
    return { path: candidate.file, test_titles: [...selected].sort((a, b) => a - b).map(index => titles[index]) };
}

export function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

export function parseRetryAfterMs(header: string | null, now: number): number {
    const seconds = Number(header ?? 0);
    return Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header ?? '') - now;
}

export function addTokenCounts(total: number | undefined, added: number | undefined): number | undefined {
    return total === undefined || added === undefined ? undefined : total + added;
}

export function packBatches<T>(items: readonly T[], fits: (batch: T[]) => boolean): T[][] | undefined {
    const batches: T[][] = [];
    let current: T[] = [];
    for (const item of items) {
        if (!fits([item])) {
            return undefined;
        }
        if (current.length && !fits([...current, item])) {
            batches.push(current);
            current = [];
        }
        current.push(item);
    }
    if (current.length) {
        batches.push(current);
    }
    return batches;
}
