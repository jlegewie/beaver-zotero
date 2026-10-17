/**
 * Per-run snapshot of Zotero's full-text index for the backend: which engine is
 * available, how much of each searchable library Zotero has indexed, and which
 * languages the library's items are in. Reads Zotero's database only.
 */

import type { ZoteroFulltextEngine, ZoteroFulltextLibraryState, ZoteroFulltextState } from '@beaver/agent-core/protocol/agentProtocol';
import { logger } from '@beaver/agent-core/platform/logger';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';
import { countLibraryLanguages, prominentLanguages } from './languages';
import { countLibraryCoverage, detectEngine } from './zoteroIndex';

/**
 * Coverage and languages change slowly, and reading them scans the libraries.
 * Runs reuse a recent reading of the same libraries. One older than
 * `SNAPSHOT_REFRESH_MS` is still served while a fresh one is read in the
 * background; one older than `SNAPSHOT_MAX_AGE_MS` (after a long idle) is not,
 * and the run waits for the fresh reading.
 */
const SNAPSHOT_REFRESH_MS = 10 * 60_000;
const SNAPSHOT_MAX_AGE_MS = 60 * 60_000;

interface LibrarySnapshot {
    libraries: ZoteroFulltextLibraryState[];
    languages: string[];
}

let snapshotCache: { key: string; at: number; snapshot: Promise<LibrarySnapshot> } | null = null;

async function readSnapshot(libraryIds: number[], engine: ZoteroFulltextEngine): Promise<LibrarySnapshot> {
    const languages = countLibraryLanguages(libraryIds).then(prominentLanguages).catch((): string[] => []);
    if (engine === 'none') return { libraries: [], languages: await languages };
    const coverage = await countLibraryCoverage(libraryIds, engine);
    const libraries: ZoteroFulltextLibraryState[] = [];
    for (const id of libraryIds) {
        const ref = libraryRefForLibraryID(id);
        if (ref) libraries.push({ library_ref: ref, ...(coverage.get(id) ?? { total: 0, indexed: 0, partial: 0 }) });
    }
    return { libraries, languages: await languages };
}

function librarySnapshot(libraryIds: number[], engine: ZoteroFulltextEngine): Promise<LibrarySnapshot> {
    const key = `${engine}:${libraryIds.join(',')}`;
    const cached = snapshotCache?.key === key ? snapshotCache : null;
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < SNAPSHOT_REFRESH_MS) return cached.snapshot;
    const reading = readSnapshot(libraryIds, engine);
    const entry = { key, at: Date.now(), snapshot: cached && age < SNAPSHOT_MAX_AGE_MS ? cached.snapshot : reading };
    snapshotCache = entry;
    reading.then(
        () => { if (snapshotCache === entry) snapshotCache = { ...entry, snapshot: reading }; },
        () => { if (snapshotCache === entry) snapshotCache = null; },
    );
    return entry.snapshot;
}

/** Test hook: forget the cached snapshot. */
export function resetZoteroFulltextStateCache(): void {
    snapshotCache = null;
}

/** Snapshot for the agent run request; undefined when the library scope isn't known yet. */
export async function getZoteroFulltextState(): Promise<ZoteroFulltextState | undefined> {
    try {
        const beaver = Zotero.Beaver;
        if (!beaver?.libraryScopeInitialized || !beaver.searchableLibraryIds) return undefined;
        const libraryIds = [...beaver.searchableLibraryIds].sort((a, b) => a - b);
        const engine = await detectEngine();
        const { libraries, languages } = await librarySnapshot(libraryIds, engine);
        // A library excluded while this ran must not be reported
        const current = [...(Zotero.Beaver?.searchableLibraryIds ?? [])].sort((a, b) => a - b);
        if (!Zotero.Beaver?.libraryScopeInitialized || current.join(',') !== libraryIds.join(',')) return undefined;
        return { version: 1, engine, libraries, languages };
    } catch (error) {
        logger(`Zotero full-text state unavailable: ${error}`, 2);
        return undefined;
    }
}
