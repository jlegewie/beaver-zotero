/**
 * `addon.tableFills`: the fill service wired to Zotero, the table store, the
 * account and the backend. Plugin realm only; renderers reach it through
 * `Zotero.Beaver.tableFills` and its runtime notifications.
 */

import type { WSZoteroDocumentRequest } from '@beaver/agent-core/protocol/agentProtocol';
import { TABLE_FILL_CHANGED_EVENT } from '@beaver/agent-core/protocol/tableFillProtocol';
import { readTable } from '../artifacts/tableItemIdentity';
import { tableFilesEditable } from '../artifacts/tableItemIdentity';
import { readBackendDocument } from '../agentDataProvider/handleZoteroDocumentRequest';
import { checkLibraryExcluded, isLibrarySearchable } from '../agentDataProvider/utils';
import { visitLibraryReferences } from '../artifacts/artifactProvider';
import { MAX_PDF_TIMEOUT_SECONDS } from '../agentDataProvider/timeout';
import { parseItemReference, resolveLibraryRef } from '../../utils/libraryIdentity';
import { documentSendable, lookupRowDocuments, rowSendable } from './documentLookup';
import { InstanceTableFills, type TableFillDeps } from './service';
import { DEFAULT_FILL_WAIT_MS } from './agentFill';
import { getPref } from '../../utils/prefs';
import { tableFillApiClient } from './tableFillApi';

/** The page cap of a document a fill reads, as the backend's own. */
const FILL_MAX_PAGES = 1500;
/** The largest serialized document a fill sends, under the endpoint's body bound. */
const FILL_MAX_PAYLOAD_BYTES = 60 * 1024 * 1024;

/** The document request a fill extracts a row's document with. */
export function fillDocumentRequest(documentId: string): WSZoteroDocumentRequest | null {
    const base = {
        event: 'zotero_document_request' as const,
        request_id: `table-fill-${crypto.randomUUID()}`,
        mode: 'structured' as const,
        max_pages: FILL_MAX_PAGES,
        max_payload_bytes: FILL_MAX_PAYLOAD_BYTES,
        timeout_seconds: MAX_PDF_TIMEOUT_SECONDS,
    };
    if (documentId.startsWith('ext-')) return { ...base, external_file_key: documentId.slice(4) };
    const parsed = parseItemReference(documentId);
    if (!parsed) return null;
    const libraryID = resolveLibraryRef(parsed);
    if (libraryID == null) return null;
    return {
        ...base,
        attachment: {
            library_id: libraryID,
            zotero_key: parsed.zotero_key,
            ...(parsed.library_ref ? { library_ref: parsed.library_ref } : {}),
        },
    };
}

function balanceOf(): number | null {
    const profile = Zotero.Beaver.account?.getSnapshot().data?.profile;
    if (!profile) return null;
    return (profile.available_subscription_credits ?? 0) + (profile.available_purchased_credits ?? 0);
}

const deps: TableFillDeps = {
    readTable: (target) => readTable(target),
    writeRefusal: (target) => {
        if (checkLibraryExcluded(target.libraryID)) return 'table_unavailable';
        const library = Zotero.Libraries.get(target.libraryID);
        if (!library) return 'table_unavailable';
        // A table moved to the trash or deleted mid-fill cannot take answers.
        // An item not loaded yet (a library not opened this session) is
        // checked once reading the table has loaded it.
        let item: Zotero.Item | false;
        try {
            item = Zotero.Items.getByLibraryAndKey(target.libraryID, target.key) as Zotero.Item | false;
        } catch {
            return null;
        }
        if (!item || item.deleted) return 'table_unavailable';
        return tableFilesEditable(library) ? null : 'read_only';
    },
    lookupRows: (rows) => lookupRowDocuments(rows),
    rowSendable: (row) => rowSendable(row),
    documentSendable: (documentId) => documentSendable(documentId),
    contextSendable: (value) => {
        // A reference to a library this device does not have names nothing
        // excluded here; one Beaver may not read must not leave the device.
        let sendable = true;
        visitLibraryReferences(value, (libraryID) => {
            if (libraryID != null && !isLibrarySearchable(libraryID)) sendable = false;
        });
        return sendable;
    },
    readDocument: async (documentId) => {
        const request = fillDocumentRequest(documentId);
        if (!request) return { ok: false, code: 'library_unavailable' };
        const read = await readBackendDocument(request);
        return read.ok
            ? { ok: true, json: read.json, contentKind: read.contentKind }
            : { ok: false, code: read.code, ...(read.contentKind ? { contentKind: read.contentKind } : {}) };
    },
    pricing: () => tableFillApiClient.pricing(),
    fill: (body, assertDispatch) => tableFillApiClient.fill(body, assertDispatch),
    commit: async (target, commit, meta, mayCommit) => {
        // Checked at admission by the queue, and again by the store just
        // before the commit lands, after its own asynchronous preparation.
        const result = await Zotero.Beaver.libraryOperations.run(
            'table_editTableSession',
            [target, commit, meta, () => mayCommit()],
            { assertCurrent: mayCommit },
        );
        return result.ok ? { ok: true, skipped: result.skipped } : { ok: false, error: result.error };
    },
    account: {
        generation: () => Zotero.Beaver.account?.getGeneration() ?? -1,
        signedIn: () => !!Zotero.Beaver.account?.getSnapshot().session,
        balance: balanceOf,
        subscribe: (listener) => Zotero.Beaver.account?.subscribe(() => listener()) ?? (() => {}),
        refreshProfile: () => void Zotero.Beaver.account?.refresh(true).catch(() => {}),
    },
    publish: (snapshot) => Zotero.Beaver.runtime.publish(TABLE_FILL_CHANGED_EVENT, snapshot),
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
};

/** The safety deadline of a waiting `fill`, from the `tables.fillWaitSeconds` pref. */
function fillWaitMs(): number {
    const seconds = Number(getPref('tables.fillWaitSeconds'));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_FILL_WAIT_MS;
}

export function createInstanceTableFills(): InstanceTableFills {
    return new InstanceTableFills(deps, undefined, fillWaitMs);
}

export type { InstanceTableFills } from './service';
