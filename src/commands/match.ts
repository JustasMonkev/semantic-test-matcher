import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig, type MatchCommandOptions, type Ranker, type RootOptions, type RuntimeConfig } from '../config.ts';
import { getDecisionsCacheEntryCount } from '../services/decisions.ts';
import { isTestLike, isTestLikeSource } from '../services/document-profile.ts';
import { readGitChanges } from '../services/git-changes.ts';
import { getJevCacheEntryCount } from '../services/jev.ts';
import {
    attachModelScores,
    byScoreThenFile,
    filterMatches,
    rankMatches,
    selectMatches,
    TARGETED_MODEL_THRESHOLD,
    type MatchCandidate,
    type RankedMatchCandidate,
} from '../services/match.ts';
import { createScorerFromConfig } from '../services/model-scorer-factory.ts';
import { ModelScorerError, type ModelScorer, type ModelScoreResult } from '../services/model-scorer.ts';
import { selectRepresentatives, type RepresentativeSelection } from '../services/representative-selection.ts';
import { detectTestCommand, promptAndRunTests } from '../services/test-runner.ts';
import { listDiffFiles, resolveDiffRoot } from '../services/unified-diff.ts';
import { collectCandidateFiles, isAllowedFile, MAX_CANDIDATE_FILES, readCandidateText } from '../utils/files.ts';
import { parseStdinList, readStdinText } from '../utils/io.ts';
import { findPathsOutside } from '../utils/paths.ts';
import { quoteShellArgument } from '../utils/shell.ts';
import { loadCandidates, RANKER_OPTION_DESCRIPTION, readSourceDocument, rootOptionsOf, type SourceDocument } from './shared.ts';

interface MatchOptions extends MatchCommandOptions {
    diffFile?: string;
    diffRoot?: string;
    json?: boolean;
    pathsOnly?: boolean;
    candidatesFromStdin?: boolean;
}

interface ChangedFiles {
    isAutomatic: boolean;
    paths: string[];
    diffText?: string;
    diffRoot?: string;
}

interface ChangedSource extends SourceDocument {
    file: string;
}

interface ChangeJob {
    source: ChangedSource;
    candidates: RankedMatchCandidate[];
}

type RemoteRanker = Exclude<Ranker, 'heuristics'>;

interface RankerAttempt {
    ranker: Ranker;
    status: 'succeeded' | 'failed';
    reason?: string;
}

interface RankingOutcome {
    ranker: Ranker;
    rankerFallback?: string;
    attempts: RankerAttempt[];
    modelResults: ModelScoreResult[];
}

type ChangeReport = ReturnType<typeof buildChangeReport>;

interface FinalSelection {
    selected: MatchCandidate[];
    reports: ChangeReport[];
    representative?: RepresentativeSelection;
}

