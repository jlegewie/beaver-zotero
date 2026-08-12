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
    getLibraryByIdOrName,
    librariesForCollectionError,
    resolveCollectionForDisplay,
    resolveCollectionForWrite,
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

    it('takes the first eligible library when a key exists in two of them', () => {
        const resolved = resolveSingleCollection(duplicateKeyPersonal.key, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({
            ok: true,
            matchKind: 'key',
            match: { collection: duplicateKeyPersonal, libraryID: PERSONAL_LIBRARY },
        });
    });

    it('follows the caller-declared library precedence for a duplicated key', () => {
        // Precedence is the order of eligibleLibraryIds, so reversing it
        // resolves the same key to the other library.
        const resolved = resolveSingleCollection(duplicateKeyPersonal.key, {
            eligibleLibraryIds: [GROUP_LIBRARY, PERSONAL_LIBRARY],
        });
        expect(resolved).toMatchObject({ ok: true, matchKind: 'key', match: { libraryID: GROUP_LIBRARY } });
    });

    it('takes the first of two sibling collections sharing a name in one library', () => {
        const resolved = resolveSingleCollection('Reading', { eligibleLibraryIds: [PERSONAL_LIBRARY] });
        expect(resolved).toMatchObject({ ok: true, matchKind: 'name', match: { libraryID: PERSONAL_LIBRARY } });
    });

    it('takes the first of two collections sharing a name under different parents', () => {
        const resolved = resolveSingleCollection('Shared Name', { eligibleLibraryIds: [PERSONAL_LIBRARY] });
        expect(resolved).toMatchObject({ ok: true, matchKind: 'name', match: { collection: childA } });
    });

    it('prefers a key match over a row id for an 8-character digit-only string', () => {
        const resolved = resolveSingleCollection('23456789', { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: true, matchKind: 'key', match: { collection: numericKeyCollection } });
    });

    it('rejects a row id before looking up a collection on data paths', () => {
        const resolved = resolveSingleCollection(excludedCollection.id, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: false, code: 'invalid_request' });
        expect((globalThis as any).Zotero.Collections.get).not.toHaveBeenCalled();
    });

    it('rejects a digit-only row id before looking up a collection on data paths', () => {
        const resolved = resolveSingleCollection(String(excludedCollection.id), { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: false, code: 'invalid_request' });
        expect((globalThis as any).Zotero.Collections.get).not.toHaveBeenCalled();
    });

    // Request payloads are external JSON, so a reference of the wrong type must
    // come back as a typed failure. Throwing would surface to the model as an
    // internal error string instead of an actionable one.
    it.each([
        ['a boolean', true],
        ['an array', ['ABCD2345']],
        ['an object', { zotero_key: 'ABCD2345' }],
    ])('rejects %s reference as a malformed request rather than throwing', (_label, value) => {
        const resolved = resolveSingleCollection(value as never, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: false, code: 'invalid_request' });
        expect((resolved as { message: string }).message).toContain('must be a collection identifier');
    });

    // Trimming lives in the resolver so a padded reference behaves the same in
    // every handler, instead of resolving in whichever one happens to clean it.
    it('tolerates surrounding whitespace on a bare key, identifier and name', () => {
        expect(resolveSingleCollection(`  ${personalCollection.key}  `, { eligibleLibraryIds: searchableIds() }))
            .toMatchObject({ ok: true, matchKind: 'key', match: { collection: personalCollection } });
        expect(resolveSingleCollection(`  u-${personalCollection.key}  `, { eligibleLibraryIds: searchableIds() }))
            .toMatchObject({ ok: true, matchKind: 'identifier', match: { collection: personalCollection } });
        expect(resolveSingleCollection('  Reading  ', { eligibleLibraryIds: [PERSONAL_LIBRARY] }))
            .toMatchObject({ ok: true, matchKind: 'name' });
    });

    // Quoted, so the message names something instead of trailing off into
    // whitespace the caller cannot see.
    it('reads a whitespace-only reference as not found, quoting what was sent', () => {
        const resolved = resolveSingleCollection('   ', { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: false, code: 'collection_not_found' });
        expect((resolved as { message: string }).message).toBe('Collection not found: "   "');
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
        // The conflicting side is named by the identifier the caller passed; its
        // library may be one the user excluded, so its name is never disclosed.
        expect((resolved as any).message).toContain(`g12345-${groupCollection.key}`);
        expect((resolved as any).message).toContain('My Library');
        expect((resolved as any).message).not.toContain('Group A');
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

    it('treats a bare key and its scoped identifier identically when the library is eligible', () => {
        // The manual apply / undo shape: the caller passes the item's own
        // library, which may be excluded. Eligibility is the authority, so the
        // grammar the model happened to emit must not change the outcome.
        const options = { eligibleLibraryIds: [EXCLUDED_LIBRARY] };
        const expected = { ok: true, match: { collection: excludedCollection, libraryID: EXCLUDED_LIBRARY } };
        expect(resolveSingleCollection(excludedCollection.key, options)).toMatchObject(expected);
        expect(resolveSingleCollection(`g67890-${excludedCollection.key}`, options)).toMatchObject(expected);
    });

    it('returns collection_not_found for a blank reference', () => {
        expect(resolveSingleCollection('   ', { eligibleLibraryIds: searchableIds() })).toMatchObject({
            ok: false,
            code: 'collection_not_found',
        });
    });

    // A null reference is malformed rather than missing, and it names itself:
    // a caller reporting a batch otherwise says a collection was not found
    // without saying which entry to fix.
    it.each([
        ['null', null, 'null'],
        ['undefined', undefined, 'undefined'],
    ])('reports %s as a malformed reference that names itself', (_label, value, expected) => {
        const resolved = resolveSingleCollection(value, { eligibleLibraryIds: searchableIds() });
        expect(resolved).toMatchObject({ ok: false, code: 'invalid_request' });
        expect((resolved as { message: string }).message).toContain(expected);
    });
});

