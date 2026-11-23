/**
 * A registry record saved as an HTML snapshot.
 *
 * Most trial registrations have no protocol or analysis-plan PDF, so every
 * imported trial also gets its registry record: the backend renders it as a
 * self-contained HTML page (`GET /api/v1/external-references/{id}/record`),
 * which is stored as a `text/html` child attachment the same way generated
 * reports are (`Zotero.Attachments.importFromSnapshotContent`). Zotero treats
 * it as a snapshot: it opens in the reader and is full-text indexed.
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

import { ApiService } from '@beaver/agent-core/transport/apiService';
import { coordinateLibraryMutation } from '../libraryMutations';

const RECORD_PATH = '/api/v1/external-references';
/** The backend fetches the live registry record; give it room, but never wait forever. */
const RECORD_TIMEOUT_MS = 45_000;

/** The backend's rendering of one registry record. */
export interface RecordSnapshotResponse {
    external_id: string;
    title?: string | null;
    /** The record's canonical URL. */
    url?: string | null;
    html: string;
    data_as_of?: string | null;
}

class RecordSnapshotApi extends ApiService {
    fetchRecord(externalId: string): Promise<RecordSnapshotResponse> {
        return this.get<RecordSnapshotResponse>(
            `${RECORD_PATH}/${encodeURIComponent(externalId)}/record`,
            { timeoutMs: RECORD_TIMEOUT_MS },
        );
    }
}

let api: RecordSnapshotApi | null = null;

function client(): RecordSnapshotApi {
    api ??= new RecordSnapshotApi();
    return api;
}

/**
 * The rendered record for `externalId`. Throws when the backend fails (404
 * unknown record, 503 registry unavailable, 400 no record document) or
 * answers without HTML.
 */
export async function fetchRecordSnapshot(externalId: string): Promise<RecordSnapshotResponse> {
    const record = await client().fetchRecord(externalId);
    if (!record || typeof record.html !== 'string' || !record.html.trim()) {
        throw new Error(`The record of ${externalId} came back empty`);
    }
    return record;
}

export interface SaveRecordSnapshotOptions {
    /** Attachment title. */
    title: string;
    /** The snapshot's URL (the record's canonical URL). */
    url: string;
    signal: AbortSignal;
    /** Throws when the save must not happen (cancelled, library excluded or read-only). */
    assertCurrent: () => void;
}

/** Save `html` as a stored `text/html` snapshot child of `parent`. */
export function saveRecordSnapshot(
    parent: Zotero.Item,
    html: string,
    options: SaveRecordSnapshotOptions,
): Promise<Zotero.Item> {
    return coordinateLibraryMutation(async () => {
        options.assertCurrent();
        const current = await Zotero.Items.getByLibraryAndKeyAsync(parent.libraryID, parent.key);
        if (!current || current.deleted) throw new Error('Attachment parent item is unavailable');
        return Zotero.Attachments.importFromSnapshotContent({
            url: options.url,
            title: options.title,
            snapshotContent: html,
            parentItemID: current.id,
        });
    }, { signal: options.signal, assertCurrent: options.assertCurrent });
}