function appendValue(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

export function registerMatchCommand(program: Command): void {
    program
        .command('match')
        .description('Match code change to test cases')
        .argument('[files...]', 'Changed file paths (default: --diff-file changes, or local Git changes followed by a test-command prompt)')
        .option('-t, --threshold <number>', 'Minimum similarity threshold')
        .option('--min-score <number>', 'Minimum similarity score override')
        .option('--top-k <number>', 'Optional maximum number of selected tests')
        .option('--selection-policy <name>', 'adaptive (default), conservative, targeted, or representative (requires --top-k; may miss tests)')
        .option('-c, --candidates <pattern>', 'Candidate file path, directory, or file glob (repeat for several)', appendValue)
        .option('--include-file <pattern>', 'Include only matching files (glob pattern; repeat for several)', appendValue)
        .option('--exclude-file <pattern>', 'Exclude matching files (glob pattern; repeat for several)', appendValue)
        .option('--candidates-from-stdin', 'Read candidate file list (JSON array or newline list) from stdin')
        .option('--ranker <name>', RANKER_OPTION_DESCRIPTION)
        .option('--jev-model <id>', 'TypeSafe Jev model id')
        .option('--decisions-model <id>', 'OpenAI Decisions model id')
        .option('--fallback-ranker <name>', 'heuristics (default), or decisions (only with jev)')
        .option('--cache-dir <path>', 'Directory used to cache provider answers')
        .option('--diff-file <path>', 'Unified diff file used to enrich change-aware matching')
        .option('--diff-root <path>', 'Base directory for relative paths in --diff-file')
        .option('--json', 'Print machine-readable output')
        .option('--paths-only', 'Print only the selected test paths, one per line')
        .action((files: string[], options: MatchOptions) => runMatch(files, options, rootOptionsOf(program)));
}

async function runMatch(files: string[], options: MatchOptions, rootOptions: RootOptions): Promise<void> {
    const config = await resolveMatchConfig(rootOptions, options);
    const cwd = process.cwd();
    const changes = await resolveChangedFiles(files, options, cwd);
    if (!changes.paths.length) {
        printNoChanges(options, config);
        return;
    }

    const candidateScan = await collectCandidateFiles(
        config.match.candidatePaths,
        config.match.includePatterns,
        config.match.excludePatterns,
        cwd,
        changes.isAutomatic ? (file) => isRunnableCandidate(file, cwd) : undefined
    );
    const candidates = await loadCandidates(candidateScan.files, cwd);
    const jobs = await prepareChangeJobs(changes, candidates, cwd);
    const ranking = await scoreWithProviderChain(jobs, changes, config);
    const reports = jobs.map((job, index) =>
        buildChangeReport(job, ranking, ranking.modelResults[index], config, candidateScan.truncated)
    );
    const cacheEntries = await countProviderCacheEntries(ranking, config);
    const final = finalizeSelection(reports, candidates, config);

    if (options.json) {
        printJson(final, cacheEntries);
        return;
    }
    if (options.pathsOnly) {
        final.selected.forEach((match) => console.log(match.file));
        return;
    }
    printText(final, config, candidateScan.truncated);
    if (final.selected.length) {
        await runOrSuggestTests(final.selected.map((match) => match.file), changes.isAutomatic, config.quiet, cwd);
    }
}

async function resolveMatchConfig(rootOptions: RootOptions, options: MatchOptions): Promise<RuntimeConfig> {
    const candidates = options.candidates?.length
        ? options.candidates
        : options.candidatesFromStdin ? parseStdinList(await readStdinText()) : undefined;
    return resolveConfig(rootOptions, { ...options, candidates });
}

async function resolveChangedFiles(files: string[], options: MatchOptions, cwd: string): Promise<ChangedFiles> {
    const diffText = options.diffFile ? await fs.readFile(path.resolve(cwd, options.diffFile), 'utf8') : undefined;
    if (files.length) {
        return { isAutomatic: false, paths: files.map((file) => path.resolve(cwd, file)), diffText, diffRoot: options.diffRoot };
    }
    if (diffText !== undefined) {
        const paths = await listDiffFilesInsideRoot(diffText, cwd, options.diffRoot);
        if (!paths.length) {
            throw new Error('The --diff-file changes no source files');
        }
        return { isAutomatic: false, paths, diffText, diffRoot: options.diffRoot };
    }
    const git = await readGitChanges(cwd);
    return {
        isAutomatic: true,
        paths: await skipGitChangesOutsideRoot(git.files, git.root, cwd),
        diffText: git.diffText,
        diffRoot: git.root,
    };
}

async function listDiffFilesInsideRoot(diffText: string, cwd: string, diffRoot: string | undefined): Promise<string[]> {
    const root = resolveDiffRoot(cwd, diffRoot);
    const files = listDiffFiles(diffText, cwd, diffRoot).filter(isAllowedFile);
    const [outside] = await findPathsOutside(files, root);
    if (outside) {
        throw new Error(`The --diff-file changes ${outside}, which is outside its diff root ${root}`);
    }
    return files;
}

async function skipGitChangesOutsideRoot(files: string[], root: string, cwd: string): Promise<string[]> {
    const outside = new Set(await findPathsOutside(files, root));
    for (const file of outside) {
        console.warn(`Warning: skipping ${path.relative(cwd, file)}, which resolves outside the repository`);
    }
    return files.filter((file) => !outside.has(file));
}

async function isRunnableCandidate(file: string, cwd: string): Promise<boolean> {
    const relativePath = path.relative(cwd, file);
    if (isTestLikeSource(relativePath, '')) {
        return true;
    }
    const text = await readCandidateText(file);
    return text !== undefined && isTestLikeSource(relativePath, text);
}

async function readChangedFile(changedPath: string, changes: ChangedFiles, cwd: string): Promise<ChangedSource> {
    const file = path.relative(cwd, changedPath);
    const document = await readSourceDocument(changedPath, cwd, changes.diffText, changes.diffRoot);
    if (document.missingWithoutDeletionDiff) {
        throw new Error(`Changed file not found: ${file} (pass a --diff-file that deletes it)`);
    }
    return { file, ...document };
}

async function prepareChangeJobs(changes: ChangedFiles, candidates: RankedMatchCandidate[], cwd: string): Promise<ChangeJob[]> {
    const changedPaths = new Set(changes.paths);
    const absolutePathOf = (candidate: RankedMatchCandidate) => path.resolve(cwd, candidate.file);
    const eligible = candidates.filter((candidate) =>
        isTestLike(candidate.profile) || (!changes.isAutomatic && !changedPaths.has(absolutePathOf(candidate)))
    );

    const jobs: ChangeJob[] = [];
    for (const changedPath of changes.paths) {
        jobs.push({
            source: await readChangedFile(changedPath, changes, cwd),
            candidates: changes.isAutomatic
                ? eligible
                : eligible.filter((candidate) => absolutePathOf(candidate) !== changedPath),
        });
    }
    return jobs;
}

function remoteProviderChain(config: RuntimeConfig): RemoteRanker[] {
    if (config.ranker === 'heuristics') {
        return [];
    }
    return config.ranker === 'jev' && config.fallbackRanker === 'decisions' ? ['jev', 'decisions'] : [config.ranker];
}

async function scoreEveryChange(scorer: ModelScorer, jobs: ChangeJob[], diffOnly: boolean): Promise<ModelScoreResult[]> {
    const results: ModelScoreResult[] = [];
    for (const { source, candidates } of jobs) {
        results.push(await scorer.score({ profile: source.profile, text: source.text, diffOnly }, candidates));
    }
    return results;
}

async function scoreWithProviderChain(jobs: ChangeJob[], changes: ChangedFiles, config: RuntimeConfig): Promise<RankingOutcome> {
    const diffOnly = !changes.isAutomatic && changes.diffText !== undefined;
    const chain = remoteProviderChain(config);
    const attempts: RankerAttempt[] = [];
    const failureReasons: string[] = [];
    const rankerFallback = () => (failureReasons.length ? failureReasons.join('; ') : undefined);

    for (const [position, provider] of chain.entries()) {
        let scorer: ModelScorer | undefined;
        try {
            scorer = createScorerFromConfig(provider, config);
            const modelResults = await scoreEveryChange(scorer, jobs, diffOnly);
            attempts.push({ ranker: provider, status: 'succeeded' });
            return { ranker: provider, rankerFallback: rankerFallback(), attempts, modelResults };
        } catch (error) {
            if (!(error instanceof ModelScorerError)) {
                throw error;
            }
            failureReasons.push(error.message);
            attempts.push({ ranker: provider, status: 'failed', reason: error.message });
            const nextRanking = position + 1 < chain.length ? chain[position + 1] : 'heuristics only';
            console.warn(`Warning: ${provider} ranker unavailable (${error.message}); ranking with ${nextRanking}`);
        } finally {
            await scorer?.flush();
        }
    }

    attempts.push({ ranker: 'heuristics', status: 'succeeded' });
    return { ranker: 'heuristics', rankerFallback: rankerFallback(), attempts, modelResults: [] };
}

async function countProviderCacheEntries(ranking: RankingOutcome, config: RuntimeConfig): Promise<number> {
    const cacheRanker = ranking.attempts.filter((attempt) => attempt.ranker !== 'heuristics').pop()?.ranker ?? config.ranker;
    return cacheRanker === 'decisions'
        ? getDecisionsCacheEntryCount(config.cacheDir)
        : getJevCacheEntryCount(config.cacheDir);
}

function reportedModel(modelResult: ModelScoreResult | undefined, ranker: Ranker, config: RuntimeConfig): string | undefined {
    if (!modelResult) {
        return undefined;
    }
    if (modelResult.models.length === 1) {
        return modelResult.models[0];
    }
    return ranker === 'jev' ? config.jevModel : config.decisionsModel;
}

function buildChangeReport(
    job: ChangeJob,
    { ranker, rankerFallback, attempts }: RankingOutcome,
    modelResult: ModelScoreResult | undefined,
    config: RuntimeConfig,
    candidateLimitReached: boolean
) {
    const { selectionPolicy, topK, minScore, threshold } = config.match;
    const isRepresentative = selectionPolicy === 'representative';
    const isTargeted = selectionPolicy === 'targeted';
    const matches = rankMatches({ profile: job.source.profile }, attachModelScores(job.candidates, modelResult, ranker));
    const selection = selectMatches(
        filterMatches(matches, minScore),
        isRepresentative ? undefined : topK,
        isRepresentative ? 'adaptive' : selectionPolicy,
        ranker
    );

    return {
        file: job.source.file,
        ranker,
        requestedRanker: config.ranker,
        effectiveRanker: ranker,
        rankerAttempts: attempts,
        rankerFallback,
        model: reportedModel(modelResult, ranker, config),
        matched: selection.results.length,
        candidateCount: matches.length,
        threshold,
        minScore,
        topK: topK ?? null,
        selectionLimit: selection.effectiveLimit,
        selectionPolicy,
        selectionFallback: isRepresentative ? undefined : selection.reason,
        eligibilityPolicy: isRepresentative ? 'adaptive' : undefined,
        eligibilityReason: isRepresentative ? selection.reason?.replace('all candidates retained', 'all candidates eligible') : undefined,
        eligibleCount: selection.eligibleCount,
        selectionTruncated: selection.truncated,
        selectionEvidence: selection.evidence,
        targetedModelThreshold: isTargeted ? TARGETED_MODEL_THRESHOLD : undefined,
        targetedJevThreshold: isTargeted && ranker !== 'decisions' ? TARGETED_MODEL_THRESHOLD : undefined,
        source: job.source.profile.preview,
        modelScorer: modelResult && {
            provider: ranker,
            modelIdentity: modelResult.modelIdentity,
            requests: modelResult.requests,
            cacheHits: modelResult.cacheHits,
            inputTokens: modelResult.inputTokens,
            outputTokens: modelResult.outputTokens,
            models: modelResult.models,
        },
        jev: ranker === 'jev' && modelResult ? {
            requests: modelResult.requests,
            cacheHits: modelResult.cacheHits,
            inputTokens: modelResult.inputTokens,
            models: modelResult.models,
        } : undefined,
        candidateLimitReached,
        results: selection.results,
    };
}

function mergeSelections(reports: ChangeReport[]): MatchCandidate[] {
    const bestByFile = new Map<string, MatchCandidate>();
    for (const match of reports.flatMap((report) => report.results)) {
        if ((bestByFile.get(match.file)?.score ?? -1) < match.score) {
            bestByFile.set(match.file, match);
        }
    }
    const merged = [...bestByFile.values()].sort(byScoreThenFile);
    const sharedLimit = reports[0]?.selectionLimit;
    return typeof sharedLimit === 'number' ? merged.slice(0, sharedLimit) : merged;
}

function finalizeSelection(reports: ChangeReport[], candidates: RankedMatchCandidate[], config: RuntimeConfig): FinalSelection {
    const merged = mergeSelections(reports);
    if (config.match.selectionPolicy !== 'representative') {
        return { selected: merged, reports };
    }

    const profiles = new Map(candidates.map((candidate) => [candidate.file, candidate.profile]));
    const representative = selectRepresentatives(merged, profiles, config.match.topK);
    const selectedFiles = new Set(representative.results.map((match) => match.file));
    const narrowedReports = reports.map((report) => {
        const results = report.results.filter((match) => selectedFiles.has(match.file));
        return {
            ...report,
            results,
            matched: results.length,
            selectionLimit: representative.selectionLimit,
            selectionTruncated: results.length < report.eligibleCount,
        };
    });
    return { selected: representative.results, reports: narrowedReports, representative };
}

async function runOrSuggestTests(files: string[], isAutomatic: boolean, quiet: boolean, cwd: string): Promise<void> {
    if (isAutomatic) {
        process.exitCode = await promptAndRunTests(files, cwd);
        return;
    }
    if (quiet) {
        return;
    }
    const testCommand = await detectTestCommand(cwd);
    if (testCommand) {
        console.log(`\nRun: ${testCommand} ${files.map(quoteShellArgument).join(' ')}`);
    }
}

function printNoChanges(options: MatchOptions, config: RuntimeConfig): void {
    if (options.json) {
        console.log(JSON.stringify({ files: [], matched: 0, results: [], changes: [] }));
    } else if (!options.pathsOnly && !config.quiet) {
        console.log('No local source changes. Tests not run.');
    }
}

function printJson({ selected, reports, representative }: FinalSelection, cacheEntries: number): void {
    if (reports.length === 1) {
        console.log(JSON.stringify({ ...reports[0], ...representative, cacheEntries }));
        return;
    }
    const [first] = reports;
    console.log(JSON.stringify({
        files: reports.map((report) => report.file),
        ranker: first?.ranker,
        requestedRanker: first?.requestedRanker,
        effectiveRanker: first?.effectiveRanker,
        rankerFallback: first?.rankerFallback,
        rankerAttempts: first?.rankerAttempts,
        matched: selected.length,
        ...representative,
        candidateLimitReached: representative ? reports.some((report) => report.candidateLimitReached) : undefined,
        cacheEntries,
        results: selected,
        changes: reports,
    }));
}

function printSummary({ selected, reports, representative }: FinalSelection, minScore: number, candidateLimitReached: boolean): void {
    if (representative) {
        const objective = representative.selectionObjective.value.toFixed(4);
        console.log(`Representative selection: ${representative.results.length}/${representative.eligibleCount} adaptive-eligible tests; greedy medoid Jaccard objective ${objective}`);
        console.log(`Warning: ${representative.selectionWarning}`);
    }
    for (const report of reports) {
        console.log(`Matched ${report.matched}/${report.candidateCount} candidates for ${report.file}`);
        if (report.eligibilityReason) {
            console.log(`  Adaptive eligibility: ${report.eligibilityReason}`);
        }
        if (report.selectionFallback) {
            console.log(`  Why: ${report.selectionFallback}`);
        }
        if (report.selectionTruncated) {
            console.log(`  Selection capped at ${report.matched} of ${report.eligibleCount} eligible tests`);
        }
    }
    if (candidateLimitReached) {
        console.log(`Candidate scan truncated at ${MAX_CANDIDATE_FILES} files`);
    }
    if (reports.length > 1) {
        console.log(`Selected ${selected.length} tests for ${reports.length} changed files`);
    }
    if (!selected.length) {
        console.log(`No matches reached minimum score ${minScore}`);
    }
}

function printText(final: FinalSelection, config: RuntimeConfig, candidateLimitReached: boolean): void {
    if (!config.quiet) {
        printSummary(final, config.match.minScore, candidateLimitReached);
    }
    for (const match of final.selected) {
        console.log(`${match.score.toFixed(4)} ${match.file}`);
        if (config.verbose && match.preview) {
            console.log(`  ${match.preview}`);
        }
    }
}