describe('resolveCollectionMatches', () => {
    it('returns every collection sharing a name inside one library', () => {
        const resolution = resolveCollectionMatches('Shared Name', { eligibleLibraryIds: [PERSONAL_LIBRARY] });
        expect(resolution).toMatchObject({ ok: true, matchKind: 'name' });
        expect((resolution as any).matches.map((m: any) => m.collection)).toEqual([childA, childB]);
    });

    it('returns both collections when a key is present in two eligible libraries', () => {
        // A key is unique only within a library. Filters OR every match; a
        // single-target caller takes the first, in eligible-library order.
        const resolution = resolveCollectionMatches(duplicateKeyPersonal.key, { eligibleLibraryIds: searchableIds() });
        expect(resolution).toMatchObject({ ok: true, matchKind: 'key' });
        expect((resolution as any).matches.map((m: any) => m.libraryID)).toEqual([PERSONAL_LIBRARY, GROUP_LIBRARY]);
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

    it('takes the first match when a reference matches more than once', () => {
        // Searchable-library order decides an un-hinted duplicated key, and a
        // name repeated inside one library resolves to the first of them.
        expect(getCollectionByIdOrName(duplicateKeyPersonal.key)).toEqual({
            collection: duplicateKeyPersonal,
            libraryID: PERSONAL_LIBRARY,
        });
        expect(getCollectionByIdOrName('Reading', PERSONAL_LIBRARY)).toMatchObject({
            libraryID: PERSONAL_LIBRARY,
        });
    });

    it('returns null for null/undefined input', () => {
        expect(getCollectionByIdOrName(null)).toBeNull();
        expect(getCollectionByIdOrName(undefined)).toBeNull();
    });
});

describe('resolveCollectionForWrite', () => {
    it('resolves scoped and bare identifiers but rejects device-local row ids', () => {
        expect(resolveCollectionForWrite(`u-${personalCollection.key}`, { eligibleLibraryIds: searchableIds() }))
            .toEqual({ ok: true, match: { collection: personalCollection, libraryID: PERSONAL_LIBRARY } });
        expect(resolveCollectionForWrite(personalCollection.key, { eligibleLibraryIds: searchableIds() }))
            .toEqual({ ok: true, match: { collection: personalCollection, libraryID: PERSONAL_LIBRARY } });
        expect(resolveCollectionForWrite(personalCollection.id, { eligibleLibraryIds: searchableIds() }))
            .toMatchObject({ ok: false, code: 'invalid_request' });
        expect((globalThis as any).Zotero.Collections.get).not.toHaveBeenCalled();
    });

    it('rejects a name that resolves to exactly one collection, and names its identifier', () => {
        const resolved = resolveCollectionForWrite('Personal Coll', { eligibleLibraryIds: [PERSONAL_LIBRARY] });
        expect(resolved).toMatchObject({ ok: false, code: 'invalid_request' });
        expect((resolved as any).message).toContain('u-ABCDEFGH');
        expect((resolved as any).message).toContain('list_collections');
    });

    it('passes a typed resolution failure through unchanged', () => {
        expect(resolveCollectionForWrite('ZZZZ2345', { eligibleLibraryIds: searchableIds() }))
            .toMatchObject({ ok: false, code: 'collection_not_found' });
        expect(resolveCollectionForWrite(`g67890-${excludedCollection.key}`, { eligibleLibraryIds: searchableIds() }))
            .toMatchObject({ ok: false, code: 'library_not_searchable' });
    });

    it('takes the first eligible library for a key present in two of them', () => {
        expect(resolveCollectionForWrite(duplicateKeyPersonal.key, { eligibleLibraryIds: searchableIds() }))
            .toMatchObject({ ok: true, match: { libraryID: PERSONAL_LIBRARY } });
    });
});

describe('resolveCollectionForDisplay', () => {
    it('keeps row-id compatibility on the explicitly display-only path', () => {
        expect(resolveCollectionForDisplay(excludedCollection.id)).toEqual({
            collection: excludedCollection,
            libraryID: EXCLUDED_LIBRARY,
        });
        expect(resolveCollectionForDisplay(String(excludedCollection.id))).toEqual({
            collection: excludedCollection,
            libraryID: EXCLUDED_LIBRARY,
        });
    });

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

    it('resolves an excluded-library identifier even when the hint names another library', () => {
        // A persisted tool call can pair a library argument with a collection
        // identifier from elsewhere; the label must still render, while the
        // data path stays scoped to the searchable libraries.
        expect(resolveCollectionForDisplay(`g67890-${excludedCollection.key}`, PERSONAL_LIBRARY)).toEqual({
            collection: excludedCollection,
            libraryID: EXCLUDED_LIBRARY,
        });
        expect(getCollectionByIdOrName(`g67890-${excludedCollection.key}`, PERSONAL_LIBRARY)).toBeNull();
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

    it('takes the first match when a reference matches more than once', () => {
        expect(resolveCollectionForDisplay(duplicateKeyPersonal.key)).toEqual({
            collection: duplicateKeyPersonal,
            libraryID: PERSONAL_LIBRARY,
        });
        expect(resolveCollectionForDisplay('Reading', PERSONAL_LIBRARY)).toMatchObject({
            libraryID: PERSONAL_LIBRARY,
        });
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
        // A missing collection is about the collection, not the library scope,
        // so the library list would be noise.
        expect(librariesForCollectionError('collection_not_found')).toBeUndefined();
    });
});

describe('getLibraryByIdOrName', () => {
    // Requests are external JSON; the string lookups index into the value, so an
    // off-contract type has to read as a named library that does not exist.
    it.each([
        ['a boolean', true],
        ['an object', { library_ref: 'u' }],
        ['a list', ['u']],
    ])('reports %s as a library that was explicitly requested and not found', (_label, value) => {
        const result = getLibraryByIdOrName(value as never);

        expect(result.library).toBeNull();
        expect(result.wasExplicitlyRequested).toBe(true);
        expect(typeof result.searchInput).toBe('string');
    });

    it('still resolves a numeric id and a portable ref', () => {
        expect(getLibraryByIdOrName(PERSONAL_LIBRARY).library).toBeTruthy();
        expect(getLibraryByIdOrName('u').library).toBeTruthy();
    });
});
