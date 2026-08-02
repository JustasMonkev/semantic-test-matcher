import type { DocumentProfile } from './document-profile.ts';
import type { EmbeddingBackend } from './embedding-types.ts';
import { diceCoefficient, normalizeVector, overlapCoefficient, uniqueTokens } from './text-utils.ts';

export interface MatchCandidate {
    file: string;
    score: number;
    preview: string;
    embeddingScore: number;
    structuralScore: number;
    stemScore: number;
    basenameScore: number;
    semanticScore: number;
    anchorScore: number;
    interfaceScore: number;
    phraseScore: number;
    pathFamilyScore: number;
    changeScore: number;
    embeddingBackend?: EmbeddingBackend;
    cacheHit?: boolean;
}

export function cosineSimilarity(a: number[], b: number[]): number {
    if (!a.length || a.length !== b.length) {
        return 0;
    }

    let sum = 0;
    for (let i = 0; i < a.length; i += 1) {
        sum += a[i] * b[i];
    }
    return sum;
}

export interface RankedMatchSource {
    profile: DocumentProfile;
    vector: number[];
}

export interface RankedMatchCandidate {
    file: string;
    vector: number[];
    preview: string;
    profile: DocumentProfile;
    embeddingBackend?: EmbeddingBackend;
    cacheHit?: boolean;
}

const ANCHOR_KEYWORD_PATTERN = /(testid|codegen|browsername|dotenv|toollist|mcp|selector|config|timeout|internal|attr)/i;

/**
 * Share of the final score taken from embedding cosine; the rest is structural.
 *
 * Cosine over this corpus lands in a narrow band (~0.24-0.80) for every
 * candidate, so it separates far less than the structural signals do. Dropping
 * it to zero still costs measurable accuracy, so it stays — just smaller.
 */
export const EMBEDDING_WEIGHT = 0.1;

function tokenWeight(token: string): number {
    let weight = 1;

    if (token.includes('/') || token.includes(':')) {
        weight += 0.6;
    }

    if (/[0-9]/.test(token)) {
        weight += 0.15;
    }

    if (token.length >= 12) {
        weight += 0.35;
    }

    if (ANCHOR_KEYWORD_PATTERN.test(token)) {
        weight += 0.5;
    }

    return weight;
}

function weightedOverlap(left: string[], right: string[]): number {
    const leftTokens = uniqueTokens(left);
    const rightTokens = uniqueTokens(right);
    const rightSet = new Set(rightTokens);

    if (!leftTokens.length || !rightTokens.length) {
        return 0;
    }

    let sharedWeight = 0;
    let leftWeight = 0;
    let rightWeight = 0;

    for (const token of leftTokens) {
        leftWeight += tokenWeight(token);
        if (rightSet.has(token)) {
            sharedWeight += tokenWeight(token);
        }
    }

    for (const token of rightTokens) {
        rightWeight += tokenWeight(token);
    }

    return (sharedWeight * 2) / (leftWeight + rightWeight);
}

function focusedWeightedOverlap(reference: string[], candidate: string[]): number {
    const referenceTokens = uniqueTokens(reference);
    const candidateTokens = uniqueTokens(candidate);
    const referenceSet = new Set(referenceTokens);

    if (!referenceTokens.length || !candidateTokens.length) {
        return 0;
    }

    let sharedWeight = 0;
    let candidateWeight = 0;

    for (const token of candidateTokens) {
        const weight = tokenWeight(token);
        candidateWeight += weight;
        if (referenceSet.has(token)) {
            sharedWeight += weight;
        }
    }

    return candidateWeight ? sharedWeight / candidateWeight : 0;
}

function anchorOverlap(source: DocumentProfile, candidate: DocumentProfile): number {
    const candidateAnchorTokens = [...candidate.rareAnchorTokens];

    return Math.min(0.95, Math.max(
        overlapCoefficient(source.exports, candidate.imports),
        overlapCoefficient(source.exports, candidate.testNames),
        focusedWeightedOverlap(source.rareAnchorTokens, candidateAnchorTokens),
        weightedOverlap(source.rareAnchorTokens, candidateAnchorTokens),
        diceCoefficient(source.phraseTokens, candidateAnchorTokens),
    ));
}

/**
 * Filename affinity between the changed module and a candidate test.
 *
 * Real test suites name files after the module they cover, but the separators
 * differ: browserContext.ts is exercised by browsercontext-basic.spec.ts. Joining
 * the canonical stem words and testing containment catches that; requiring the
 * contained side to be at least two words stops a single generic word ("browser")
 * from claiming a whole-name match.
 */
