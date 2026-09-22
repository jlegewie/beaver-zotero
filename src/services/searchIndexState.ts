import type { SearchIndexState, SearchIndexLibraryState } from '@beaver/agent-core/protocol/agentProtocol';
import { logger } from '@beaver/agent-core/platform/logger';
import { libraryRefForLibraryID } from '../utils/libraryIdentity';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../utils/zoteroInstanceIdentity';
import { expectedExtractionSchemaVersion } from './documentExtraction/shared/extractionSchemaVersions';
import { EXPECTED_SEARCH_INDEX_VERSION } from './backgroundProcessing/constants';

export interface SearchPreparationRow {
    libraryId: number;
    key: string;
    contentKind: 'pdf' | 'epub' | 'snapshot';
    extractStatus: string | null;
    extractSchemaVersion: string | null;
    ocrStatus: string | null;
    upsertStatus: string | null;
    upsertIndexVersion: string | null;
    remoteIdentity: string | null;
    error: string | null;
    readingSucceeded: boolean;
}

// Unknown and service failures remain pending, even after retry exhaustion.
const UNAVAILABLE_CODES = new Set([
    'file_missing', 'encrypted', 'invalid_pdf', 'file_too_large', 'too_many_pages',
    'pdf_too_complex', 'empty_document', 'insufficient_text', 'ocr_page_cap', 'ocr_no_text',
]);

export function classifySearchPreparation(
    row: SearchPreparationRow,
    identity: { accountId: string; localId: string; scopeRef: string },
): 'indexed' | 'unavailable' | 'pending' {
    let remote: { index_account_id?: string; index_scope_ref?: string; index_local_id?: string } | null = null;
    try { remote = row.remoteIdentity ? JSON.parse(row.remoteIdentity) : null; } catch { /* Unknown ownership is pending. */ }
    if (row.upsertStatus === 'done' && row.extractStatus === 'done'
        && row.extractSchemaVersion === expectedExtractionSchemaVersion(row.contentKind)
        && Number(row.upsertIndexVersion) >= EXPECTED_SEARCH_INDEX_VERSION
        && remote?.index_account_id === identity.accountId
        && remote?.index_scope_ref === identity.scopeRef
        && remote?.index_local_id === identity.localId) return 'indexed';

    // Reading outcomes intentionally survive retries. Only settled processing
    // outcomes can remove an attachment from the denominator.
    const settled = row.extractStatus === 'failed' || row.extractStatus === 'skipped'
        || (row.extractStatus === 'done' && row.ocrStatus === 'failed');
    const codes = row.error?.split(':').map(part => part.trim()) ?? [];
    // Exact legacy terminal text is retained for already-persisted outcomes.
    const unavailable = codes.some(code => UNAVAILABLE_CODES.has(code))
        || row.error === 'OCR produced no usable text layer';
    if (settled && !row.readingSucceeded && unavailable) return 'unavailable';
    return 'pending';
}

/** Two local reads per dispatch; no file I/O, item loading, cache or remote requests. */
export async function getSearchIndexState(): Promise<SearchIndexState | undefined> {
    try {
        const beaver = Zotero.Beaver;
        if (!beaver?.hasSearchIndexAccess || !beaver.libraryScopeInitialized || !beaver.db) return undefined;
        const account = beaver.account;
        if (!account || !beaver.searchableLibraryIds) return undefined;
        const generation = account.getGeneration();
        const accountId = account.getSnapshot().session?.user.id;
        if (!accountId) return undefined;
        const libraryIds = [...beaver.searchableLibraryIds].sort((a, b) => a - b);
        const localId = getZoteroUserIdentifier().localUserKey;
        const libraries = new Map<number, SearchIndexLibraryState>();
        const scopes = new Map<number, string>();
        for (const id of libraryIds) {
            const ref = libraryRefForLibraryID(id);
            const scope = getIndexScopeRef(id);
            if (!ref || !scope) return undefined;
            libraries.set(id, { library_ref: ref, total: 0, indexed: 0, unavailable: 0 });
            scopes.set(id, scope);
        }
        const rows = await beaver.db.getSearchPreparationRows(libraryIds);
        const states = new Map(rows.map(row => [`${row.libraryId}:${row.key}`, row]));
        if (libraryIds.length) await Zotero.DB.queryAsync(
            `SELECT i.libraryID, i.key, LOWER(a.contentType)
             FROM items i JOIN itemAttachments a USING (itemID)
             WHERE i.libraryID IN (${libraryIds.map(() => '?').join(',')})
               AND a.linkMode != ?
               AND LOWER(a.contentType) IN ('application/pdf', 'application/epub+zip', 'text/html', 'application/xhtml+xml')
               AND NOT EXISTS (SELECT 1 FROM deletedItems d WHERE d.itemID = i.itemID)
               AND NOT EXISTS (SELECT 1 FROM deletedItems d WHERE d.itemID = a.parentItemID)`,
            [...libraryIds, Zotero.Attachments.LINK_MODE_LINKED_URL],
            { onRow: (result: any) => {
                const id = Number(result.getResultByIndex(0));
                const summary = libraries.get(id)!;
                summary.total++;
                const row = states.get(`${id}:${result.getResultByIndex(1)}`);
                const mime = result.getResultByIndex(2);
                const kind = mime === 'application/pdf' ? 'pdf' : mime === 'application/epub+zip' ? 'epub' : 'snapshot';
                if (!row || row.contentKind !== kind) return;
                const state = classifySearchPreparation(row, { accountId, localId, scopeRef: scopes.get(id)! });
                if (state !== 'pending') summary[state]++;
            } },
        );
        if (account.getGeneration() !== generation || !beaver.hasSearchIndexAccess
            || !beaver.libraryScopeInitialized
            || JSON.stringify([...beaver.searchableLibraryIds].sort((a, b) => a - b)) !== JSON.stringify(libraryIds)) return undefined;
        return { version: 1, libraries: [...libraries.values()] };
    } catch (error) {
        logger(`Search preparation snapshot unavailable: ${error}`, 2);
        return undefined;
    }
}
