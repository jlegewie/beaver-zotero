import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCollection, resolveCollectionList, serializeCollectionIdentity, collectionLibrariesMismatchError } from '../../../src/services/collections/collectionIdentity';

const personal = { id: 10, key: 'ABCD2345', libraryID: 1, name: 'Research' };
const group = { id: 20, key: 'ABCD2345', libraryID: 7, name: 'Research' };
let collections: any[];
let zotero: any;
let previous: any;

beforeEach(() => {
    previous = (globalThis as any).Zotero;
    collections = [{ ...personal }, { ...group }];
    zotero = {
        Beaver: { libraryScopeInitialized: true, searchableLibraryIds: [1, 7] },
        Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1 }, { libraryID: 7 }] },
        Groups: {
            getLibraryIDFromGroupID: (id: number) => id === 12345 ? 7 : false,
            getGroupIDFromLibraryID: (id: number) => id === 7 ? 12345 : false,
        },
        Collections: {
            get: vi.fn((id: number) => collections.find(c => c.id === id) ?? false),
            getByLibraryAndKey: vi.fn((id: number, key: string) => collections.find(c => c.libraryID === id && c.key === key) ?? false),
            getByLibrary: vi.fn((id: number) => collections.filter(c => c.libraryID === id)),
        },
    };
    (globalThis as any).Zotero = zotero;
});
afterEach(() => { (globalThis as any).Zotero = previous; });

function expectCode(run: () => unknown, code: string) {
    expect(run).toThrow(expect.objectContaining({ code }));
}

describe('collection identity', () => {
    it.each(['u-ABCD2345', '1-ABCD2345', '1_ABCD2345', 10, '10'])('resolves exact and legacy reference %s', input => {
        expect(resolveCollection(input)).toMatchObject({ collectionId: 'u-ABCD2345', libraryRef: 'u', libraryID: 1, key: 'ABCD2345' });
    });
    it('does not mistake an all-digit bare key for a local numeric ID', () => {
        collections[0].key = '23456789';
        expect(resolveCollection('23456789').collection.id).toBe(10);
        collections[1].key = '23456789';
        expectCode(() => resolveCollection('23456789'), 'ambiguous_collection');
    });
    it('uses the device group mapping and ignores a default library for qualified identity', () => {
        expect(resolveCollection('g12345-ABCD2345', {})).toMatchObject({ collectionId: 'g12345-ABCD2345', libraryID: 7 });
    });
    it.each(['ABCD2345', 'Research', 'research'])('requires disambiguation for unscoped %s', input => {
        expectCode(() => resolveCollection(input), 'ambiguous_collection');
        expect(() => resolveCollection(input)).toThrow(/u-ABCD2345.*g12345-ABCD2345/);
        expect(resolveCollection(input, { libraryID: 7 }).libraryID).toBe(7);
    });
    it('does not use a default library to guess a colliding reference', () => {
        expectCode(() => resolveCollection('ABCD2345', {}), 'ambiguous_collection');
    });
    it('keeps qualified IDs terminal even when a collection has that name', () => {
        collections.push({ id: 30, key: 'ZZZZ2345', libraryID: 1, name: 'u-MISS2345' });
        expectCode(() => resolveCollection('u-MISS2345'), 'collection_not_found');
        expectCode(() => resolveCollection('g99999-ABCD2345'), 'library_unavailable');
    });
    it('never falls back out of an explicit library', () => {
        collections[1].key = 'GROUP234';
        expectCode(() => resolveCollection('GROUP234', { libraryID: 1 }), 'collection_not_found');
        expectCode(() => resolveCollection('g12345-GROUP234', { libraryID: 1 }), 'library_collection_mismatch');
        expectCode(() => resolveCollection(20, { libraryID: 1 }), 'library_collection_mismatch');
    });
    it('limits ambiguous candidates and paths to the allowed scope', () => {
        collections.push({ id: 30, key: 'CHILD234', libraryID: 1, name: 'Research', parentID: 10, parentKey: personal.key });
        expect(() => resolveCollection('Research', { libraryIds: [1] })).toThrow(/Research \/ Research/);
        try { resolveCollection('Research', { libraryIds: [1] }); } catch (error) {
            expect(String(error)).not.toContain('g12345');
        }
    });
    it('does not look up excluded libraries or reveal their collection names', () => {
        zotero.Beaver.searchableLibraryIds = [1];
        collections[1].name = 'Secret';
        expectCode(() => resolveCollection('g12345-ABCD2345'), 'library_not_searchable');
        expect(zotero.Collections.getByLibraryAndKey).not.toHaveBeenCalled();
        expect(resolveCollection('ABCD2345').libraryID).toBe(1);
        expectCode(() => resolveCollection('Secret'), 'collection_not_found');
        expect(zotero.Collections.getByLibrary).not.toHaveBeenCalledWith(7, true);
    });
    it('supports local-only history labels in excluded libraries', () => {
        zotero.Beaver.searchableLibraryIds = [];
        expect(resolveCollection('g12345-ABCD2345', { access: 'local' }).libraryID).toBe(7);
    });
    it('fails closed for empty scope and an unready access snapshot', () => {
        expect(resolveCollectionList(['ABCD2345', 10], { libraryIds: [] }).collections).toEqual([]);
        zotero.Beaver.libraryScopeInitialized = false;
        expect(resolveCollectionList(['u-ABCD2345', 'Research']).collections).toEqual([]);
        expect(zotero.Collections.getByLibraryAndKey).not.toHaveBeenCalled();
        expect(zotero.Collections.getByLibrary).not.toHaveBeenCalled();
    });
    it('excludes trashed collections from exact and loose lookup', () => {
        collections[0].deleted = true;
        expectCode(() => resolveCollection('u-ABCD2345'), 'collection_not_found');
        expectCode(() => resolveCollection(10), 'collection_not_found');
        expect(resolveCollection('Research').libraryID).toBe(7);
    });
    it('deduplicates full identities, retaining distinct same-key collections', () => {
        const result = resolveCollectionList(['u-ABCD2345', '1-ABCD2345', 'g12345-ABCD2345', 'Missing']);
        expect(result.collections.map(c => c.collectionId)).toEqual(['u-ABCD2345', 'g12345-ABCD2345']);
        expect(result.failures.map(f => f.input)).toEqual(['Missing']);
    });
    it('serializes parent identity and refuses missing portable mapping', () => {
        expect(serializeCollectionIdentity({ ...group, parentKey: 'PARENT23' } as any)).toEqual({
            collection_id: 'g12345-ABCD2345', library_ref: 'g12345', name: 'Research', parent_collection_id: 'g12345-PARENT23',
        });
        zotero.Groups.getGroupIDFromLibraryID = () => false;
        expectCode(() => resolveCollection('7-ABCD2345'), 'library_unavailable');
    });
});

