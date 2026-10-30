import type { DocumentProfile } from './document-profile.ts';
import type { MatchCandidate } from './match.ts';
import { interleaveUniqueTokens } from '../utils/arrays.ts';

const BEHAVIOUR_TOKEN_LIMIT = 256;
const REPRESENTATIVE_WARNING = 'Representative selection can miss relevant or failing tests; run the full suite before merging.';

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

export function selectRepresentatives(
    matches: MatchCandidate[],
    profiles: ReadonlyMap<string, DocumentProfile>,
    topK: number | undefined
): RepresentativeSelection {
    if (topK === undefined || !Number.isSafeInteger(topK) || topK < 1) {
        throw new Error('Representative selection requires an explicit positive integer --top-k (or its config/environment equivalent).');
    }
    const candidates = [...matches].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    let truncatedProfileCount = 0;
    const tokens = candidates.map((candidate) => {
        const profile = profiles.get(candidate.file);
        if (!profile) throw new Error(`Missing document profile for ${candidate.file}`);
        const values = interleaveUniqueTokens([
            profile.testNames, profile.imports, profile.commandTokens, profile.optionTokens,
            profile.lateCallTokens, profile.contentTokens,
        ], BEHAVIOUR_TOKEN_LIMIT + 1);
        if (values.length > BEHAVIOUR_TOKEN_LIMIT) truncatedProfileCount += 1;
        return new Set(values.slice(0, BEHAVIOUR_TOKEN_LIMIT));
    });
    const count = candidates.length;
    const selected: number[] = [];
    const nearest = new Float64Array(count).fill(1);
    // lazy: O(k n²) greedy heuristic, bounded by the existing 1,000-file candidate scan; no approximation guarantee.
    if (topK < count) {
        const distances = tokens.map(() => new Float64Array(count));
        for (let left = 0; left < count; left += 1) {
            for (let right = left + 1; right < count; right += 1) {
                let shared = 0;
                for (const token of tokens[left]) {
                    if (tokens[right].has(token)) shared += 1;
                }
                const union = tokens[left].size + tokens[right].size - shared;
                const distance = union === 0 ? 0 : 1 - shared / union;
                distances[left][right] = distance;
                distances[right][left] = distance;
            }
        }
        const chosen = new Set<number>();
        while (selected.length < topK) {
            let bestIndex = -1;
            let bestObjective = Infinity;
            for (let candidate = 0; candidate < count; candidate += 1) {
                if (chosen.has(candidate)) continue;
                let objective = 0;
                for (let target = 0; target < count; target += 1) {
                    objective += Math.min(nearest[target], distances[candidate][target]);
                }
                if (objective < bestObjective) {
                    bestIndex = candidate;
                    bestObjective = objective;
                }
            }
            chosen.add(bestIndex);
            selected.push(bestIndex);
            for (let target = 0; target < count; target += 1) {
                nearest[target] = Math.min(nearest[target], distances[bestIndex][target]);
            }
        }
    } else {
        selected.push(...candidates.map((_, index) => index));
        nearest.fill(0);
    }
    return {
        results: selected.map((index) => candidates[index]),
        selectionPolicy: 'representative',
        eligibilityPolicy: 'adaptive',
        eligibleCount: count,
        selectionLimit: topK,
        selectionTruncated: count > topK,
        selectionMethod: 'greedy-medoid',
        selectionObjective: {
            metric: 'jaccard',
            value: nearest.reduce((sum, distance) => sum + distance, 0),
            tokenLimit: BEHAVIOUR_TOKEN_LIMIT,
            truncatedProfileCount,
            emptyProfileCount: tokens.filter((set) => set.size === 0).length,
        },
        selectionWarning: REPRESENTATIVE_WARNING,
    };
}