function stemOverlap(source: DocumentProfile, candidate: DocumentProfile): number {
    const sourceTokens = uniqueTokens(source.stemTokens);
    const candidateTokens = uniqueTokens(candidate.stemTokens);

    if (!sourceTokens.length || !candidateTokens.length) {
        return 0;
    }

    const sourceCompact = sourceTokens.join('');
    const candidateCompact = candidateTokens.join('');
    if (
        (sourceTokens.length > 1 && candidateCompact.includes(sourceCompact)) ||
        (candidateTokens.length > 1 && sourceCompact.includes(candidateCompact))
    ) {
        return 1;
    }

    // Coverage of the source name rather than overlap: dividing by the smaller set
    // lets a one-word test stem score a perfect match on one shared word, which is
    // how browser.spec.ts used to outrank browsercontext-basic.spec.ts.
    const candidateSet = new Set(candidateTokens);
    const shared = sourceTokens.filter((token) => candidateSet.has(token)).length;
    return shared / sourceTokens.length;
}

function interfaceOverlap(source: DocumentProfile, candidate: DocumentProfile): number {
    const sourceInterfaceTokens = source.commandTokens.length || source.optionTokens.length
        ? [...source.commandTokens, ...source.optionTokens, ...source.imports, ...source.rareAnchorTokens]
        : [...source.commandTokens, ...source.optionTokens];
    const candidateInterfaceTokens = [
        ...candidate.commandTokens,
        ...candidate.optionTokens,
        ...candidate.testNames,
        ...candidate.contentTokens,
        ...candidate.pathFamilyTokens,
        ...candidate.rareAnchorTokens,
        ...candidate.semanticTokens,
        ...candidate.phraseTokens,
    ];
    const configPathAligned = candidate.pathFamilyTokens.some((token) =>
        token === 'config' || token.endsWith('/config') || token.includes('config/')
    );
    const orchestrationConfigScore = source.optionTokens.length >= 5 && configPathAligned
        ? Math.max(
            focusedWeightedOverlap(source.optionTokens, candidateInterfaceTokens),
            overlapCoefficient(source.optionTokens, candidateInterfaceTokens),
            0.58
        )
        : 0;

    return Math.max(
        overlapCoefficient(sourceInterfaceTokens, candidateInterfaceTokens),
        focusedWeightedOverlap(sourceInterfaceTokens, candidateInterfaceTokens),
        weightedOverlap(sourceInterfaceTokens, candidateInterfaceTokens),
        orchestrationConfigScore,
    );
}

function pathFamilyOverlap(source: DocumentProfile, candidate: DocumentProfile): number {
    const baseScore = weightedOverlap(source.pathFamilyTokens, [
        ...candidate.pathFamilyTokens,
        ...candidate.commandTokens,
        ...candidate.optionTokens,
    ]);
    const publicQuerySource = source.exports.some((token) => /(getby|findby|queryby|bytext|bylabel|byrole|testid)/i.test(token));
    const consumerAnchorScore = Math.max(
        focusedWeightedOverlap(
            [...source.exports, ...source.rareAnchorTokens],
            [...candidate.rareAnchorTokens, ...candidate.testNames]
        ),
        weightedOverlap(
            [...source.exports, ...source.rareAnchorTokens],
            [...candidate.rareAnchorTokens, ...candidate.testNames]
        ),
    );
    const endUserSurfaceScore = publicQuerySource &&
        consumerAnchorScore > 0.15 &&
        (
            candidate.pathFamilyTokens.includes('page') ||
            candidate.pathFamilyTokens.includes('browser') ||
            candidate.pathFamilyTokens.includes('client')
        )
        ? 0.7
        : 0;

    return Math.max(baseScore, endUserSurfaceScore);
}

function changeOverlap(source: DocumentProfile, candidate: DocumentProfile): number {
    if (!source.changeTokens.length && !source.changePhraseTokens.length) {
        return 0;
    }

    const changeTokens = uniqueTokens([...source.changeTokens, ...source.changePhraseTokens]);
    const publicFalloutTokens = uniqueTokens([
        ...candidate.stemTokens,
        ...candidate.testNames,
    ]);
    const internalChangeTokens = uniqueTokens([
        ...candidate.rareAnchorTokens,
        ...candidate.phraseTokens,
        ...candidate.semanticTokens,
        ...candidate.contentTokens,
        ...candidate.lateCallTokens,
    ]);
    const changeTokenGroups = [source.changeTokens, source.changePhraseTokens]
        .filter((tokens) => tokens.length > 0);
    const changedTokenCoverage = (candidateTokens: string[]): number => {
        const scores = changeTokenGroups.map((tokens) => focusedWeightedOverlap(candidateTokens, tokens));
        return scores.reduce((sum, score) => sum + score, 0) / scores.length;
    };

    const sourceIdentityAligned = [...candidate.stemTokens, ...candidate.contentTokens, ...candidate.lateCallTokens].some(
        (token) => source.stemTokens.includes(token)
    );
    const evidenceWeight = sourceIdentityAligned ? 1 : 0.75;
    const publicFalloutScore = changedTokenCoverage(publicFalloutTokens) * evidenceWeight;
    let internalChangeScore = changedTokenCoverage(internalChangeTokens);
    if (
        candidate.pathFamilyTokens.includes('codegen') &&
        changeTokens.some((token) => /(internal|attr|attribute|testid)/i.test(token))
    ) {
        internalChangeScore = Math.min(1, internalChangeScore + 0.35);
    }

    return Math.max(publicFalloutScore, internalChangeScore * evidenceWeight);
}

