import type { AttachmentProcessingStateRecord } from '../database';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';
import { observeAttachmentSource } from '../documentExtraction/sourceObservation';
import { getIndexScopeRef } from '../../utils/zoteroInstanceIdentity';
import { queryLibraryAttachmentIds } from '../documentExtraction/attachmentInventory';

export interface SearchCensusAttachment {
    libraryId: number;
    zoteroKey: string;
    contentKind: 'pdf' | 'epub' | 'snapshot';
    /** Only present when the extraction still describes the observed source. */
    identity: { docHash: string; schemaVersion: string } | null;
}

export interface SearchCensusLibrary {
    libraryId: number;
    scopeRef: string;
    attachments: SearchCensusAttachment[];
}

function currentIdentity(
    row: AttachmentProcessingStateRecord | undefined,
    kind: SearchCensusAttachment['contentKind'],
    observation: Awaited<ReturnType<typeof observeAttachmentSource>>,
): SearchCensusAttachment['identity'] {
    if (!row || row.contentKind !== kind || row.extractStatus !== 'done'
        || !row.structuredDocumentHash || !row.extractSchemaVersion || !observation) return null;
    const matches = row.extractionSource !== null
        ? observation.identity === row.extractionSource
        : observation.signature !== null && row.fileMtimeMs === observation.signature.mtime_ms
            && row.fileSizeBytes === observation.signature.size_bytes;
    return matches ? { docHash: row.structuredDocumentHash, schemaVersion: row.extractSchemaVersion } : null;
}

/** Enumerate the complete supported scope independently of preparation and its ledger. */
export async function discoverSearchCensus(
    libraryIds: number[],
    isCurrent: () => boolean,
    isScopeCurrent: () => boolean = isCurrent,
): Promise<SearchCensusLibrary[]> {
    const check = () => { if (!isCurrent()) throw new Error('Search discovery scope changed'); };
    const checkScope = () => { if (!isScopeCurrent()) throw new Error('Search discovery scope changed'); };
    const db = Zotero.Beaver?.db;
    if (!db) throw new Error('Search discovery database unavailable');
    const libraries: SearchCensusLibrary[] = [];
    for (const libraryId of [...new Set(libraryIds)].sort((a, b) => a - b)) {
        checkScope();
        const scopeRef = getIndexScopeRef(libraryId);
        if (!scopeRef) throw new Error('Search discovery library identity unavailable');
        const ids = await queryLibraryAttachmentIds(libraryId);
        checkScope();
        const ledger = new Map((await db.getAttachmentProcessingStatesByLibrary(libraryId))
            .map((row) => [row.zoteroKey, row]));
        const attachments: SearchCensusAttachment[] = [];
        for (let offset = 0; offset < ids.length; offset += 100) {
            checkScope();
            const items = await Zotero.Items.getAsync(ids.slice(offset, offset + 100));
            if (items.length !== Math.min(100, ids.length - offset) || items.some((item) => !item)) {
                throw new Error('Search discovery changed during enumeration');
            }
            for (const item of items) {
                check();
                if (item.libraryID !== libraryId) throw new Error('Search discovery library changed');
                const kind = getReadableContentKind(item);
                if (kind !== 'pdf' && kind !== 'epub' && kind !== 'snapshot') continue;
                const row = ledger.get(item.key);
                const observation = row?.structuredDocumentHash
                    ? await observeAttachmentSource(item, kind) : null;
                check();
                attachments.push({ libraryId, zoteroKey: item.key, contentKind: kind,
                    identity: currentIdentity(row, kind, observation) });
            }
        }
        libraries.push({ libraryId, scopeRef, attachments });
    }
    checkScope();
    return libraries;
}