describe('model-facing recovery guidance', () => {
    it('identifies explicit conflicts and tells the caller how to preserve identity', () => {
        expectCode(() => resolveCollection('g12345-ABCD2345', { libraryID: 1 }), 'library_collection_mismatch');
        try { resolveCollection('g12345-ABCD2345', { libraryID: 1 }); }
        catch (error: any) {
            expect(error.message).toContain('g12345-ABCD2345');
            expect(error.message).toContain('requested library "u"');
            expect(error.message).toContain('from library "g12345"');
            expect(error.message).toContain('list_collections');
            expect(error.message).toContain('do not strip');
        }
    });
    it('names the unavailable reference and gives a recovery path', () => {
        expect(() => resolveCollection('g99999-ABCD2345')).toThrow(/g99999-ABCD2345.*list_libraries.*user.*same qualified ID/);
    });
    it('distinguishes loading access from an explicitly empty scope', () => {
        expect(() => resolveCollection('Research', { libraryIds: [] })).toThrow(/Research.*scope.*list_libraries/);
        zotero.Beaver.libraryScopeInitialized = false;
        expect(() => resolveCollection('Research')).toThrow(/Research.*still loading.*Retry/);
    });
    it('offers scope recovery without disclosing excluded collection or library names', () => {
        zotero.Beaver.searchableLibraryIds = [1];
        collections[1].name = 'Private research';
        const result = resolveCollectionList(['g12345-ABCD2345']);
        const message = result.failures[0].error.message;
        expect(message).toContain('g12345-ABCD2345');
        expect(message).toContain('list_libraries');
        expect(message).toContain('Library Access');
        expect(message).not.toContain('Private research');
        expect(zotero.Collections.getByLibraryAndKey).not.toHaveBeenCalled();
        try { resolveCollection(20, { libraryID: 1 }); } catch (error: any) {
            expect(error.message).not.toContain('g12345');
            expect(error.message).not.toContain('Private research');
        }
    });
    it('lists permitted identities and gives operation-specific single-library guidance', () => {
        const targets = resolveCollectionList(['u-ABCD2345', 'g12345-ABCD2345']).collections;
        for (const operation of ['search', 'note'] as const) {
            const message = collectionLibrariesMismatchError(targets, operation).message;
            expect(message).toContain('u-ABCD2345 (library u)');
            expect(message).toContain('g12345-ABCD2345 (library g12345)');
            expect(message).toContain(operation === 'search' ? 'separate requests' : 'A single note');
        }
    });
});
