import { beforeEach, describe, expect, it, vi } from 'vitest';

const { currentThreadIdAtom, harness } = vi.hoisted(() => ({
    currentThreadIdAtom: Symbol('currentThreadIdAtom'),
    // Fixture state the faked collection resolver reads.
    harness: {
        collections: [] as any[],
        libraryRefs: { 1: 'u', 7: 'g42' } as Record<number, string>,
        libraryNames: { 1: 'My Library', 7: 'Group' } as Record<number, string>,
        searchableLibraryIds: [1, 7] as number[],
    },
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

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider/actions/resolveCreateNoteParent', () => ({
    resolveCreateNoteParent: vi.fn(),
}));

// Mocked to keep the real module (which pulls in supabaseClient via sync/webAPI)
// out of this suite's import graph; the fake mirrors the real resolution rules.
vi.mock('../../../src/services/agentDataProvider/utils', async () => {
    const { createCollectionResolverFake } = await import('../../helpers/collectionResolverFake');
    const fake = createCollectionResolverFake(harness);
    return {
        resolveSingleCollection: vi.fn(fake.resolveSingleCollection),
    };
});

import { executeCreateNoteAction } from '../../../react/utils/createNoteActions';
import { resolveCreateNoteParent } from '../../../src/services/agentDataProvider/actions/resolveCreateNoteParent';
import { resolveSingleCollection } from '../../../src/services/agentDataProvider/utils';

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
                // Mirrors Zotero: false when the key is not in that library. The
                // note staging path looks the row id up rather than handing the
                // key to addToCollection, which misreads an all-digit key as an id.
                getIDFromLibraryAndKey: vi.fn((libraryID: number, key: string) =>
                    harness.collections.find((c: any) => c.libraryID === libraryID && c.key === key)?.id ?? false),
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

        // "NOSUCH" models a collection that doesn't exist.
        harness.collections = [
            { id: 1, key: 'RLKEY234', libraryID: 1, name: 'Reading List' },
            { id: 2, key: 'INBXKEY2', libraryID: 1, name: 'Inbox' },
            { id: 3, key: 'LGCYKEY2', libraryID: 1, name: 'Legacy' },
            { id: 99, key: 'COLLKEY', libraryID: 1, name: 'Inherited' },
        ];
        harness.searchableLibraryIds = [1, 7];
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
        expect(noteInstances[0].addToCollection).toHaveBeenCalledWith(99);
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
                collection_keys: ['RLKEY234', 'INBXKEY2'],
                tags: ['alpha', 'beta'],
            },
        } as any, 'run-1');

        const note = noteInstances[0];
        expect(note.addToCollection).toHaveBeenCalledTimes(2);
        expect(note.addToCollection).toHaveBeenCalledWith(1);
        expect(note.addToCollection).toHaveBeenCalledWith(2);
        expect(note.addTag).toHaveBeenCalledWith('alpha');
        expect(note.addTag).toHaveBeenCalledWith('beta');

        expect(result).toMatchObject({
            collection_key: 'RLKEY234',
            collection_keys: ['RLKEY234', 'INBXKEY2'],
            tags: ['alpha', 'beta'],
        });
    });

    it('resolves raw collection names and dedupes them', async () => {
        const result = await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                // "Reading List" and RLKEY234 resolve to the same key -> deduped.
                collections: ['Reading List', 'RLKEY234', 'Inbox'],
            },
        } as any, 'run-1');

        const note = noteInstances[0];
        expect(note.addToCollection).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            collection_keys: ['RLKEY234', 'INBXKEY2'],
        });
    });

    it('still creates the note when one requested collection does not resolve', async () => {
        // Validation rejects an unresolvable collection up front, so a miss here
        // means it went away after the action was proposed. The note is still
        // created and filed where it can be, matching the agent execute path.
        const result = await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                collections: ['Reading List', 'NOSUCH'],
            },
        } as any, 'run-1');

        expect(noteInstances).toHaveLength(1);
        expect(result).toMatchObject({ collection_keys: ['RLKEY234'] });
    });

    it('uses the keys validation resolved without re-resolving them', async () => {
        await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                collection_keys: ['RLKEY234'],
                // Raw names are only a fallback for actions stored before
                // validation normalized them.
                collections: ['Inbox'],
            },
        } as any, 'run-1');

        expect(noteInstances[0].addToCollection).toHaveBeenCalledExactlyOnceWith(1);
        expect(vi.mocked(resolveSingleCollection)).not.toHaveBeenCalled();
    });

    it('falls back to the legacy singular collection_key when no plural keys are present', async () => {
        const result = await executeCreateNoteAction({
            proposed_data: {
                title: 'Title',
                content: 'Body',
                collection_key: 'LGCYKEY2',
            },
        } as any, 'run-1');

        expect(noteInstances[0].addToCollection).toHaveBeenCalledExactlyOnceWith(3);
        expect(result).toMatchObject({
            collection_key: 'LGCYKEY2',
            collection_keys: ['LGCYKEY2'],
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
                collection_keys: ['RLKEY234'],
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

    it('ignores a child note\'s collection arguments without resolving them', async () => {
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
                collections: ['NOSUCH', 'g99999-ZZZZ2345'],
                collection_key: 'ALSOBGUS',
            },
        } as any, 'run-1');

        // A child note can never be in a collection, so the arguments are not
        // resolved at all — they can neither be applied nor fail the apply.
        expect(vi.mocked(resolveSingleCollection)).not.toHaveBeenCalled();
        expect(noteInstances[0].addToCollection).not.toHaveBeenCalled();
        expect(result).toMatchObject({ parent_key: 'PARENTKEY' });
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