function structuralScore(source: DocumentProfile, candidate: DocumentProfile): {
    stemScore: number;
    basenameScore: number;
    semanticScore: number;
    anchorScore: number;
    interfaceScore: number;
    phraseScore: number;
    pathFamilyScore: number;
    changeScore: number;
    score: number;
} {
    const stemScore = stemOverlap(source, candidate);
    const basenameScore = overlapCoefficient(source.basenameTokens, candidate.basenameTokens);
    const semanticScore = overlapCoefficient(source.semanticTokens, candidate.semanticTokens);
    const anchorScore = anchorOverlap(source, candidate);
    const interfaceScore = interfaceOverlap(source, candidate);
    const phraseScore = weightedOverlap(source.phraseTokens, candidate.phraseTokens);
    const pathFamilyScore = pathFamilyOverlap(source, candidate);
    const changeScore = changeOverlap(source, candidate);

    // Tuned against bench/playwright.cases.json with a split-half check; see
    // openwiki/domain/ranking-model.md before moving these. Filename evidence
    // (stem/basename) is the strongest single real-world signal for test
    // selection and was previously weighted almost to zero.
    const weights = {
        changeScore: source.changeTokens.length || source.changePhraseTokens.length ? 0.25 : 0,
        phraseScore: 0.25,
        anchorScore: 0.14,
        semanticScore: 0.12,
        pathFamilyScore: 0.12,
        interfaceScore: 0.10,
        stemScore: 0.10,
        basenameScore: 0.05,
    };
    const activeWeightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0);

    const rawScore =
        (changeScore * weights.changeScore) +
        (phraseScore * weights.phraseScore) +
        (anchorScore * weights.anchorScore) +
        (semanticScore * weights.semanticScore) +
        (interfaceScore * weights.interfaceScore) +
        (pathFamilyScore * weights.pathFamilyScore) +
        (stemScore * weights.stemScore) +
        (basenameScore * weights.basenameScore);

    return {
        stemScore,
        basenameScore,
        semanticScore,
        anchorScore,
        interfaceScore,
        phraseScore,
        pathFamilyScore,
        changeScore,
        score: activeWeightTotal ? Math.min(1, Math.max(0, rawScore / activeWeightTotal)) : 0,
    };
}

export const DEFAULT_RERANK_DEPTH = 64;

/**
 * Cheap first stage of retrieval: score every candidate structurally and keep
 * only the strongest `depth` for embedding.
 *
 * Structural scoring is pure string work, while each embedding costs tens of
 * milliseconds of local inference and contributes only `EMBEDDING_WEIGHT` of the
 * final score. Candidates deep in the structural tail cannot climb into the top
 * results on embedding alone, so embedding them is wasted time.
 *
 * A `depth` of 0 (or one that covers every candidate) disables the prefilter and
 * embeds everything.
 */
export function selectRerankCandidates<T extends { file: string; profile: DocumentProfile }>(
    source: DocumentProfile,
    candidates: T[],
    depth: number
): T[] {
    if (!Number.isFinite(depth) || depth <= 0 || candidates.length <= depth) {
        return candidates;
    }

    return candidates
        .map((candidate) => ({ candidate, score: structuralScore(source, candidate.profile).score }))
        .sort((left, right) =>
            right.score - left.score || left.candidate.file.localeCompare(right.candidate.file))
        .slice(0, Math.floor(depth))
        .map((entry) => entry.candidate);
}

export function rankMatches(source: RankedMatchSource, candidates: RankedMatchCandidate[]): MatchCandidate[] {
    const normalizedSource = normalizeVector(source.vector);

    return candidates
        .map((item) => {
            const embeddingScore = cosineSimilarity(normalizedSource, normalizeVector(item.vector));
            const structure = structuralScore(source.profile, item.profile);
            const score = Math.min(
                1,
                Math.max(
                    0,
                    (embeddingScore * EMBEDDING_WEIGHT) + (structure.score * (1 - EMBEDDING_WEIGHT))
                )
            );

            return {
                file: item.file,
                score,
                preview: item.preview,
                embeddingScore,
                structuralScore: structure.score,
                stemScore: structure.stemScore,
                basenameScore: structure.basenameScore,
                semanticScore: structure.semanticScore,
                anchorScore: structure.anchorScore,
                interfaceScore: structure.interfaceScore,
                phraseScore: structure.phraseScore,
                pathFamilyScore: structure.pathFamilyScore,
                changeScore: structure.changeScore,
                embeddingBackend: item.embeddingBackend,
                cacheHit: item.cacheHit,
            };
        })
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

export function filterMatches(matches: MatchCandidate[], minScore: number): MatchCandidate[] {
    return matches.filter((entry) => entry.score >= minScore);
}
