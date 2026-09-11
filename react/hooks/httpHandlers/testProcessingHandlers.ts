/**
 * Dev-only HTTP handlers for the whole-library background processing pipeline
 * (`ReconcilerService` producer + `attachment_processing_state` ledger).
 *
 * The `/beaver/test/background-*` handlers cover the queue and the dispatcher;
 * these cover the layer above it, so a live test can drive a full
 * reset -> reconcile -> drain -> assert cycle over HTTP.
 */

import { store } from '../../store';
import { hasOcrAccessAtom, hasSearchIndexAccessAtom } from '../../atoms/profile';
import { resetLocalProcessingState } from '../../../src/services/backgroundProcessing/resetLocalState';
import { collectProcessingStatus } from '../../../src/services/backgroundProcessing/statusSnapshot';
import type { AttachmentProcessingStateRecord } from '../../../src/services/database';
import { getPref } from '../../../src/utils/prefs';

/**
 * Force a full reconcile pass and wait for it to finish (the same entry point
 * as the prefs "Start now" button). Returns the elapsed time so a live test
 * or a manual backlog measurement can record it.
 */
export async function handleTestProcessingReconcileNowHttpRequest(_request: unknown) {
    const reconciler = Zotero.Beaver?.processingReconciler;
    if (!reconciler) return { ok: false, error: 'processingReconciler not available' };
    if (getPref('backgroundProcessingEnabled') !== true) {
        // `run()` returns immediately when the pref is off, so a caller that
        // forgot to enable it would otherwise see a successful no-op.
        return { ok: false, error: 'backgroundProcessingEnabled is false' };
    }
    const startedAt = Date.now();
    await reconciler.reconcileNow();
    return { ok: true, duration_ms: Date.now() - startedAt };
}

/**
 * The payload `useBackgroundProcessingStatus` builds, plus the gate state that
 * decides whether anything runs at all — entitlements (both the store atoms and
 * the `Zotero.Beaver` mirrors the producers actually read), the prefs, and the
 * searchable-library scope.
 */
export async function handleTestProcessingStatusHttpRequest(
    request: { libraryId?: number; includeCoverage?: boolean; includeFailures?: boolean } = {},
) {
    const hasOcrAccess = store.get(hasOcrAccessAtom);
    const hasSearchIndexAccess = store.get(hasSearchIndexAccessAtom);
    try {
        const status = await collectProcessingStatus(
            { hasOcrAccess, hasSearchIndexAccess },
            {
                libraryId: typeof request?.libraryId === 'number' ? request.libraryId : undefined,
                includeCoverage: request?.includeCoverage !== false,
                includeFailures: request?.includeFailures !== false,
            },
        );
        return {
            ok: true,
            ...status,
            entitlements: {
                hasOcrAccess,
                hasSearchIndexAccess,
                // The producers gate on these mirrors, not on the atoms; a
                // divergence means `useOcrLane` has not published yet.
                mirrored_ocr: Zotero.Beaver?.hasOcrAccess ?? null,
                mirrored_search_index: Zotero.Beaver?.hasSearchIndexAccess ?? null,
            },
            prefs: {
                backgroundProcessingEnabled: getPref('backgroundProcessingEnabled') === true,
                backgroundExtractorEnabled: getPref('backgroundExtractorEnabled') === true,
                // Changes what the producer does with a file-less attachment:
                // remote-capable ones become a download rather than a skip.
                accessRemoteFiles: getPref('accessRemoteFiles') === true,
            },
            library_scope: {
                initialized: Zotero.Beaver?.libraryScopeInitialized ?? null,
                searchable_library_ids: Zotero.Beaver?.searchableLibraryIds ?? null,
            },
        };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Raw ledger rows plus the per-library scan cursor. `zoteroKey` narrows to a
 * single attachment; `libraryId` alone returns that library's rows.
 */
export async function handleTestProcessingLedgerHttpRequest(
    request: { libraryId?: number; zoteroKey?: string; limit?: number } = {},
) {
    const db = Zotero.Beaver?.db;
    if (!db) return { ok: false, error: 'db not available' };
    const { libraryId, zoteroKey } = request ?? {};

    if (zoteroKey) {
        if (typeof libraryId !== 'number') {
            return { ok: false, error: 'zoteroKey requires libraryId' };
        }
        const row = await db.getAttachmentProcessingState(libraryId, zoteroKey);
        return {
            ok: true,
            rows: row ? [row] : [],
            cursor: await db.getProcessingIndexState(libraryId),
        };
    }

    const libraryIds = typeof libraryId === 'number'
        ? [libraryId]
        : Zotero.Libraries.getAll()
            .filter((library) => library.libraryType === 'user' || library.libraryType === 'group')
            .map((library) => library.libraryID);
    const rows: AttachmentProcessingStateRecord[] = [];
    const cursors: Record<number, unknown> = {};
    for (const id of libraryIds) {
        rows.push(...await db.getAttachmentProcessingStatesByLibrary(id));
        cursors[id] = await db.getProcessingIndexState(id);
    }
    const limit = typeof request?.limit === 'number' ? request.limit : rows.length;
    return { ok: true, total: rows.length, rows: rows.slice(0, limit), cursors };
}

/**
 * Test isolation: drop the ledger and the scan cursor so the next reconcile
 * rebuilds from scratch. Queued jobs go too — leaving them would let the
 * previous run's work land on a ledger that no longer expects it. Omit
 * `libraryId` to reset every local library.
 *
 * Deliberately does not touch the document cache: a reset followed by a
 * reconcile is the cheap way to exercise the producer, and re-extracting a
 * whole library on every test would make the suite unusable.
 */
export async function handleTestProcessingResetHttpRequest(
    request: { libraryId?: number } = {},
) {
    try {
        const { libraryIds } = await resetLocalProcessingState(
            typeof request?.libraryId === 'number' ? request.libraryId : undefined,
            { discardRemoteState: true },
        );
        return { ok: true, library_ids: libraryIds, libraries_reset: libraryIds.length };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
