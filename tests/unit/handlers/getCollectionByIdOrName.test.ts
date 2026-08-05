/**
 * Focused unit tests for the collection resolver and its legacy wrapper
 * (src/services/agentDataProvider/utils.ts).
 *
 * The module has a wide transitive dependency surface (document extraction,
 * sync, popups, etc.) that collection resolution itself never touches, so
 * every unrelated dependency is stubbed out just to make the module
 * importable in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ searchableLibraryIds: [1, 100] as number[] }));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeIsInTrash: vi.fn(),
    safeFileExists: vi.fn(),
    isLinkedUrlAttachment: vi.fn(),
}));
vi.mock('../../../src/utils/sync', () => ({
    syncingItemFilterAsync: vi.fn(),
}));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn(),
}));
vi.mock('../../../react/utils/popupMessageUtils', () => ({
    addPopupMessageAtom: {},
}));
vi.mock('../../../react/utils/sourceUtils', () => ({
    wasItemAddedBeforeLastSync: vi.fn(),
}));
vi.mock('../../../react/atoms/deferredToolPreferences', () => ({
    deferredToolPreferencesAtom: {},
}));
vi.mock('../../../src/utils/agentItemSupport', () => ({
    isAgentSupportedItem: vi.fn(),
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => harness.searchableLibraryIds) },
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    activeRunAtom: Symbol('activeRunAtom'),
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfo', () => ({
    getAttachmentInfo: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfoBatch', () => ({
    getBestAttachmentBatch: vi.fn(),
    prepareAttachmentInfoBatchData: vi.fn(),
    processAttachmentInfoBatch: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction', () => ({
    loadPdfData: vi.fn(),
    isRemoteAccessAvailable: vi.fn(),
    validateZoteroItemReference: vi.fn(),
    checkRemotePdfSize: vi.fn(),
    preflightCachedPdfMeta: vi.fn(),
    resolveToPdfAttachment: vi.fn(),
    resolveToImageAttachment: vi.fn(),
}));

import {
    getCollectionByIdOrName,
    librariesForCollectionError,
    resolveCollectionForDisplay,
    resolveCollectionMatches,
    resolveSingleCollection,
} from '../../../src/services/agentDataProvider/utils';

const PERSONAL_LIBRARY = 1;
const GROUP_LIBRARY = 100;
const EXCLUDED_LIBRARY = 200;

const LIBRARIES = [
    { libraryID: PERSONAL_LIBRARY, name: 'My Library' },
    { libraryID: GROUP_LIBRARY, name: 'Group A' },
    { libraryID: EXCLUDED_LIBRARY, name: 'Group B' },
];

const GROUP_ID_BY_LIBRARY: Record<number, number> = {
    [GROUP_LIBRARY]: 12345,
    [EXCLUDED_LIBRARY]: 67890,
};

type MockCollection = { id: number; key: string; libraryID: number; name: string; parentID?: number };

const personalCollection: MockCollection = { id: 10, key: 'ABCDEFGH', libraryID: PERSONAL_LIBRARY, name: 'Personal Coll' };
const groupCollection: MockCollection = { id: 20, key: 'GRPCZZZ2', libraryID: GROUP_LIBRARY, name: 'Group Coll' };

// Same key in two libraries: Zotero keys are unique per library, not globally.
const duplicateKeyPersonal: MockCollection = { id: 40, key: 'DUPEKEYZ', libraryID: PERSONAL_LIBRARY, name: 'Dup Personal' };
const duplicateKeyGroup: MockCollection = { id: 41, key: 'DUPEKEYZ', libraryID: GROUP_LIBRARY, name: 'Dup Group' };

// Same name twice in one library: as siblings, and under different parents.
const siblingA: MockCollection = { id: 50, key: 'SIBLAAA2', libraryID: PERSONAL_LIBRARY, name: 'Reading' };
const siblingB: MockCollection = { id: 51, key: 'SIBLAAA3', libraryID: PERSONAL_LIBRARY, name: 'Reading' };
const childA: MockCollection = { id: 52, key: 'CHLDAAA2', libraryID: PERSONAL_LIBRARY, name: 'Shared Name', parentID: 60 };
const childB: MockCollection = { id: 53, key: 'CHLDAAA3', libraryID: PERSONAL_LIBRARY, name: 'Shared Name', parentID: 61 };

// An 8-digit key is also a plausible row id; the key grammar is tried first.
const numericKeyCollection: MockCollection = { id: 70, key: '23456789', libraryID: PERSONAL_LIBRARY, name: 'Numeric Key' };
const numericRowIdCollection: MockCollection = { id: 23456789, key: 'RWIDCELL', libraryID: PERSONAL_LIBRARY, name: 'Row Id Coll' };

// Names that look like scoped identifiers but whose suffix is not a Zotero key.
const namedLikeUserRef: MockCollection = { id: 80, key: 'UDRAFTSZ', libraryID: PERSONAL_LIBRARY, name: 'u-Drafts' };
const namedLikeGroupRef: MockCollection = { id: 81, key: 'GARCHIVZ', libraryID: PERSONAL_LIBRARY, name: 'g123-Archive' };
const namedLikeMissingId: MockCollection = { id: 82, key: 'NAMEDIDZ', libraryID: PERSONAL_LIBRARY, name: 'u-MISSINGZ' };
// Suffix is 8 characters but uses characters Zotero keys never contain.
const namedLikeInvalidKeyRef: MockCollection = { id: 83, key: 'NAMEDIDY', libraryID: PERSONAL_LIBRARY, name: 'u-DRAFT001' };

const excludedCollection: MockCollection = { id: 90, key: 'EXCLZZZ2', libraryID: EXCLUDED_LIBRARY, name: 'Excluded Coll' };

const COLLECTIONS: MockCollection[] = [
    personalCollection,
    groupCollection,
    duplicateKeyPersonal,
    duplicateKeyGroup,
    siblingA,
    siblingB,
    childA,
    childB,
    numericKeyCollection,
    numericRowIdCollection,
    namedLikeUserRef,
    namedLikeGroupRef,
    namedLikeMissingId,
    namedLikeInvalidKeyRef,
    excludedCollection,
];

let previousZotero: any;

beforeEach(() => {
    vi.clearAllMocks();
    harness.searchableLibraryIds = [PERSONAL_LIBRARY, GROUP_LIBRARY];
    previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
        Libraries: {
            get: vi.fn((libraryID: number) => LIBRARIES.find(l => l.libraryID === libraryID) ?? false),
            getAll: vi.fn(() => LIBRARIES),
            userLibraryID: PERSONAL_LIBRARY,
        },
        Groups: {
            getGroupIDFromLibraryID: vi.fn((libraryID: number) => GROUP_ID_BY_LIBRARY[libraryID] ?? false),
            getLibraryIDFromGroupID: vi.fn((groupID: number) => {
                const entry = Object.entries(GROUP_ID_BY_LIBRARY).find(([, id]) => id === groupID);
                return entry ? Number(entry[0]) : false;
            }),
        },
        Collections: {
            get: vi.fn((id: number) => COLLECTIONS.find(c => c.id === id) ?? false),
            getByLibraryAndKey: vi.fn(
                (libraryID: number, key: string) =>
                    COLLECTIONS.find(c => c.libraryID === libraryID && c.key === key) ?? false
            ),
            getByLibrary: vi.fn((libraryID: number) => COLLECTIONS.filter(c => c.libraryID === libraryID)),
        },
        Utilities: {
            // Mirrors Zotero's own key alphabet (no 0, 1 or O), which the
            // identifier-vs-name precedence rules depend on.
            isValidObjectKey: vi.fn((key: string) => /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key)),
        },
    };
});

afterEach(() => {
    (globalThis as any).Zotero = previousZotero;
});

const searchableIds = () => [PERSONAL_LIBRARY, GROUP_LIBRARY];

describe('resolveSingleCollection', () => {
    it('resolves a bare key found in exactly one eligible library', () => {
        const resolved = resolveSingleCollection(personalCollection.key, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({
            ok: true,
            matchKind: 'key',
            match: { collection: personalCollection, libraryID: PERSONAL_LIBRARY },
        });
    });

    it('rejects a key that exists in two eligible libraries as ambiguous', () => {
        const resolved = resolveSingleCollection(duplicateKeyPersonal.key, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: false, code: 'ambiguous_collection' });
        // The message must let the caller retry with a scoped identifier.
        expect((resolved as any).message).toContain('u-DUPEKEYZ');
        expect((resolved as any).message).toContain('g12345-DUPEKEYZ');
    });

    it('rejects a name held by two sibling collections in one library as ambiguous', () => {
        const resolved = resolveSingleCollection('Reading', { eligibleLibraryIds: [PERSONAL_LIBRARY] });
        expect(resolved).toMatchObject({ ok: false, code: 'ambiguous_collection' });
        expect((resolved as any).message).toContain('u-SIBLAAA2');
        expect((resolved as any).message).toContain('u-SIBLAAA3');
    });

    it('rejects a name held by collections under different parents in one library as ambiguous', () => {
        const resolved = resolveSingleCollection('Shared Name', { eligibleLibraryIds: [PERSONAL_LIBRARY] });
        expect(resolved).toMatchObject({ ok: false, code: 'ambiguous_collection' });
        expect((resolved as any).message).toContain('u-CHLDAAA2');
        expect((resolved as any).message).toContain('u-CHLDAAA3');
    });

    it('resolves a number as a collection row id', () => {
        const resolved = resolveSingleCollection(personalCollection.id, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: true, matchKind: 'row_id', match: { collection: personalCollection } });
    });

    it('resolves a digit-only string as a collection row id', () => {
        const resolved = resolveSingleCollection(String(personalCollection.id), { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: true, matchKind: 'row_id', match: { collection: personalCollection } });
    });

    it('prefers a key match over a row id for an 8-character digit-only string', () => {
        const resolved = resolveSingleCollection('23456789', { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: true, matchKind: 'key', match: { collection: numericKeyCollection } });
    });

    it('treats a row id outside the eligible libraries as not found', () => {
        const resolved = resolveSingleCollection(excludedCollection.id, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: false, code: 'collection_not_found' });
    });

    it('resolves a scoped identifier in its embedded library', () => {
        expect(resolveSingleCollection(`u-${personalCollection.key}`, { eligibleLibraryIds: searchableIds() })).toMatchObject({
            ok: true,
            matchKind: 'identifier',
            match: { collection: personalCollection, libraryID: PERSONAL_LIBRARY },
        });
        expect(resolveSingleCollection(`g12345-${groupCollection.key}`, { eligibleLibraryIds: searchableIds() })).toMatchObject({
            ok: true,
            matchKind: 'identifier',
            match: { collection: groupCollection, libraryID: GROUP_LIBRARY },
        });
        expect(resolveSingleCollection(`1-${personalCollection.key}`, { eligibleLibraryIds: searchableIds() })).toMatchObject({
            ok: true,
            matchKind: 'identifier',
            match: { collection: personalCollection, libraryID: PERSONAL_LIBRARY },
        });
    });

    it('treats a hyphenated value whose suffix is not a key as a collection name', () => {
        expect(resolveSingleCollection('u-Drafts', { eligibleLibraryIds: [PERSONAL_LIBRARY] })).toMatchObject({
            ok: true,
            matchKind: 'name',
            match: { collection: namedLikeUserRef },
        });
        expect(resolveSingleCollection('g123-Archive', { eligibleLibraryIds: [PERSONAL_LIBRARY] })).toMatchObject({
            ok: true,
            matchKind: 'name',
            match: { collection: namedLikeGroupRef },
        });
    });

    it('treats a suffix of key length that uses non-key characters as part of a name', () => {
        const resolved = resolveSingleCollection('u-DRAFT001', { eligibleLibraryIds: [PERSONAL_LIBRARY] });
        expect(resolved).toMatchObject({ ok: true, matchKind: 'name', match: { collection: namedLikeInvalidKeyRef } });
    });

    it('never falls through to a name match for a well-formed scoped identifier', () => {
        // A collection literally named "u-MISSINGZ" exists, but the identifier
        // grammar is authoritative and its key does not.
        const resolved = resolveSingleCollection('u-MISSINGZ', { eligibleLibraryIds: [PERSONAL_LIBRARY] });
        expect(resolved).toMatchObject({ ok: false, code: 'collection_not_found' });
    });

    it('reports a scoped identifier for a group library missing on this device as unavailable', () => {
        const resolved = resolveSingleCollection(`g99999-${groupCollection.key}`, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: false, code: 'library_unavailable' });
    });

    it('reports a scoped identifier for an excluded library as not searchable', () => {
        const resolved = resolveSingleCollection(`g67890-${excludedCollection.key}`, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: false, code: 'library_not_searchable' });
    });

    it('treats a bare key that only matches inside an excluded library as not found', () => {
        // No existence leak: the excluded library is not eligible, so the key
        // simply does not resolve.
        const resolved = resolveSingleCollection(excludedCollection.key, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: false, code: 'collection_not_found' });
    });

    it('rejects a scoped identifier that conflicts with an explicitly requested library', () => {
        const resolved = resolveSingleCollection(`g12345-${groupCollection.key}`, {
            eligibleLibraryIds: [PERSONAL_LIBRARY],
            explicitLibrary: true,
        });
        expect(resolved).toMatchObject({ ok: false, code: 'invalid_request' });
        expect((resolved as any).message).toContain('Group A');
        expect((resolved as any).message).toContain('My Library');
    });

    it('resolves a bare group key when the request omitted the library but not when it named the personal library', () => {
        expect(resolveSingleCollection(groupCollection.key, { eligibleLibraryIds: searchableIds() })).toMatchObject({
            ok: true,
            match: { libraryID: GROUP_LIBRARY },
        });
        expect(
            resolveSingleCollection(groupCollection.key, {
                eligibleLibraryIds: [PERSONAL_LIBRARY],
                explicitLibrary: true,
            })
        ).toMatchObject({ ok: false, code: 'collection_not_found' });
    });

    it('returns collection_not_found for empty and null input', () => {
        expect(resolveSingleCollection(null, { eligibleLibraryIds: searchableIds() })).toMatchObject({
            ok: false,
            code: 'collection_not_found',
        });
        expect(resolveSingleCollection('   ', { eligibleLibraryIds: searchableIds() })).toMatchObject({
            ok: false,
            code: 'collection_not_found',
        });
    });
});

describe('resolveCollectionMatches', () => {
    it('returns every collection sharing a name inside one library', () => {
        const resolution = resolveCollectionMatches('Shared Name', { eligibleLibraryIds: [PERSONAL_LIBRARY] });
        expect(resolution).toMatchObject({ ok: true, matchKind: 'name' });
        expect((resolution as any).matches.map((m: any) => m.collection)).toEqual([childA, childB]);
    });

    it('rejects a key present in two eligible libraries instead of returning both', () => {
        // A key denotes one object, so expanding it to several would change what
        // the caller asked for.
        const resolution = resolveCollectionMatches(duplicateKeyPersonal.key, { eligibleLibraryIds: searchableIds() });
        expect(resolution).toMatchObject({ ok: false, code: 'ambiguous_collection' });
    });

    it('scopes name matching to nameLibraryIds when it differs from the eligible libraries', () => {
        const resolution = resolveCollectionMatches('Group Coll', {
            eligibleLibraryIds: searchableIds(),
            nameLibraryIds: [PERSONAL_LIBRARY],
        });
        expect(resolution).toMatchObject({ ok: false, code: 'collection_not_found' });
    });
});

describe('getCollectionByIdOrName', () => {
    it('resolves a bare key without a library hint', () => {
        const result = getCollectionByIdOrName(personalCollection.key);
        expect(result).toEqual({ collection: personalCollection, libraryID: PERSONAL_LIBRARY });
    });

    it('resolves a legacy numeric compound "<libraryID>-<key>" id', () => {
        const result = getCollectionByIdOrName(`1-${personalCollection.key}`);
        expect(result).toEqual({ collection: personalCollection, libraryID: PERSONAL_LIBRARY });
    });

    it('resolves a portable "u-<key>" compound id to the personal library', () => {
        const result = getCollectionByIdOrName(`u-${personalCollection.key}`);
        expect(result).toEqual({ collection: personalCollection, libraryID: PERSONAL_LIBRARY });
    });

    it('resolves a portable "g<id>-<key>" compound id to the mapped group library', () => {
        const result = getCollectionByIdOrName(`g12345-${groupCollection.key}`);
        expect(result).toEqual({ collection: groupCollection, libraryID: GROUP_LIBRARY });
    });

    it('falls through to a not-found result for an unresolvable portable group ref', () => {
        const result = getCollectionByIdOrName(`g99999-${groupCollection.key}`);
        expect(result).toBeNull();
    });

    it('preserves fallback semantics: a hyphenated name that is not a compound id falls through to name lookup', () => {
        const result = getCollectionByIdOrName('u-Drafts', PERSONAL_LIBRARY);
        expect(result).toEqual({ collection: namedLikeUserRef, libraryID: PERSONAL_LIBRARY });
    });

    it('scopes name lookups to the hinted library', () => {
        expect(getCollectionByIdOrName('Group Coll', PERSONAL_LIBRARY)).toBeNull();
        expect(getCollectionByIdOrName('Group Coll', GROUP_LIBRARY)).toEqual({
            collection: groupCollection,
            libraryID: GROUP_LIBRARY,
        });
    });

    it('resolves a key shared by two libraries inside the hinted one', () => {
        expect(getCollectionByIdOrName(duplicateKeyPersonal.key, PERSONAL_LIBRARY)).toEqual({
            collection: duplicateKeyPersonal,
            libraryID: PERSONAL_LIBRARY,
        });
        expect(getCollectionByIdOrName(duplicateKeyGroup.key, GROUP_LIBRARY)).toEqual({
            collection: duplicateKeyGroup,
            libraryID: GROUP_LIBRARY,
        });
    });

    it('widens a key lookup beyond the hinted library when it does not match there', () => {
        expect(getCollectionByIdOrName(groupCollection.key, PERSONAL_LIBRARY)).toEqual({
            collection: groupCollection,
            libraryID: GROUP_LIBRARY,
        });
    });

    it('returns null when a reference is ambiguous rather than guessing a target', () => {
        expect(getCollectionByIdOrName(duplicateKeyPersonal.key)).toBeNull();
        expect(getCollectionByIdOrName('Reading', PERSONAL_LIBRARY)).toBeNull();
    });

    it('returns null for null/undefined input', () => {
        expect(getCollectionByIdOrName(null)).toBeNull();
        expect(getCollectionByIdOrName(undefined)).toBeNull();
    });
});

describe('resolveCollectionForDisplay', () => {
    it('resolves a collection in an excluded library', () => {
        expect(resolveCollectionForDisplay(excludedCollection.key)).toEqual({
            collection: excludedCollection,
            libraryID: EXCLUDED_LIBRARY,
        });
        expect(resolveCollectionForDisplay(`g67890-${excludedCollection.key}`)).toEqual({
            collection: excludedCollection,
            libraryID: EXCLUDED_LIBRARY,
        });
    });

    it('resolves while the searchable-library set is still empty', () => {
        // The searchable set is fail-closed until the profile loads; a label
        // must not depend on it.
        harness.searchableLibraryIds = [];
        expect(resolveCollectionForDisplay(personalCollection.key)).toEqual({
            collection: personalCollection,
            libraryID: PERSONAL_LIBRARY,
        });
    });

    it('returns null on ambiguity rather than guessing a target', () => {
        expect(resolveCollectionForDisplay(duplicateKeyPersonal.key)).toBeNull();
        expect(resolveCollectionForDisplay('Reading', PERSONAL_LIBRARY)).toBeNull();
    });

    it('resolves a key shared by two libraries inside the hinted one', () => {
        expect(resolveCollectionForDisplay(duplicateKeyGroup.key, GROUP_LIBRARY)).toEqual({
            collection: duplicateKeyGroup,
            libraryID: GROUP_LIBRARY,
        });
    });
});

describe('librariesForCollectionError', () => {
    it('echoes the searchable libraries only on library-scope failures', () => {
        expect(librariesForCollectionError('library_unavailable')).not.toBeUndefined();
        expect(librariesForCollectionError('library_not_searchable')).not.toBeUndefined();
        expect(librariesForCollectionError('invalid_request')).not.toBeUndefined();
        // A missing collection and an ambiguous reference are about the
        // collection, not the library scope: the ambiguity message already
        // names every candidate, so the library list would be noise.
        expect(librariesForCollectionError('collection_not_found')).toBeUndefined();
        expect(librariesForCollectionError('ambiguous_collection')).toBeUndefined();
    });
});
