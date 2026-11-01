import type { Command } from 'commander';
import type { RootOptions } from '../config.ts';
import { buildDocumentProfile, type DocumentProfile } from '../services/document-profile.ts';
import type { RankedMatchCandidate } from '../services/match.ts';
import { mapWithConcurrency } from '../utils/async.ts';
import { readCandidateText } from '../utils/files.ts';
import { readFileIfExists } from '../utils/io.ts';

const READ_CONCURRENCY = 8;

export const RANKER_OPTION_DESCRIPTION = 'jev (TypeSafe API, default; key from TYPESAFE_API_KEY or JEF) '
    + 'decisions (OpenAI API; key from OPENAI_API_KEY or OPEN_AI), or heuristics (local only)';

export interface SourceDocument {
    text: string;
    profile: DocumentProfile;
    missingWithoutDeletionDiff: boolean;
}

export function rootOptionsOf(program: Command): RootOptions {
    const { config, cacheDir, logLevel, verbose, quiet } = program.opts<RootOptions>();
    return { config, cacheDir, logLevel, verbose, quiet };
}

export async function loadCandidates(candidateFiles: string[], cwd: string): Promise<RankedMatchCandidate[]> {
    const candidates = await mapWithConcurrency(candidateFiles, READ_CONCURRENCY, async (candidatePath) => {
        const text = await readCandidateText(candidatePath);
        if (text === undefined) {
            return undefined;
        }
        const profile = buildDocumentProfile(candidatePath, text, cwd);
        return { file: profile.relativePath, preview: profile.preview, profile };
    });
    return candidates.filter((candidate) => candidate !== undefined);
}

export async function readSourceDocument(
    absolutePath: string,
    cwd: string,
    diffText: string | undefined,
    diffRoot: string | undefined
): Promise<SourceDocument> {
    const fileText = await readFileIfExists(absolutePath);
    const text = fileText ?? '';
    const profile = buildDocumentProfile(absolutePath, text, cwd, diffText, diffRoot);
    return { text, profile, missingWithoutDeletionDiff: fileText === undefined && !profile.diffExcerpt };
}
