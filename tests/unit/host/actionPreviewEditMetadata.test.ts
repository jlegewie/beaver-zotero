// @vitest-environment jsdom

/**
 * The edit_metadata preview resolves the edited item's type without throwing
 * when the item's library has not been loaded by Zotero yet.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/host/zotero/components/EditMetadataPreview', () => ({
    EditMetadataPreview: ({ itemTypeID }: { itemTypeID?: number }) =>
        React.createElement('span', { 'data-testid': 'type' }, String(itemTypeID ?? 'none')),
}));
vi.mock('../../../react/host/zotero/components/MergeItemsPreview', () => ({ MergeItemsPreview: () => null }));
vi.mock('../../../react/host/zotero/components/CreateCollectionPreview', () => ({ CreateCollectionPreview: () => null }));
vi.mock('../../../react/host/zotero/components/OrganizeItemsPreview', () => ({ OrganizeItemsPreview: () => null }));
vi.mock('../../../react/host/zotero/components/CreateItemsPreview', () => ({ CreateItemsPreview: () => null }));
vi.mock('../../../react/host/zotero/components/ImportItemsPreview', () => ({ ImportItemsPreview: () => null }));
vi.mock('../../../react/host/zotero/components/ConfirmExtractionPreview', () => ({ ConfirmExtractionPreview: () => null }));
vi.mock('../../../react/host/zotero/components/ConfirmExternalSearchPreview', () => ({ ConfirmExternalSearchPreview: () => null }));
vi.mock('../../../react/components/agentRuns/EditNotePreview', () => ({ EditNotePreview: () => null }));
vi.mock('../../../react/host/zotero/components/CreateNotePreview', () => ({ CreateNotePreview: () => null }));
vi.mock('../../../react/host/zotero/components/ManageTagsPreview', () => ({ ManageTagsPreview: () => null }));
vi.mock('../../../react/host/zotero/components/ManageCollectionsPreview', () => ({ ManageCollectionsPreview: () => null }));
vi.mock('../../../react/host/zotero/components/CreateAnnotationsPreview', () => ({ CreateAnnotationsPreview: () => null }));
vi.mock('../../../react/host/zotero/components/EditAnnotationsPreview', () => ({ EditAnnotationsPreview: () => null }));
vi.mock('../../../react/host/zotero/components/DeleteAnnotationsPreview', () => ({ DeleteAnnotationsPreview: () => null }));
vi.mock('../../../react/host/zotero/components/editNoteBatchPreviewData', () => ({
    getBatchRewriteOldContent: vi.fn(),
    getEditNotePreviewKind: vi.fn(() => null),
}));

import { ActionPreview } from '../../../react/host/zotero/components/ActionPreview';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const previewData = {
    actionType: 'edit_metadata',
    actionData: { library_id: 5, zotero_key: 'ITEMKEY1', edits: [] },
} as any;

function element() {
    return React.createElement(ActionPreview, { toolName: 'edit_metadata', previewData, status: 'applied' });
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement('div');
    (globalThis as any).Zotero = {
        Items: {
            getByLibraryAndKey: vi.fn(() => {
                throw new Error('Item 12 not yet loaded');
            }),
            getByLibraryAndKeyAsync: vi.fn(async () => ({ itemTypeID: 22 })),
        },
    };
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
});

describe('ActionPreview edit_metadata', () => {
    it('renders without the item type while the item is not loaded', () => {
        expect(renderToStaticMarkup(element())).toContain('none');
    });

    it('loads the item asynchronously and passes its type to the preview', async () => {
        root = createRoot(container);
        await act(async () => {
            root!.render(element());
        });

        expect(Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledWith(5, 'ITEMKEY1');
        expect(container.textContent).toBe('22');
    });

    it('reads the type synchronously when the item is cached', () => {
        (Zotero as any).Items.getByLibraryAndKey = vi.fn(() => ({ itemTypeID: 7 }));

        expect(renderToStaticMarkup(element())).toContain('7');
    });
});
