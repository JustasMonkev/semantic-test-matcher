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
    const tokens: string[] = [];
    const seen = new Set<string>();

    for (let index = 0; tokens.length < limit; index += 1) {
        let hasValue = false;
        for (const group of groups) {
            const token = group[index];
            if (token === undefined) {
                continue;
            }
            hasValue = true;
            if (!seen.has(token)) {
                seen.add(token);
                tokens.push(token);
                if (tokens.length === limit) {
                    break;
                }
            }
        }
        if (!hasValue) {
            break;
        }
    }

    return tokens;
}
