export function mergeArrays(left: string[] = [], right: string[] = []): string[] {
    if (!left.length) {
        return right;
    }
    if (!right.length) {
        return left;
    }
    return [...new Set([...left, ...right])];
}

export function interleaveUniqueTokens(groups: string[][], limit: number): string[] {
    const tokens = new Set<string>();
    const longestGroup = Math.max(0, ...groups.map((group) => group.length));

    for (let index = 0; index < longestGroup && tokens.size < limit; index += 1) {
        for (const group of groups) {
            if (tokens.size >= limit) {
                break;
            }
            if (index < group.length) {
                tokens.add(group[index]);
            }
        }
    }

    return [...tokens];
}
