import type { DocumentProfile } from './document-profile.ts';
import type { Ranker, SelectionPolicy } from '../config.ts';
import { diceCoefficient, overlapCoefficient, uniqueTokens } from './text-utils.ts';

export interface MatchCandidate {
    file: string;
    score: number;
    preview: string;
    structuralScore: number;
    stemScore: number;
    basenameScore: number;
    semanticScore: number;
    anchorScore: number;
    interfaceScore: number;
    phraseScore: number;
    pathFamilyScore: number;
    changeScore: number;
    jevScore?: number;
}

export interface RankedMatchSource {
    profile: DocumentProfile;
}

export interface RankedMatchCandidate {
    file: string;
    /** Jev's probability that this test should run for the change. */
    jevScore?: number;
    preview: string;
    profile: DocumentProfile;
}

// Share of the final score given to Jev; the structural heuristics carry the rest.
const JEV_WEIGHT = 0.6;

// Jev's Noul yes/no decision boundary. Targeted selection is opt-in; when
// Jev has no affirmative answers, we retain conservative top-K selection.
export const TARGETED_JEV_THRESHOLD = 0.5;
const STRONG_JEV_SCORE = 0.7;
const MIN_STRUCTURAL_NEIGHBOR_SCORE = 0.2;
// Share of candidates, by structural rank, that adaptive selection keeps as neighbors.
const CONFIDENT_NEIGHBOR_SHARE = 0.1;
const UNCERTAIN_NEIGHBOR_SHARE = 0.25;
// Result cap for conservative and targeted selection when no top-K is given.
const DEFAULT_TOP_K = 5;

const ANCHOR_KEYWORD_PATTERN = /(testid|codegen|browsername|dotenv|toollist|mcp|selector|config|timeout|internal|attr)/i;
const PUBLIC_QUERY_PATTERN = /(getby|findby|queryby|bytext|bylabel|byrole|testid)/i;
const END_USER_SURFACE_FAMILIES = ['page', 'browser', 'client'];

function hasChangeEvidence(profile: DocumentProfile): boolean {
    return profile.changeTokens.length > 0 || profile.changePhraseTokens.length > 0;
}

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
        const weight = tokenWeight(token);
        leftWeight += weight;
        if (rightSet.has(token)) {
            sharedWeight += weight;
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
    return Math.min(0.95, Math.max(
        overlapCoefficient(source.exports, candidate.imports),
        overlapCoefficient(source.exports, candidate.testNames),
        focusedWeightedOverlap(source.rareAnchorTokens, candidate.rareAnchorTokens),
        weightedOverlap(source.rareAnchorTokens, candidate.rareAnchorTokens),
        diceCoefficient(source.phraseTokens, candidate.rareAnchorTokens),
    ));
}

function interfaceOverlap(source: DocumentProfile, candidate: DocumentProfile): number {
    // Imports and anchors only count once the source exposes commands or options.
    const sourceInterfaceTokens = source.commandTokens.length || source.optionTokens.length
        ? [...source.commandTokens, ...source.optionTokens, ...source.imports, ...source.rareAnchorTokens]
        : [];
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
    const publicQuerySource = source.exports.some((token) => PUBLIC_QUERY_PATTERN.test(token));
    const sourceAnchors = [...source.exports, ...source.rareAnchorTokens];
    const candidateAnchors = [...candidate.rareAnchorTokens, ...candidate.testNames];
    const consumerAnchorScore = Math.max(
        focusedWeightedOverlap(sourceAnchors, candidateAnchors),
        weightedOverlap(sourceAnchors, candidateAnchors),
    );
    const endUserSurface = END_USER_SURFACE_FAMILIES.some((family) => candidate.pathFamilyTokens.includes(family));
    const endUserSurfaceScore = publicQuerySource && consumerAnchorScore > 0.15 && endUserSurface ? 0.7 : 0;

    return Math.max(baseScore, endUserSurfaceScore);
}

