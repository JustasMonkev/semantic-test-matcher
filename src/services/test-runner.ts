import spawn from 'cross-spawn';
import fs from 'node:fs/promises';
import { constants } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { commandArguments } from '../utils/shell.ts';
import { OPENAI_API_KEY_NAMES } from './decisions.ts';
import { JEV_API_KEY_NAMES } from './jev.ts';

const SCRIPT_ACCEPTING_TEST_PATHS = /^(?:vitest|jest|playwright test|mocha)(?:\s|$)/;
const SHELL_OPERATORS = /[&|;<>$`]/;
const PROVIDER_KEY_NAMES: readonly string[] = [...JEV_API_KEY_NAMES, ...OPENAI_API_KEY_NAMES];
const COMMAND_FOR_DEPENDENCY: Array<[dependency: string, command: string]> = [
    ['vitest', 'npx vitest run'],
    ['jest', 'npx jest'],
    ['@playwright/test', 'npx playwright test'],
    ['mocha', 'npx mocha'],
];

const OPTIONS_TAKING_A_VALUE: Record<string, ReadonlySet<string>> = {
    jest: new Set([
        '-c', '--config', '--rootDir', '--roots', '--selectProjects', '--ignoreProjects', '-t', '--testNamePattern',
        '--testEnvironment', '--env', '-w', '--maxWorkers', '--maxConcurrency', '--reporters', '--shard',
        '--testTimeout', '--outputFile', '--coverageDirectory', '--coverageProvider', '--seed', '--cacheDirectory',
    ]),
    vitest: new Set([
        '-c', '--config', '-r', '--root', '--dir', '--project', '--reporter', '--outputFile', '--environment',
        '--pool', '--shard', '--mode', '-t', '--testNamePattern', '--maxWorkers', '--testTimeout', '--retry',
    ]),
    playwright: new Set([
        '-c', '--config', '--project', '--reporter', '-j', '--workers', '-g', '--grep', '--grep-invert', '--shard',
        '--timeout', '--retries', '--output', '--repeat-each', '--max-failures', '--trace', '--browser',
        '--global-timeout', '--tsconfig',
    ]),
    mocha: new Set([
        '--config', '--package', '-r', '--require', '-R', '--reporter', '-O', '--reporter-option', '-t', '--timeout',
        '-s', '--slow', '-g', '--grep', '-f', '--fgrep', '-u', '--ui', '--extension', '--ignore', '--exclude',
        '-j', '--jobs', '--retries', '-n', '--node-option',
    ]),
};
const OPTIONS_NAMING_TEST_FILES = new Set(['--spec', '--file', '--testPathPattern', '--testPathPatterns', '--testMatch']);

function runnerWordCount(args: string[]): number {
    return args[0] === 'playwright' || (args[0] === 'vitest' && args[1] === 'run') ? 2 : 1;
}

function scriptMayAlreadyNameTestPaths(script: string): boolean {
    let args: string[];
    try {
        args = commandArguments(script);
    } catch {
        return true;
    }
    const optionsTakingAValue = OPTIONS_TAKING_A_VALUE[args[0]] ?? new Set<string>();
    for (let index = runnerWordCount(args); index < args.length; index += 1) {
        const arg = args[index];
        const [optionName] = arg.split('=', 1);
        if (!arg.startsWith('-') || OPTIONS_NAMING_TEST_FILES.has(optionName)) {
            return true;
        }
        const valueIsNextArg = !arg.includes('=') && optionsTakingAValue.has(optionName);
        if (valueIsNextArg) {
            index += 1;
        }
    }
    return false;
}

function withVitestRunMode(script: string): string {
    return script.replace(/^vitest(?!\s+run\b)/, 'vitest run');
}

async function readPackageManifest(cwd: string) {
    try {
        return JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) ?? {};
    } catch {
        return undefined;
    }
}

export async function detectTestCommand(cwd: string): Promise<string | undefined> {
    const manifest = await readPackageManifest(cwd);
    if (!manifest) {
        return undefined;
    }
    const script = String(manifest.scripts?.test ?? '').trim();
    if (SCRIPT_ACCEPTING_TEST_PATHS.test(script) && !SHELL_OPERATORS.test(script) && !scriptMayAlreadyNameTestPaths(script)) {
        return `npx ${withVitestRunMode(script)}`;
    }
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    return COMMAND_FOR_DEPENDENCY.find(([dependency]) => dependency in dependencies)?.[1];
}

function environmentWithoutProviderKeys(): NodeJS.ProcessEnv {
    return Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !PROVIDER_KEY_NAMES.includes(name.toUpperCase()))
    );
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
    if (code !== null) {
        return code;
    }
    return signal ? 128 + constants.signals[signal] : 1;
}

export async function runSelectedTests(command: string, files: string[], cwd: string): Promise<number> {
    const runnerWouldRunWholeSuite = !files.length;
    if (runnerWouldRunWholeSuite) {
        return 0;
    }
    const [executable, ...args] = commandArguments(command);
    const testPaths = [...new Set(files.map((file) => path.resolve(cwd, file)))];
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [...args, ...testPaths], {
            cwd,
            env: environmentWithoutProviderKeys(),
            stdio: 'inherit',
            shell: false,
        });
        const interrupt = () => { child.kill('SIGINT'); };
        const terminate = () => { child.kill('SIGTERM'); };
        const stopForwardingSignals = () => {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
        };
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        child.once('error', (error) => {
            stopForwardingSignals();
            reject(error);
        });
        child.once('close', (code, signal) => {
            stopForwardingSignals();
            resolve(exitCodeOf(code, signal));
        });
    });
}

const SIGINT_EXIT_CODE = 130;

async function askForTestCommand(suggestion: string | undefined): Promise<string | undefined> {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    prompt.on('SIGINT', () => controller.abort());
    prompt.once('close', () => controller.abort());
    try {
        const answer = prompt.question(
            suggestion
                ? '\nTest command (Enter to run, clear the line to skip): '
                : '\nTest command (e.g. npx playwright test, npx vitest run, node --test; Enter to skip): ',
            { signal: controller.signal },
        );
        if (suggestion) {
            prompt.write(suggestion);
        }
        return await answer;
    } catch (error) {
        if (controller.signal.aborted) {
            return undefined;
        }
        throw error;
    } finally {
        prompt.close();
    }
}

export async function promptAndRunTests(files: string[], cwd: string): Promise<number> {
    if (!files.length) {
        return 0;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('Test execution needs an interactive terminal. Use --json or --paths-only for selection without running tests.');
    }
    const command = await askForTestCommand(await detectTestCommand(cwd));
    if (command === undefined) {
        return SIGINT_EXIT_CODE;
    }
    if (!command.trim()) {
        console.log('Tests not run.');
        return 0;
    }
    return runSelectedTests(command, files, cwd);
}
