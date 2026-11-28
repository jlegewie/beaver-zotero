import { beforeEach, describe, expect, it, vi } from 'vitest';
import { savePreparedNote } from '../../../src/services/savePreparedNote';

/** A collection whose cached item list Zotero updates when an item save commits. */
class MockCollection {
    childItems = new Set<number>();
    constructor(public id: number, public libraryID: number) {}
    hasItem(itemID: number) { return this.childItems.has(itemID); }
}

const collections = new Map<number, MockCollection>();
let nextItemID = 100;

/** Models Zotero's item save: collection membership set before save is written with the item. */
class MockNote {
    id: number | false = false;
    libraryID = 0;
    parentKey: string | false = false;
    collectionsAtSave: number[] = [];
    private collections: number[] = [];
    setNote = vi.fn();
    addToCollection(collectionID: number) { this.collections.push(collectionID); }
    getCollections() { return [...this.collections]; }
    saveTx = vi.fn(async () => {
        if (this.parentKey && this.collections.length) throw new Error('child items cannot be in collections');
        this.id = nextItemID++;
        this.collectionsAtSave = [...this.collections];
        for (const id of this.collections) collections.get(id)!.childItems.add(this.id);
    });
}

describe('savePreparedNote', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        collections.clear();
        collections.set(5, new MockCollection(5, 1));
        collections.set(9, new MockCollection(9, 2));
        (globalThis as any).Zotero = {
            Item: MockNote,
            Libraries: { get: vi.fn((id: number) => (id === 1 || id === 2 || id === 3 ? { libraryID: id, name: `Library ${id}` } : false)) },
            Collections: { get: vi.fn((id: number) => collections.get(id) ?? false) },
            DB: { executeTransaction: vi.fn() },
            Beaver: { libraryScopeInitialized: true, searchableLibraryIds: [1, 2] },
        };
    });

    it('files the note in its collection within the note save, so the collection knows the note', async () => {
        const note = await savePreparedNote({ libraryId: 1, collectionId: 5, html: '<p>Saved</p>' }) as unknown as MockNote;

        expect(note.saveTx).toHaveBeenCalledOnce();
        expect(note.collectionsAtSave).toEqual([5]);
        expect(collections.get(5)!.hasItem(note.id as number)).toBe(true);
        // No separate, unawaited collection write after the save.
        expect(Zotero.DB.executeTransaction).not.toHaveBeenCalled();
    });

    it('does not file the note in a collection from another library', async () => {
        const note = await savePreparedNote({ libraryId: 1, collectionId: 9, html: '<p>Saved</p>' }) as unknown as MockNote;

        expect(note.getCollections()).toEqual([]);
        expect(collections.get(9)!.hasItem(note.id as number)).toBe(false);
    });

    it('saves a child note under its parent and ignores a collection', async () => {
        const note = await savePreparedNote({
            libraryId: 1, parentKey: 'PARENT01', collectionId: 5, html: '<p>Child</p>',
        }) as unknown as MockNote;

        expect(note.parentKey).toBe('PARENT01');
        expect(note.getCollections()).toEqual([]);
        expect(collections.get(5)!.hasItem(note.id as number)).toBe(false);
    });

    it('refuses to write to an excluded library', async () => {
        await expect(savePreparedNote({ libraryId: 3, collectionId: 5, html: '<p>Saved</p>' }))
            .rejects.toThrow('is excluded from Beaver, so Beaver cannot modify its items');
        expect(collections.get(5)!.childItems.size).toBe(0);
    });
});
