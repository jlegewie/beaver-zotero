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
    citationMapAtom: Symbol('citationMapAtom'),
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
    preloadPageLabelsForContent: vi.fn().mockResolvedValue({}),
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

// Mocked to keep the real module (which pulls in supabaseClient via sync/webAPI)
// out of this suite's import graph.
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getCollectionByIdOrName: vi.fn(),
}));

import { executeCreateNoteAction } from '../../../react/utils/createNoteActions';
import { resolveCreateNoteParent } from '../../../src/services/agentDataProvider/actions/resolveCreateNoteParent';
import { getCollectionByIdOrName } from '../../../src/services/agentDataProvider/utils';

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
            addTag = vi.fn();
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

        // Resolves known collection names to keys; treats anything else as a
        // literal key. "NOSUCH" models a collection that doesn't exist.
        vi.mocked(getCollectionByIdOrName).mockImplementation((idOrName: any, libraryId?: number) => {
            if (idOrName == null || idOrName === 'NOSUCH') return null;
            const byName: Record<string, string> = {
                'Reading List': 'RLKEY',
                'Inbox': 'INBOXKEY',
            };
            const key = byName[String(idOrName)] ?? String(idOrName);
            return { collection: { key } as any, libraryID: libraryId ?? 1 };
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

        expect(vi.mocked(resolveCreateNoteParent)).toHaveBeenCalledWith('1-RELKEY', undefined);
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

    it('passes library_ref through parent resolution and targets the resolved group library', async () => {
        (globalThis as any).Zotero.Groups = {
            getLibraryIDFromGroupID: vi.fn(() => 7),
            getGroupIDFromLibraryID: vi.fn(() => 42),
        };
        vi.mocked(resolveCreateNoteParent).mockResolvedValueOnce({
            ok: true,
            parentKey: 'PARENTKEY',
            resolvedLibraryId: 7,
            relatedItemKey: null,
            warning: null,
        });

        const result = await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                parent_item_id: '99-PARENTKEY',
                library_id: 99,
                library_ref: 'g42',
            },
        } as any, 'run-1');

        expect(vi.mocked(resolveCreateNoteParent)).toHaveBeenCalledWith('99-PARENTKEY', 'g42');
        expect(noteInstances).toHaveLength(1);
        expect(noteInstances[0].libraryID).toBe(7);
        expect(noteInstances[0].parentKey).toBe('PARENTKEY');
        expect(result).toMatchObject({
            library_id: 7,
            library_ref: 'g42',
            parent_key: 'PARENTKEY',
        });
    });

    it('applies pre-resolved collection_keys and tags to a standalone note', async () => {
        const result = await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                collection_keys: ['RLKEY', 'INBOXKEY'],
                tags: ['alpha', 'beta'],
            },
        } as any, 'run-1');

        const note = noteInstances[0];
        expect(note.addToCollection).toHaveBeenCalledTimes(2);
        expect(note.addToCollection).toHaveBeenCalledWith('RLKEY');
        expect(note.addToCollection).toHaveBeenCalledWith('INBOXKEY');
        expect(note.addTag).toHaveBeenCalledWith('alpha');
        expect(note.addTag).toHaveBeenCalledWith('beta');

        expect(result).toMatchObject({
            collection_key: 'RLKEY',
            collection_keys: ['RLKEY', 'INBOXKEY'],
            tags: ['alpha', 'beta'],
        });
    });

    it('resolves raw collection names, dedupes them, and skips ones that do not exist', async () => {
        const result = await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                // "Reading List" and RLKEY resolve to the same key -> deduped.
                collections: ['Reading List', 'RLKEY', 'NOSUCH', 'Inbox'],
            },
        } as any, 'run-1');

        const note = noteInstances[0];
        expect(note.addToCollection).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            collection_keys: ['RLKEY', 'INBOXKEY'],
        });
    });

    it('falls back to the legacy singular collection_key when no plural keys are present', async () => {
        const result = await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                collection_key: 'LEGACYKEY',
            },
        } as any, 'run-1');

        expect(noteInstances[0].addToCollection).toHaveBeenCalledExactlyOnceWith('LEGACYKEY');
        expect(result).toMatchObject({
            collection_key: 'LEGACYKEY',
            collection_keys: ['LEGACYKEY'],
        });
    });

    it('does not put a child note in collections but still applies its tags', async () => {
        vi.mocked(resolveCreateNoteParent).mockResolvedValueOnce({
            ok: true,
            parentKey: 'PARENTKEY',
            resolvedLibraryId: 1,
            relatedItemKey: null,
            warning: null,
        });

        const result = await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                parent_item_id: '1-PARENTKEY',
                collection_keys: ['RLKEY'],
                tags: ['alpha'],
            },
        } as any, 'run-1');

        // Zotero's fki_collectionItems_itemID_parentItemID trigger aborts saveTx
        // if a child item is put in a collection.
        const note = noteInstances[0];
        expect(note.addToCollection).not.toHaveBeenCalled();
        expect(note.addTag).toHaveBeenCalledExactlyOnceWith('alpha');

        expect(result).not.toHaveProperty('collection_key');
        expect(result).not.toHaveProperty('collection_keys');
        expect(result).toMatchObject({ parent_key: 'PARENTKEY', tags: ['alpha'] });
    });

    it('stages each tag once and ignores blank tags', async () => {
        const result = await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                tags: ['alpha', ' alpha ', '', '   ', 'beta'],
            },
        } as any, 'run-1');

        const note = noteInstances[0];
        expect(note.addTag).toHaveBeenCalledTimes(2);
        expect(note.addTag).toHaveBeenCalledWith('alpha');
        expect(note.addTag).toHaveBeenCalledWith('beta');
        expect(result).toMatchObject({ tags: ['alpha', 'beta'] });
    });
});
