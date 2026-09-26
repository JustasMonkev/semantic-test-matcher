import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

// Test scripts that take test file paths as trailing arguments.
const RUNNER_SCRIPT = /^(?:vitest|jest|playwright test|mocha)(?:\s|$)/;
// Chained, piped, or expanded scripts would not pass file paths through intact.
const SHELL_SYNTAX = /[&|;<>$`]/;
const RUNNER_DEPENDENCIES: Array<[string, string]> = [
    ['vitest', 'npx vitest run'],
    ['jest', 'npx jest'],
    ['@playwright/test', 'npx playwright test'],
    ['mocha', 'npx mocha'],
];

/** Guesses the command that runs chosen test files, from package.json; undefined when unsure. */
export async function detectTestCommand(cwd: string): Promise<string | undefined> {
    let manifest;
    try {
        manifest = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) ?? {};
    } catch {
        // No readable package.json means no guess; the user can still type a command.
        return undefined;
    }
    const script = String(manifest.scripts?.test ?? '').trim();
    if (RUNNER_SCRIPT.test(script) && !SHELL_SYNTAX.test(script)) {
        // Plain `vitest` starts watch mode; `vitest run` exits when the tests finish.
        return `npx ${script.replace(/^vitest(?!\s+run\b)/, 'vitest run')}`;
    }
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    return RUNNER_DEPENDENCIES.find(([name]) => name in dependencies)?.[1];
}

/** Quotes an argument so a printed command can be pasted into a POSIX shell. */
export function quoteShellArgument(value: string): string {
    return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// Accept quoted arguments, but never evaluate shell syntax or expand variables.
function commandArguments(command: string): string[] {
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

export async function runSelectedTests(command: string, files: string[], cwd: string): Promise<number> {
    // Many runners interpret an empty file list as "run the entire suite".
    if (!files.length) return 0;
    const [executable, ...args] = commandArguments(command);
    const testPaths = [...new Set(files.map(file => path.resolve(cwd, file)))];
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [...args, ...testPaths], { cwd, stdio: 'inherit', shell: false });
        const interrupt = () => { child.kill('SIGINT'); };
        const terminate = () => { child.kill('SIGTERM'); };
        const cleanup = () => {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
        };
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        child.once('error', (error) => {
            cleanup();
            reject(error);
        });
        child.once('close', (code, signal) => {
            cleanup();
            resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
        });
    });
}

export async function promptAndRunTests(files: string[], cwd: string): Promise<number> {
    if (!files.length) return 0;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('Test execution needs an interactive terminal. Use --json or --paths-only for selection without running tests.');
    }
    const suggestion = await detectTestCommand(cwd);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    prompt.on('SIGINT', () => controller.abort());
    prompt.once('close', () => controller.abort());
    let command: string;
    try {
        const answer = prompt.question(
            suggestion
                ? '\nTest command (Enter to run, clear the line to skip): '
                : '\nTest command (e.g. npx playwright test, npx vitest run, node --test; Enter to skip): ',
            { signal: controller.signal },
        );
        // Pre-fill the detected command so the user can run, edit, or clear it.
        if (suggestion) prompt.write(suggestion);
        command = await answer;
    } catch (error) {
        if (controller.signal.aborted) return 130;
        throw error;
    } finally {
        prompt.close();
    }
    if (!command.trim()) {
        console.log('Tests not run.');
        return 0;
    }
    return runSelectedTests(command, files, cwd);
}
