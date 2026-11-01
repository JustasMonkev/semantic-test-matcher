import type { Ranker, SelectionPolicy } from '../config.ts';
import { clamp } from '../utils/values.ts';
import type { DocumentProfile } from './document-profile.ts';
import type { ModelScoreResult } from './model-scorer.ts';
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
    modelScore?: number;
    jevScore?: number;
}

export interface RankedMatchSource {
    profile: DocumentProfile;
}

export interface RankedMatchCandidate {
    file: string;
    modelScore?: number;
    jevScore?: number;
    preview: string;
    profile: DocumentProfile;
}

export const TARGETED_MODEL_THRESHOLD = 0.5;

const MODEL_WEIGHT = 0.6;
const STRONG_MODEL_SCORE = 0.7;
const MIN_STRUCTURAL_NEIGHBOR_SCORE = 0.2;
const NEIGHBOR_SHARE_WHEN_MODEL_CONFIDENT = 0.1;
const NEIGHBOR_SHARE_WHEN_MODEL_UNCERTAIN = 0.25;
const DEFAULT_CAPPED_SELECTION_SIZE = 5;
const MAX_ANCHOR_SCORE = 0.95;
const MIN_ORCHESTRATION_OPTION_COUNT = 5;
const ORCHESTRATION_CONFIG_FLOOR = 0.58;
const END_USER_SURFACE_SCORE = 0.7;
const MIN_CONSUMER_ANCHOR_SCORE = 0.15;
const CODEGEN_INTERNAL_CHANGE_BONUS = 0.35;
const UNALIGNED_CHANGE_EVIDENCE_WEIGHT = 0.75;

const STRUCTURAL_WEIGHTS = {
    changeScore: 0.25,
    phraseScore: 0.25,
    anchorScore: 0.18,
    semanticScore: 0.12,
    interfaceScore: 0.10,
    pathFamilyScore: 0.07,
    stemScore: 0.02,
    basenameScore: 0.01,
};

type StructuralSignal = keyof typeof STRUCTURAL_WEIGHTS;
type StructuralSignals = Record<StructuralSignal, number>;

const ANCHOR_KEYWORD_PATTERN = /(testid|codegen|browsername|dotenv|toollist|mcp|selector|config|timeout|internal|attr)/i;
const PUBLIC_QUERY_PATTERN = /(getby|findby|queryby|bytext|bylabel|byrole|testid)/i;
const INTERNAL_ATTRIBUTE_PATTERN = /(internal|attr|attribute|testid)/i;
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

function totalWeight(tokens: string[]): number {
    return tokens.reduce((sum, token) => sum + tokenWeight(token), 0);
}

function weightedOverlap(left: string[], right: string[]): number {
    const leftTokens = uniqueTokens(left);
    const rightTokens = uniqueTokens(right);
    if (!leftTokens.length || !rightTokens.length) {
        return 0;
    }
    const rightSet = new Set(rightTokens);
    const sharedWeight = totalWeight(leftTokens.filter((token) => rightSet.has(token)));
    return (sharedWeight * 2) / (totalWeight(leftTokens) + totalWeight(rightTokens));
}

function focusedWeightedOverlap(reference: string[], candidate: string[]): number {
    const candidateTokens = uniqueTokens(candidate);
    if (!reference.length || !candidateTokens.length) {
        return 0;
    }
    const referenceSet = new Set(reference);
    return totalWeight(candidateTokens.filter((token) => referenceSet.has(token))) / totalWeight(candidateTokens);
}

function anchorOverlap(source: DocumentProfile, candidate: DocumentProfile): number {
    return Math.min(MAX_ANCHOR_SCORE, Math.max(
        overlapCoefficient(source.exports, candidate.imports),
        overlapCoefficient(source.exports, candidate.testNames),
        focusedWeightedOverlap(source.rareAnchorTokens, candidate.rareAnchorTokens),
        weightedOverlap(source.rareAnchorTokens, candidate.rareAnchorTokens),
        diceCoefficient(source.phraseTokens, candidate.rareAnchorTokens),
    ));
}

function isConfigPathFamily(token: string): boolean {
    return token === 'config' || token.endsWith('/config') || token.includes('config/');
}

