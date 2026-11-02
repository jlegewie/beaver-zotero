/**
 * Clicking a table cell or row citation opens the table as it is now, at the
 * cited cell or row, and says so when the table or the cell is gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Citation } from '@beaver/agent-core/types/citations';

const { resolveItemReference, notifyReferenceUnavailable, notifyTableOpenFailed, openTable, revealSource } = vi.hoisted(() => ({
    revealSource: vi.fn(),
    resolveItemReference: vi.fn(),
    notifyReferenceUnavailable: vi.fn(),
    notifyTableOpenFailed: vi.fn(),
    openTable: vi.fn(),
}));

vi.mock('../../../react/store', () => ({ store: { get: vi.fn(() => ({})), set: vi.fn() } }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: vi.fn(() => false) }));
vi.mock('../../../react/utils/annotationUtils', () => ({
    BeaverTemporaryAnnotations: { cleanupAll: vi.fn(), addToTracking: vi.fn() },
    createBoundingBoxHighlights: vi.fn(),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveItemReference,
    libraryRefForLibraryID: vi.fn(),
}));
vi.mock('../../../react/host/zotero/sourceActions', () => ({
    launchExternalFile: vi.fn(),
    notifyReferenceUnavailable,
    notifyTableOpenFailed,
}));
vi.mock('../../../react/utils/sourceUtils', () => ({ revealSource, openSource: vi.fn() }));
vi.mock('../../../src/services/artifacts/tablesApi', () => ({ getTablesApi: () => ({ openTable }) }));

import { activateCitation } from '../../../react/host/zotero/citationActivation';

const win = {} as Window;
const ownerDocument = { defaultView: win } as unknown as Document;
const table = { kind: 'zotero' as const, library_id: 1, library_ref: 'u', zotero_key: 'TABLEKEY' };

function activate(loc: { kind: 'cell' | 'row'; value: string; raw: string }, intent: 'passage' | 'item' = 'passage') {
    const metadata: Citation = {
        citation_id: 'c',
        citation_type: 'table',
        resolved_ref: { ...table, loc },
        table: { title: 'Study designs', row_label: 'Smith et al. 2021' },
    };
    return activateCitation({
        metadata,
        intent,
        isExternal: false,
        isExternalFile: false,
        externalFileKey: null,
        hasMappedItem: false,
        effectiveLibraryID: 1,
        effectiveItemKey: 'TABLEKEY',
        effectiveLibraryRef: 'u',
        previewText: '',
        ownerDocument,
    });
}

describe('activating a table citation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveItemReference.mockResolvedValue({ status: 'found', item: { libraryID: 1, key: 'TABLEKEY' } });
        openTable.mockResolvedValue({ ok: true, tabID: 't', reused: false, focus: 'found' });
    });

    it('opens the table at the cited cell, from the window that was clicked', async () => {
        await activate({ kind: 'cell', value: 'r0a1b2c3d4/design', raw: 'cell:r0a1b2c3d4/design' });
        expect(openTable).toHaveBeenCalledWith(
            { libraryID: 1, key: 'TABLEKEY' },
            { window: win, focus: { rowId: 'r0a1b2c3d4', columnId: 'design' } },
        );
        expect(notifyReferenceUnavailable).not.toHaveBeenCalled();
    });

    it('reveals the table item instead when the alternate click asks for the work', async () => {
        const item = { libraryID: 1, key: 'TABLEKEY', parentItemID: null, loadAllData: vi.fn() };
        resolveItemReference.mockResolvedValue({ status: 'found', item });
        await activate({ kind: 'cell', value: 'r0a1b2c3d4/design', raw: 'cell:r0a1b2c3d4/design' }, 'item');
        expect(openTable).not.toHaveBeenCalled();
        expect(revealSource).toHaveBeenCalledWith(expect.objectContaining({ zotero_key: 'TABLEKEY' }));
    });

    it('opens the table at a cited row', async () => {
        await activate({ kind: 'row', value: 'r0a1b2c3d4', raw: 'row:r0a1b2c3d4' });
        expect(openTable).toHaveBeenCalledWith(expect.anything(), { window: win, focus: { rowId: 'r0a1b2c3d4' } });
    });

    it('says the cell is gone when the table no longer has its row or column', async () => {
        openTable.mockResolvedValue({ ok: true, tabID: 't', reused: false, focus: 'missing' });
        await activate({ kind: 'cell', value: 'r0a1b2c3d4/design', raw: 'cell:r0a1b2c3d4/design' });
        expect(notifyReferenceUnavailable).toHaveBeenCalledWith('table_cell');
    });

    it('says the table is gone, as for any deleted item, and opens nothing', async () => {
        resolveItemReference.mockResolvedValue({ status: 'missing' });
        await activate({ kind: 'cell', value: 'r0a1b2c3d4/design', raw: 'cell:r0a1b2c3d4/design' });
        expect(notifyReferenceUnavailable).toHaveBeenCalledWith('item', 'missing');
        expect(openTable).not.toHaveBeenCalled();
    });

    it('passes on why a table that exists could not be opened', async () => {
        openTable.mockResolvedValue({ error: 'Could not open table TABLEKEY — it has no file on disk.' });
        await activate({ kind: 'cell', value: 'r0a1b2c3d4/design', raw: 'cell:r0a1b2c3d4/design' });
        expect(notifyTableOpenFailed).toHaveBeenCalledWith('Could not open table TABLEKEY — it has no file on disk.');
    });
});