function changeOverlap(source: DocumentProfile, candidate: DocumentProfile): number {
    if (!hasChangeEvidence(source)) {
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

// Each structural signal plus their weighted blend (`score`).
type StructuralScore = Omit<MatchCandidate, 'file' | 'score' | 'preview' | 'structuralScore' | 'jevScore'> & {
    score: number;
};

function structuralScore(source: DocumentProfile, candidate: DocumentProfile): StructuralScore {
    const stemScore = overlapCoefficient(source.stemTokens, candidate.stemTokens);
    const basenameScore = overlapCoefficient(source.basenameTokens, candidate.basenameTokens);
    const semanticScore = overlapCoefficient(source.semanticTokens, candidate.semanticTokens);
    const anchorScore = anchorOverlap(source, candidate);
    const interfaceScore = interfaceOverlap(source, candidate);
    const phraseScore = weightedOverlap(source.phraseTokens, candidate.phraseTokens);
    const pathFamilyScore = pathFamilyOverlap(source, candidate);
    const changeScore = changeOverlap(source, candidate);

    const weights = {
        changeScore: hasChangeEvidence(source) ? 0.25 : 0,
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
    return candidates
        .map((item) => {
            const { score: structural, ...componentScores } = structuralScore(source.profile, item.profile);
            // Without a Jev score (heuristics-only ranking) the structural score stands alone.
            const blendedScore = item.jevScore === undefined
                ? structural
                : (item.jevScore * JEV_WEIGHT) + (structural * (1 - JEV_WEIGHT));

            return {
                file: item.file,
                score: Math.min(1, Math.max(0, blendedScore)),
                preview: item.preview,
                structuralScore: structural,
                ...componentScores,
                jevScore: item.jevScore,
            };
        })
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

export function filterMatches(matches: MatchCandidate[], minScore: number): MatchCandidate[] {
    return matches.filter((entry) => entry.score >= minScore);
}

interface SelectionEvidence {
    affirmativeCount: number;
    structuralNeighborCount: number;
    structuralCutoff: number;
    uncertaintyRetainedCount?: number;
}

// Non-finite or out-of-range Jev scores count as missing.
function usableJevScore(match: MatchCandidate): number | undefined {
    const { jevScore } = match;
    return jevScore !== undefined && Number.isFinite(jevScore) && jevScore <= 1 ? jevScore : undefined;
}

function isJevAffirmative(match: MatchCandidate): boolean {
    return (usableJevScore(match) ?? 0) >= TARGETED_JEV_THRESHOLD;
}

interface SelectionResult {
    results: MatchCandidate[];
    eligibleCount: number;
    truncated: boolean;
    effectiveLimit: number | null;
    reason?: string;
    evidence?: SelectionEvidence;
}

function capSelection(
    eligible: MatchCandidate[],
    cap: number | undefined,
    reason?: string,
    evidence?: SelectionEvidence
): SelectionResult {
    return {
        results: cap === undefined ? eligible : eligible.slice(0, cap),
        eligibleCount: eligible.length,
        truncated: cap !== undefined && eligible.length > cap,
        effectiveLimit: cap ?? null,
        reason,
        evidence,
    };
}

/** Every affirmative Jev answer plus the strongest structural neighbors; wider when evidence is weak. */
function selectAdaptive(matches: MatchCandidate[], topK: number | undefined, ranker: Ranker): SelectionResult {
    const structuralScores = matches.map((match) => match.structuralScore).sort((a, b) => b - a);
    const strongestStructural = structuralScores[0] ?? 0;
    const affirmative = ranker === 'jev' ? matches.filter(isJevAffirmative) : [];
    const strongestJev = matches.reduce((best, match) => Math.max(best, usableJevScore(match) ?? 0), 0);
    const uncertain = ranker !== 'jev' || strongestJev < STRONG_JEV_SCORE;
    if (uncertain && strongestStructural < MIN_STRUCTURAL_NEIGHBOR_SCORE) {
        return capSelection(matches, topK, 'No strong Jev or structural evidence; all candidates retained', {
            affirmativeCount: affirmative.length,
            structuralNeighborCount: 0,
            structuralCutoff: 0,
            uncertaintyRetainedCount: matches.length - affirmative.length,
        });
    }

    const neighborShare = uncertain ? UNCERTAIN_NEIGHBOR_SHARE : CONFIDENT_NEIGHBOR_SHARE;
    const percentileCutoff = structuralScores[Math.max(0, Math.ceil(structuralScores.length * neighborShare) - 1)] ?? 1;
    const structuralCutoff = Math.max(MIN_STRUCTURAL_NEIGHBOR_SCORE, percentileCutoff);
    const affirmativeFiles = new Set(affirmative.map((match) => match.file));
    const eligible = matches.filter((match) =>
        affirmativeFiles.has(match.file) || match.structuralScore >= structuralCutoff
    );
    return capSelection(eligible, topK, uncertain ? 'No strong Jev answer; structural coverage widened' : undefined, {
        affirmativeCount: affirmative.length,
        structuralNeighborCount: eligible.length - affirmative.length,
        structuralCutoff,
    });
}

export function selectMatches(
    matches: MatchCandidate[],
    topK: number | undefined,
    policy: SelectionPolicy,
    ranker: Ranker
): SelectionResult {
    if (policy === 'adaptive') {
        return selectAdaptive(matches, topK, ranker);
    }

    const limit = topK ?? DEFAULT_TOP_K;
    if (policy === 'conservative') {
        return capSelection(matches, limit);
    }

    // Targeted: only Jev's affirmative answers, falling back to conservative top-K.
    if (ranker !== 'jev') {
        return capSelection(matches, limit, 'Jev is unavailable; conservative selection retained');
    }
    const affirmative = matches.filter(isJevAffirmative);
    return affirmative.length
        ? capSelection(affirmative, limit)
        : capSelection(matches, limit, 'No affirmative Jev answer; conservative selection retained');
}
