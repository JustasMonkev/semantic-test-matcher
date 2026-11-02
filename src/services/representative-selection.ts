import { interleaveUniqueTokens } from '../utils/arrays.ts';
import type { DocumentProfile } from './document-profile.ts';
import { byScoreThenFile, type MatchCandidate } from './match.ts';

const BEHAVIOUR_TOKEN_LIMIT = 256;
const REPRESENTATIVE_WARNING = 'Representative selection can miss relevant or failing tests; run the full suite before merging.';
export const REPRESENTATIVE_TOP_K_REQUIRED = 'Representative selection requires an explicit positive integer --top-k (or its config/environment equivalent).';

export interface RepresentativeSelection {
    results: MatchCandidate[];
    selectionPolicy: 'representative';
    eligibilityPolicy: 'adaptive';
    eligibleCount: number;
    selectionLimit: number;
    selectionTruncated: boolean;
    selectionMethod: 'greedy-medoid';
    selectionObjective: {
        metric: 'jaccard';
        value: number;
        tokenLimit: number;
        truncatedProfileCount: number;
        emptyProfileCount: number;
    };
    selectionWarning: string;
}

function behaviourTokens(profile: DocumentProfile): string[] {
    return interleaveUniqueTokens([
        profile.testNames,
        profile.imports,
        profile.commandTokens,
        profile.optionTokens,
        profile.lateCallTokens,
        profile.contentTokens,
    ], BEHAVIOUR_TOKEN_LIMIT + 1);
}

function jaccardDistance(left: Set<string>, right: Set<string>): number {
    let shared = 0;
    for (const token of left) {
        if (right.has(token)) {
            shared += 1;
        }
    }
    const union = left.size + right.size - shared;
    return union === 0 ? 0 : 1 - shared / union;
}

function distanceMatrix(tokenSets: Set<string>[]): Float64Array[] {
    const distances = tokenSets.map(() => new Float64Array(tokenSets.length));
    for (let left = 0; left < tokenSets.length; left += 1) {
        for (let right = left + 1; right < tokenSets.length; right += 1) {
            const distance = jaccardDistance(tokenSets[left], tokenSets[right]);
            distances[left][right] = distance;
            distances[right][left] = distance;
        }
    }
    return distances;
}

function greedyMedoids(distances: Float64Array[], budget: number): { selected: number[]; nearest: Float64Array } {
    const count = distances.length;
    const nearest = new Float64Array(count).fill(1);
    const selected: number[] = [];
    const chosen = new Set<number>();
    const costIfAdded = (candidate: number) => {
        let cost = 0;
        for (let target = 0; target < count; target += 1) {
            cost += Math.min(nearest[target], distances[candidate][target]);
        }
        return cost;
    };

    while (selected.length < budget) {
        let best = -1;
        let bestCost = Infinity;
        for (let candidate = 0; candidate < count; candidate += 1) {
            if (chosen.has(candidate)) {
                continue;
            }
            const cost = costIfAdded(candidate);
            if (cost < bestCost) {
                best = candidate;
                bestCost = cost;
            }
        }
        chosen.add(best);
        selected.push(best);
        for (let target = 0; target < count; target += 1) {
            nearest[target] = Math.min(nearest[target], distances[best][target]);
        }
    }
    return { selected, nearest };
}

function selectAll(count: number): { selected: number[]; nearest: Float64Array } {
    return { selected: Array.from({ length: count }, (_, index) => index), nearest: new Float64Array(count) };
}

export function selectRepresentatives(
    matches: MatchCandidate[],
    profiles: ReadonlyMap<string, DocumentProfile>,
    topK: number | undefined
): RepresentativeSelection {
    if (topK === undefined || !Number.isSafeInteger(topK) || topK < 1) {
        throw new Error(REPRESENTATIVE_TOP_K_REQUIRED);
    }
    const candidates = [...matches].sort(byScoreThenFile);
    const tokenLists = candidates.map((candidate) => {
        const profile = profiles.get(candidate.file);
        if (!profile) {
            throw new Error(`Missing document profile for ${candidate.file}`);
        }
        return behaviourTokens(profile);
    });
    const tokenSets = tokenLists.map((tokens) => new Set(tokens.slice(0, BEHAVIOUR_TOKEN_LIMIT)));
    const { selected, nearest } = topK < candidates.length
        ? greedyMedoids(distanceMatrix(tokenSets), topK)
        : selectAll(candidates.length);

    return {
        results: selected.map((index) => candidates[index]),
        selectionPolicy: 'representative',
        eligibilityPolicy: 'adaptive',
        eligibleCount: candidates.length,
        selectionLimit: topK,
        selectionTruncated: candidates.length > topK,
        selectionMethod: 'greedy-medoid',
        selectionObjective: {
            metric: 'jaccard',
            value: nearest.reduce((sum, distance) => sum + distance, 0),
            tokenLimit: BEHAVIOUR_TOKEN_LIMIT,
            truncatedProfileCount: tokenLists.filter((tokens) => tokens.length > BEHAVIOUR_TOKEN_LIMIT).length,
            emptyProfileCount: tokenSets.filter((tokens) => tokens.size === 0).length,
        },
        selectionWarning: REPRESENTATIVE_WARNING,
    };
}
