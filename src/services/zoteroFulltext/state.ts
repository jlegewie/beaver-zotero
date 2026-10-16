/**
 * Per-run snapshot of Zotero's full-text index for the backend: which engine is
 * available, how much of each searchable library Zotero has indexed, and which
 * languages the library's items are in. Reads Zotero's database only.
 */

import type { ZoteroFulltextEngine, ZoteroFulltextLibraryState, ZoteroFulltextState } from '@beaver/agent-core/protocol/agentProtocol';
import { logger } from '@beaver/agent-core/platform/logger';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';
import { countLibraryLanguages, prominentLanguages } from './languages';
import { detectEngine, listScopeAttachments } from './zoteroIndex';

const LANGUAGE_CACHE_MS = 10 * 60_000;
let languageCache: { key: string; languages: string[]; at: number } | null = null;

async function libraryLanguages(libraryIds: number[]): Promise<string[]> {
    const key = libraryIds.join(',');
    if (languageCache && languageCache.key === key && Date.now() - languageCache.at < LANGUAGE_CACHE_MS) {
        return languageCache.languages;
    }
    const languages = prominentLanguages(await countLibraryLanguages(libraryIds));
    languageCache = { key, languages, at: Date.now() };
    return languages;
}

/** Index coverage per library, from the attachments Zotero has (and hasn't) indexed. */
export async function libraryCoverage(libraryIds: number[], engine: ZoteroFulltextEngine): Promise<ZoteroFulltextLibraryState[]> {
    const byLibrary = new Map<number, ZoteroFulltextLibraryState>();
    for (const id of libraryIds) {
        const ref = libraryRefForLibraryID(id);
        if (ref) byLibrary.set(id, { library_ref: ref, total: 0, indexed: 0, partial: 0 });
    }
    for (const attachment of await listScopeAttachments({ libraryIds: [...byLibrary.keys()] }, engine)) {
        const summary = byLibrary.get(attachment.libraryID)!;
        summary.total++;
        if (attachment.indexed) summary.indexed++;
        if (attachment.partial) summary.partial++;
    }
    return [...byLibrary.values()];
}

/** Snapshot for the agent run request; undefined when the library scope isn't known yet. */
export async function getZoteroFulltextState(): Promise<ZoteroFulltextState | undefined> {
    try {
        const beaver = Zotero.Beaver;
        if (!beaver?.libraryScopeInitialized || !beaver.searchableLibraryIds) return undefined;
        const libraryIds = [...beaver.searchableLibraryIds].sort((a, b) => a - b);
        const engine = await detectEngine();
        const [libraries, languages] = await Promise.all([
            engine === 'none' ? Promise.resolve([]) : libraryCoverage(libraryIds, engine),
            libraryLanguages(libraryIds).catch(() => []),
        ]);
        // A library excluded while this ran must not be reported
        const current = [...(Zotero.Beaver?.searchableLibraryIds ?? [])].sort((a, b) => a - b);
        if (!Zotero.Beaver?.libraryScopeInitialized || current.join(',') !== libraryIds.join(',')) return undefined;
        return { version: 1, engine, libraries, languages };
    } catch (error) {
        logger(`Zotero full-text state unavailable: ${error}`, 2);
        return undefined;
    }
}
