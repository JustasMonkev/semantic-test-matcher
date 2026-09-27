/** Quotes an argument so a printed command can be pasted into a POSIX shell. */
export function quoteShellArgument(value: string): string {
    return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// Accept quoted arguments, but never evaluate shell syntax or expand variables.
export function commandArguments(command: string): string[] {
    const args: string[] = [];
    let word = '';
    // Tracked apart from `word` so an empty quoted argument ("") is still passed.
    let inWord = false;
    let quote = '';
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (!quote && /\s/.test(char)) {
            if (inWord) args.push(word);
            word = '';
            inWord = false;
            continue;
        }
        inWord = true;
        if (char === '\\' && quote !== "'" && /[\s\\"']/.test(command[index + 1] ?? '')) {
            index += 1;
            word += command[index];
        } else if (char === quote) {
            quote = '';
        } else if (!quote && (char === '"' || char === "'")) {
            quote = char;
        } else {
            word += char;
        }
    }
    if (quote) throw new Error('Unclosed quote in test command');
    if (inWord) args.push(word);
    if (!args[0]) throw new Error('A test executable is required');
    return args;
}
