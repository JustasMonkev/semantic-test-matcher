const SHELL_SAFE_ARGUMENT = /^[\w@%+=:,./-]+$/;
const WHITESPACE = /\s/;
const ESCAPABLE_AFTER_BACKSLASH = /[\s\\"']/;

export function quoteShellArgument(value: string): string {
    return SHELL_SAFE_ARGUMENT.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandArguments(command: string): string[] {
    const args: string[] = [];
    let word = '';
    let hasWord = false;
    let openQuote = '';
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (!openQuote && WHITESPACE.test(char)) {
            if (hasWord) {
                args.push(word);
            }
            word = '';
            hasWord = false;
            continue;
        }
        hasWord = true;
        const escapesNext = char === '\\' && openQuote !== "'" && ESCAPABLE_AFTER_BACKSLASH.test(command[index + 1] ?? '');
        if (escapesNext) {
            index += 1;
            word += command[index];
        } else if (char === openQuote) {
            openQuote = '';
        } else if (!openQuote && (char === '"' || char === "'")) {
            openQuote = char;
        } else {
            word += char;
        }
    }
    if (openQuote) {
        throw new Error('Unclosed quote in test command');
    }
    if (hasWord) {
        args.push(word);
    }
    if (!args[0]) {
        throw new Error('A test executable is required');
    }
    return args;
}
