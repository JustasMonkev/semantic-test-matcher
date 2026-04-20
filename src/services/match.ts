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
    fallbackReason?: string;
}

export function cosineSimilarity(a: number[], b: number[]): number {
    const max = Math.min(a.length, b.length);
    if (!max) {
        return 0;
    }

    let sum = 0;
    for (let i = 0; i < max; i += 1) {
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
    fallbackReason?: string;
}

const ANCHOR_KEYWORD_PATTERN = /(testid|codegen|browsername|dotenv|toollist|mcp|selector|config|timeout|internal|attr)/i;

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

    const publicFalloutTokens = uniqueTokens(candidate.testNames);
    const internalChangeTokens = uniqueTokens([
        ...candidate.rareAnchorTokens,
        ...candidate.phraseTokens,
        ...candidate.semanticTokens,
    ]);

    const publicFalloutScore = Math.max(
        focusedWeightedOverlap(source.rareAnchorTokens, publicFalloutTokens),
        overlapCoefficient(source.rareAnchorTokens, publicFalloutTokens),
    );
    let internalChangeScore = Math.max(
        focusedWeightedOverlap(
            [...source.changeTokens, ...source.changePhraseTokens],
            internalChangeTokens
        ),
        weightedOverlap(
            [...source.changeTokens, ...source.changePhraseTokens],
            internalChangeTokens
        ),
        overlapCoefficient(
            [...source.changeTokens, ...source.changePhraseTokens],
            internalChangeTokens
        ),
    );
    if (
        candidate.pathFamilyTokens.includes('codegen') &&
        source.changeTokens.some((token) => /(internal|attr|attribute|testid)/i.test(token))
    ) {
        internalChangeScore = Math.min(1, internalChangeScore + 0.35);
    }

    return Math.min(1, (publicFalloutScore * 0.55) + (internalChangeScore * 0.45));
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
    const stemScore = overlapCoefficient(source.stemTokens, candidate.stemTokens);
    const basenameScore = overlapCoefficient(source.basenameTokens, candidate.basenameTokens);
    const semanticScore = overlapCoefficient(source.semanticTokens, candidate.semanticTokens);
    const anchorScore = anchorOverlap(source, candidate);
    const interfaceScore = interfaceOverlap(source, candidate);
    const phraseScore = weightedOverlap(source.phraseTokens, candidate.phraseTokens);
    const pathFamilyScore = pathFamilyOverlap(source, candidate);
    const changeScore = changeOverlap(source, candidate);

    const weights = {
        changeScore: source.changeTokens.length || source.changePhraseTokens.length ? 0.25 : 0,
        phraseScore: 0.25,
        anchorScore: 0.18,
        semanticScore: 0.12,
        interfaceScore: 0.10,
        pathFamilyScore: 0.07,
        stemScore: 0.02,
        basenameScore: 0.01,
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
                    (embeddingScore * 0.2) + (structure.score * 0.8)
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
                fallbackReason: item.fallbackReason,
            };
        })
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}
