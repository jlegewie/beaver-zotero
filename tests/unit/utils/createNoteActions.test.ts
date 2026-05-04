import { beforeEach, describe, expect, it, vi } from 'vitest';

const { currentThreadIdAtom } = vi.hoisted(() => ({
    currentThreadIdAtom: Symbol('currentThreadIdAtom'),
}));

vi.mock('../../../react/store', () => ({
    store: {
        get: vi.fn((atom: unknown) => atom === currentThreadIdAtom ? 'thread-1' : new Map()),
    },
}));

vi.mock('../../../react/atoms/citations', () => ({
    citationDataMapAtom: Symbol('citationDataMapAtom'),
}));

vi.mock('../../../react/atoms/externalReferences', () => ({
    externalReferenceItemMappingAtom: Symbol('externalReferenceItemMappingAtom'),
    externalReferenceMappingAtom: Symbol('externalReferenceMappingAtom'),
}));

vi.mock('../../../react/atoms/threads', () => ({
    currentThreadIdAtom,
}));

vi.mock('../../../react/utils/citationRenderers', () => ({
    renderToHTML: vi.fn((content: string) => `<p>${content}</p>`),
}));

vi.mock('../../../react/utils/pageLabels', () => ({
    preloadPageLabelsForContent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../react/utils/noteActions', () => ({
    wrapWithSchemaVersion: vi.fn((html: string) => html),
    getBeaverNoteFooterHTML: vi.fn(() => '<footer/>'),
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider/actions/resolveCreateNoteParent', () => ({
    resolveCreateNoteParent: vi.fn(),
}));

import { executeCreateNoteAction } from '../../../react/utils/createNoteActions';
import { resolveCreateNoteParent } from '../../../src/services/agentDataProvider/actions/resolveCreateNoteParent';

describe('executeCreateNoteAction', () => {
    let collectionsLoaded = false;
    let relatedItem: any;
    let noteInstances: any[];

    beforeEach(() => {
        vi.clearAllMocks();
        collectionsLoaded = false;
        noteInstances = [];

        relatedItem = {
            key: 'RELKEY',
            addRelatedItem: vi.fn(),
            saveTx: vi.fn().mockResolvedValue(undefined),
            getCollections: vi.fn(() => {
                if (!collectionsLoaded) {
                    throw new Error('Item data not loaded');
                }
                return [99];
            }),
        };

        class MockNote {
            libraryID = 0;
            parentKey?: string;
            key = 'NOTEKEY';
            addRelatedItem = vi.fn();
            addToCollection = vi.fn();
            setNote = vi.fn();
            saveTx = vi.fn().mockResolvedValue(undefined);

            constructor(public itemType: string) {
                noteInstances.push(this);
            }
        }

        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            Libraries: {
                userLibraryID: 1,
            },
            Items: {
                getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(relatedItem),
                loadDataTypes: vi.fn(async (items: any[], dataTypes: string[]) => {
                    if (items[0] === relatedItem && dataTypes.includes('collections')) {
                        collectionsLoaded = true;
                    }
                }),
            },
            Collections: {
                get: vi.fn((id: number) => id === 99 ? { key: 'COLLKEY' } : null),
            },
            Item: MockNote,
        };

        vi.mocked(resolveCreateNoteParent).mockResolvedValue({
            ok: true,
            parentKey: null,
            resolvedLibraryId: 1,
            relatedItemKey: 'RELKEY',
            warning: 'fallback warning',
        });
    });

    it('loads collections before inheriting a standalone parent collection', async () => {
        const result = await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                parent_item_id: '1-RELKEY',
            },
        } as any, 'run-1');

        expect(vi.mocked(resolveCreateNoteParent)).toHaveBeenCalledWith('1-RELKEY');
        expect((globalThis as any).Zotero.Items.loadDataTypes).toHaveBeenCalledWith([relatedItem], ['collections']);
        expect(relatedItem.getCollections).toHaveBeenCalled();
        expect(noteInstances).toHaveLength(1);
        expect(noteInstances[0].addToCollection).toHaveBeenCalledWith('COLLKEY');
        expect(result).toMatchObject({
            library_id: 1,
            zotero_key: 'NOTEKEY',
            collection_key: 'COLLKEY',
            related_item_key: 'RELKEY',
            warning: 'fallback warning',
        });
    });

    it('stages relation pre-save and mirrors it with skipDateModifiedUpdate', async () => {
        relatedItem.addRelatedItem = vi.fn().mockReturnValue(true);

        await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                parent_item_id: '1-RELKEY',
            },
        } as any, 'run-1');

        expect(noteInstances).toHaveLength(1);
        const note = noteInstances[0];

        // Forward relation is staged on the unsaved note (called before saveTx).
        expect(note.addRelatedItem).toHaveBeenCalledWith(relatedItem);
        expect(note.addRelatedItem.mock.invocationCallOrder[0])
            .toBeLessThan(note.saveTx.mock.invocationCallOrder[0]);

        // Exactly one save on the note — no triple-saveTx.
        expect(note.saveTx).toHaveBeenCalledTimes(1);

        // Mirror runs post-save and passes skipDateModifiedUpdate.
        expect(relatedItem.addRelatedItem).toHaveBeenCalledWith(note);
        expect(relatedItem.saveTx).toHaveBeenCalledTimes(1);
        expect(relatedItem.saveTx).toHaveBeenCalledWith({ skipDateModifiedUpdate: true });
    });

    it('skips mirror saveTx when addRelatedItem returns false', async () => {
        relatedItem.addRelatedItem = vi.fn().mockReturnValue(false);

        await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                parent_item_id: '1-RELKEY',
            },
        } as any, 'run-1');

        expect(relatedItem.addRelatedItem).toHaveBeenCalledTimes(1);
        expect(relatedItem.saveTx).not.toHaveBeenCalled();
    });

    it('fetches the standalone parent only once', async () => {
        await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                parent_item_id: '1-RELKEY',
            },
        } as any, 'run-1');

        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledTimes(1);
    });
});
