# Repository Guidelines

## Project Structure & Module Organization

This TypeScript CLI exposes `rbt`, which ranks test files for source changes using Jev and local structural heuristics.

- `src/cli.ts`: CLI entry point; `src/commands/`: command handlers.
- `src/config.ts`: configuration resolution.
- `src/services/`: scoring, document profiling, Git/diff handling, caching, and test execution.
- `src/utils/`: reusable path, file, collection, and shell helpers.
- `tests/`: automated unit and command-level tests.
- `dist/`: generated build output; do not edit or commit it.

## Build, Test, and Development Commands

Use a Node version supporting `--experimental-strip-types` for development and tests; the package declares Node >=20.

- `npm install`: install dependencies.
- `npm run dev -- status`: run the CLI from TypeScript in watch mode.
- `npm run lint`: run TypeScript checks without emitting files; this is not a style linter.
- `npm test`: run all `tests/**/*.test.ts` with Node’s built-in runner.
- `npm run build`: compile source into `dist/`.
- `npm start -- status --json`: inspect configuration through the compiled CLI.

## Coding Style & Naming Conventions

Follow existing TypeScript: four-space indentation, single quotes, semicolons, and ES modules. Keep strict typing and explicit `.ts` extensions in relative source imports. Use camelCase for functions and variables, PascalCase for types, and kebab-case for multiword filenames. Keep command orchestration separate from scoring and utility logic. No dedicated formatter or ESLint configuration is present.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Name files `tests/<module>.test.ts` and describe observable behavior in test names. Run a focused file with `node --experimental-strip-types --test tests/config.test.ts`. Stub TypeSafe requests; tests should not require network access or credentials. Cover changed behavior, edge cases, and failure paths. No numeric coverage threshold is configured. Before submitting, run lint, tests, and build.

## Commit & Pull Request Guidelines

Recent commits use imperative subjects such as “Resolve diff paths from selected root”; no mandatory prefix convention is evident. Keep changes focused. In PR descriptions, explain behavior changes, link relevant issues, and list verification commands and results. Include CLI output examples when output changes, and update README documentation for public options.

## Security & Configuration

Keep `TYPESAFE_API_KEY` in the environment and never commit credentials. Use `--ranker heuristics` for local-only ranking; Jev sends change metadata to TypeSafe. Preserve configuration precedence: flags, environment, config file, then defaults.