function interfaceOverlap(source: DocumentProfile, candidate: DocumentProfile): number {
    const sourceExposesInterface = source.commandTokens.length > 0 || source.optionTokens.length > 0;
    const sourceInterfaceTokens = sourceExposesInterface
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
    const sourceOrchestratesConfig = source.optionTokens.length >= MIN_ORCHESTRATION_OPTION_COUNT
        && candidate.pathFamilyTokens.some(isConfigPathFamily);
    const orchestrationConfigScore = sourceOrchestratesConfig
        ? Math.max(
            focusedWeightedOverlap(source.optionTokens, candidateInterfaceTokens),
            overlapCoefficient(source.optionTokens, candidateInterfaceTokens),
            ORCHESTRATION_CONFIG_FLOOR
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
    const sourceAnchors = [...source.exports, ...source.rareAnchorTokens];
    const candidateAnchors = [...candidate.rareAnchorTokens, ...candidate.testNames];
    const consumerAnchorScore = Math.max(
        focusedWeightedOverlap(sourceAnchors, candidateAnchors),
        weightedOverlap(sourceAnchors, candidateAnchors),
    );
    const sourceIsPublicQuery = source.exports.some((token) => PUBLIC_QUERY_PATTERN.test(token));
    const candidateIsEndUserSurface = END_USER_SURFACE_FAMILIES.some((family) => candidate.pathFamilyTokens.includes(family));
    const endUserSurfaceScore = sourceIsPublicQuery && consumerAnchorScore > MIN_CONSUMER_ANCHOR_SCORE && candidateIsEndUserSurface
        ? END_USER_SURFACE_SCORE
        : 0;

    return Math.max(baseScore, endUserSurfaceScore);
}

function changeOverlap(source: DocumentProfile, candidate: DocumentProfile): number {
    if (!hasChangeEvidence(source)) {
        return 0;
    }

    const changeTokenGroups = [source.changeTokens, source.changePhraseTokens].filter((tokens) => tokens.length > 0);
    const averageChangeCoverage = (candidateTokens: string[]): number => {
        const coverages = changeTokenGroups.map((tokens) => focusedWeightedOverlap(candidateTokens, tokens));
        return coverages.reduce((sum, coverage) => sum + coverage, 0) / coverages.length;
    };
    const publicFalloutTokens = uniqueTokens([...candidate.stemTokens, ...candidate.testNames]);
    const internalChangeTokens = uniqueTokens([
        ...candidate.rareAnchorTokens,
        ...candidate.phraseTokens,
        ...candidate.semanticTokens,
        ...candidate.contentTokens,
        ...candidate.lateCallTokens,
    ]);

    const candidateMentionsSource = [...candidate.stemTokens, ...candidate.contentTokens, ...candidate.lateCallTokens]
        .some((token) => source.stemTokens.includes(token));
    const evidenceWeight = candidateMentionsSource ? 1 : UNALIGNED_CHANGE_EVIDENCE_WEIGHT;
    const publicFalloutScore = averageChangeCoverage(publicFalloutTokens) * evidenceWeight;

    const changedTokens = uniqueTokens([...source.changeTokens, ...source.changePhraseTokens]);
    const codegenSeesInternalChange = candidate.pathFamilyTokens.includes('codegen')
        && changedTokens.some((token) => INTERNAL_ATTRIBUTE_PATTERN.test(token));
    const internalCoverage = averageChangeCoverage(internalChangeTokens);
    const internalChangeScore = codegenSeesInternalChange
        ? Math.min(1, internalCoverage + CODEGEN_INTERNAL_CHANGE_BONUS)
        : internalCoverage;

    return Math.max(publicFalloutScore, internalChangeScore * evidenceWeight);
}

function structuralSignals(source: DocumentProfile, candidate: DocumentProfile): StructuralSignals {
    return {
        changeScore: changeOverlap(source, candidate),
        phraseScore: weightedOverlap(source.phraseTokens, candidate.phraseTokens),
        anchorScore: anchorOverlap(source, candidate),
        semanticScore: overlapCoefficient(source.semanticTokens, candidate.semanticTokens),
        interfaceScore: interfaceOverlap(source, candidate),
        pathFamilyScore: pathFamilyOverlap(source, candidate),
        stemScore: overlapCoefficient(source.stemTokens, candidate.stemTokens),
        basenameScore: overlapCoefficient(source.basenameTokens, candidate.basenameTokens),
    };
}

function blendStructuralSignals(signals: StructuralSignals, sourceHasChangeEvidence: boolean): number {
    const weights = sourceHasChangeEvidence ? STRUCTURAL_WEIGHTS : { ...STRUCTURAL_WEIGHTS, changeScore: 0 };
    let weightedSum = 0;
    let weightTotal = 0;
    for (const signal of Object.keys(weights) as StructuralSignal[]) {
        weightedSum += signals[signal] * weights[signal];
        weightTotal += weights[signal];
    }
    return clamp(weightedSum / weightTotal, 0, 1);
}

export function rankMatches(source: RankedMatchSource, candidates: RankedMatchCandidate[]): MatchCandidate[] {
    const sourceHasChangeEvidence = hasChangeEvidence(source.profile);
    return candidates
        .map((item) => {
            const signals = structuralSignals(source.profile, item.profile);
            const structuralScore = blendStructuralSignals(signals, sourceHasChangeEvidence);
            const modelScore = item.modelScore ?? item.jevScore;
            const blendedScore = modelScore === undefined
                ? structuralScore
                : (modelScore * MODEL_WEIGHT) + (structuralScore * (1 - MODEL_WEIGHT));

            return {
                file: item.file,
                score: Math.min(1, Math.max(0, blendedScore)),
                preview: item.preview,
                structuralScore,
                stemScore: signals.stemScore,
                basenameScore: signals.basenameScore,
                semanticScore: signals.semanticScore,
                anchorScore: signals.anchorScore,
                interfaceScore: signals.interfaceScore,
                phraseScore: signals.phraseScore,
                pathFamilyScore: signals.pathFamilyScore,
                changeScore: signals.changeScore,
                modelScore,
                jevScore: item.jevScore,
            };
        })
        .sort(byScoreThenFile);
}

export function byScoreThenFile(a: { score: number; file: string }, b: { score: number; file: string }): number {
    return b.score - a.score || a.file.localeCompare(b.file);
}

export function attachModelScores(
    candidates: RankedMatchCandidate[],
    result: ModelScoreResult | undefined,
    ranker: Ranker
): RankedMatchCandidate[] {
    if (!result) {
        return candidates;
    }
    return candidates.map((candidate) => {
        const modelScore = result.scores.get(candidate.file);
        return { ...candidate, modelScore, jevScore: ranker === 'jev' ? modelScore : undefined };
    });
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

export interface SelectionResult {
    results: MatchCandidate[];
    eligibleCount: number;
    truncated: boolean;
    effectiveLimit: number | null;
    reason?: string;
    evidence?: SelectionEvidence;
}

function providerLabel(ranker: Ranker): string {
    return ranker === 'decisions' ? 'Decisions' : 'Jev';
}

function usableModelScore(match: MatchCandidate): number | undefined {
    const score = match.modelScore ?? match.jevScore;
    return score !== undefined && Number.isFinite(score) && score >= 0 && score <= 1 ? score : undefined;
}

function isModelAffirmative(match: MatchCandidate): boolean {
    return (usableModelScore(match) ?? 0) >= TARGETED_MODEL_THRESHOLD;
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

function selectAdaptive(matches: MatchCandidate[], topK: number | undefined, ranker: Ranker): SelectionResult {
    const structuralScores = matches.map((match) => match.structuralScore).sort((a, b) => b - a);
    const strongestStructural = structuralScores[0] ?? 0;
    const affirmative = ranker !== 'heuristics' ? matches.filter(isModelAffirmative) : [];
    const strongestModel = matches.reduce((best, match) => Math.max(best, usableModelScore(match) ?? 0), 0);
    const modelUncertain = ranker === 'heuristics' || strongestModel < STRONG_MODEL_SCORE;

    if (modelUncertain && strongestStructural < MIN_STRUCTURAL_NEIGHBOR_SCORE) {
        return capSelection(matches, topK, `No strong ${providerLabel(ranker)} or structural evidence; all candidates retained`, {
            affirmativeCount: affirmative.length,
            structuralNeighborCount: 0,
            structuralCutoff: 0,
            uncertaintyRetainedCount: matches.length - affirmative.length,
        });
    }

    const neighborShare = modelUncertain ? NEIGHBOR_SHARE_WHEN_MODEL_UNCERTAIN : NEIGHBOR_SHARE_WHEN_MODEL_CONFIDENT;
    const neighborRank = Math.max(0, Math.ceil(structuralScores.length * neighborShare) - 1);
    const structuralCutoff = Math.max(MIN_STRUCTURAL_NEIGHBOR_SCORE, structuralScores[neighborRank] ?? 1);
    const affirmativeFiles = new Set(affirmative.map((match) => match.file));
    const eligible = matches.filter((match) =>
        affirmativeFiles.has(match.file) || match.structuralScore >= structuralCutoff
    );
    const reason = modelUncertain ? `No strong ${providerLabel(ranker)} answer; structural coverage widened` : undefined;
    return capSelection(eligible, topK, reason, {
        affirmativeCount: affirmative.length,
        structuralNeighborCount: eligible.length - affirmative.length,
        structuralCutoff,
    });
}

export function selectMatches(
    matches: MatchCandidate[],
    topK: number | undefined,
    policy: Exclude<SelectionPolicy, 'representative'>,
    ranker: Ranker
): SelectionResult {
    if (policy === 'adaptive') {
        return selectAdaptive(matches, topK, ranker);
    }

    const limit = topK ?? DEFAULT_CAPPED_SELECTION_SIZE;
    if (policy === 'conservative') {
        return capSelection(matches, limit);
    }

    if (ranker === 'heuristics') {
        return capSelection(matches, limit, 'Jev is unavailable; conservative selection retained');
    }
    const affirmative = matches.filter(isModelAffirmative);
    return affirmative.length
        ? capSelection(affirmative, limit)
        : capSelection(matches, limit, `No affirmative ${providerLabel(ranker)} answer; conservative selection retained`);
}
