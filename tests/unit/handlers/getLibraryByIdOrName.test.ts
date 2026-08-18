/**
 * Focused unit tests for getLibraryByIdOrName, validateLibraryAccess,
 * resolveLibrariesFilter, librariesFilterError, and
 * resolveLibrariesFilterToSearchableIds (src/services/agentDataProvider/utils.ts).
 *
 * The module has a wide transitive dependency surface (document extraction,
 * sync, popups, etc.) that these functions never touch, so every unrelated
 * dependency is stubbed out just to make the module importable in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    store: { get: vi.fn() },
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    activeRunAtom: Symbol('activeRunAtom'),
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
    isLibraryAccessReadyAtom: Symbol('isLibraryAccessReadyAtom'),
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

import { store } from '../../../react/store';
import { isLibraryAccessReadyAtom, searchableLibraryIdsAtom } from '../../../react/atoms/profile';
import {
    getLibraryByIdOrName,
    validateLibraryAccess,
    librariesFilterError,
    resolveLibrariesFilter,
    resolveLibrariesFilterToSearchableIds,
} from '../../../src/services/agentDataProvider/utils';

// A group library reachable from this device (group id 555 -> local library 100)
// and a resolvable-but-excluded group library (group id 777 -> local library 300,
// deliberately left out of the searchable set below).
const userLibrary = { libraryID: 1, name: 'My Library' };
const groupAlpha = { libraryID: 100, name: 'Group Alpha' };
const numericPrefix = { libraryID: 200, name: '2024 Projects' };
const groupExcluded = { libraryID: 300, name: 'Excluded Group' };
const allLibraries = [userLibrary, groupAlpha, numericPrefix, groupExcluded];

/**
 * Answer per atom: the searchable set and the access-ready flag are read from the
 * same store, and conflating them hides the loading state these helpers gate on.
 */
function setLibraryAccess(ids: number[], accessReady = true) {
    vi.mocked(store.get).mockImplementation((atom: any) => {
        if (atom === isLibraryAccessReadyAtom) return accessReady;
        if (atom === searchableLibraryIdsAtom) return ids;
        return undefined;
    });
}

function setSearchableLibraryIds(ids: number[]) {
    setLibraryAccess(ids);
}

function installZoteroMock() {
    (globalThis as any).Zotero = {
        Libraries: {
            get: vi.fn((id: number) => allLibraries.find(l => l.libraryID === id) ?? false),
            getAll: vi.fn(() => allLibraries),
            userLibraryID: 1,
            userLibrary,
        },
        Groups: {
            getGroupIDFromLibraryID: vi.fn((libId: number) => {
                if (libId === 100) return 555;
                if (libId === 300) return 777;
                return false;
            }),
            getLibraryIDFromGroupID: vi.fn((groupId: number) => {
                if (groupId === 555) return 100;
                if (groupId === 777) return 300;
                return false;
            }),
        },
    };
}

describe('getLibraryByIdOrName / validateLibraryAccess', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        setSearchableLibraryIds([1, 100, 200]);
        previousZotero = (globalThis as any).Zotero;
        installZoteroMock();
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('resolves a numeric library id', () => {
        const result = getLibraryByIdOrName(100);
        expect(result).toEqual({ library: groupAlpha, wasExplicitlyRequested: true, searchInput: '100' });
    });

    it('resolves a numeric-id string', () => {
        const result = getLibraryByIdOrName('100');
        expect(result.library).toEqual(groupAlpha);
        expect(result.wasExplicitlyRequested).toBe(true);
    });

    it('resolves an exact library name case-insensitively', () => {
        const result = getLibraryByIdOrName('group alpha');
        expect(result.library).toEqual(groupAlpha);
    });

    it('defaults to the user library when nothing is requested', () => {
        const result = getLibraryByIdOrName(null);
        expect(result).toEqual({ library: userLibrary, wasExplicitlyRequested: false, searchInput: null });
    });

    it('resolves the portable "u" ref to the personal library', () => {
        const result = getLibraryByIdOrName('u');
        expect(result.library).toEqual(userLibrary);
        expect(result.wasExplicitlyRequested).toBe(true);
    });

    it('resolves a portable "g<groupID>" ref to the mapped group library', () => {
        const result = getLibraryByIdOrName('g555');
        expect(result.library).toEqual(groupAlpha);
    });

    it('returns a null library for a group ref not registered on this device, without falling back to numeric/name lookup', () => {
        const result = getLibraryByIdOrName('g999999');
        expect(result.library).toBeNull();
        expect(result.wasExplicitlyRequested).toBe(true);

        const validation = validateLibraryAccess('g999999');
        expect(validation.valid).toBe(false);
        expect(validation.error_code).toBe('library_not_found');
    });

    it('flags a resolvable but excluded library as not searchable', () => {
        const validation = validateLibraryAccess('g777');
        expect(validation.valid).toBe(false);
        expect(validation.error_code).toBe('library_not_searchable');
    });
});

describe('resolveLibrariesFilterToSearchableIds', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        setSearchableLibraryIds([1, 100, 200]);
        previousZotero = (globalThis as any).Zotero;
        installZoteroMock();
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('resolves a mix of portable refs, numeric ids, numeric-id strings, and name substrings', () => {
        const result = resolveLibrariesFilterToSearchableIds(['u', 'g555', 100, '100', 'alpha']);
        expect([...result].sort((a, b) => a - b)).toEqual([1, 100]);
    });

    it('deduplicates a portable ref and its equivalent legacy numeric id', () => {
        const result = resolveLibrariesFilterToSearchableIds(['u', '1']);
        expect(result).toEqual([1]);
    });

    it('contributes nothing for a group ref not registered on this device', () => {
        const result = resolveLibrariesFilterToSearchableIds(['g999999']);
        expect(result).toEqual([]);
    });

    it('excludes a resolvable library that is not searchable, whether given by id or ref', () => {
        const result = resolveLibrariesFilterToSearchableIds([300, 'g777']);
        expect(result).toEqual([]);
    });

    it('ignores malformed non-string entries instead of throwing', () => {
        const result = resolveLibrariesFilterToSearchableIds(
            [null, false, undefined, {}, 'u'] as unknown as Array<string | number>
        );
        expect(result).toEqual([1]);
    });

    it('preserves case-insensitive name-substring matching, scoped to searchable libraries', () => {
        // "Excluded Group" also matches the substring but its library isn't searchable.
        const result = resolveLibrariesFilterToSearchableIds(['group']);
        expect(result).toEqual([100]);
    });

    it('treats a digit-prefixed filter as a name unless the entire string is digits', () => {
        expect(resolveLibrariesFilterToSearchableIds(['2024 Projects'])).toEqual([200]);
    });
});

describe('resolveLibrariesFilter / librariesFilterError', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        setSearchableLibraryIds([1, 100]);
        previousZotero = (globalThis as any).Zotero;
        installZoteroMock();
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('reports a group ref this device does not have as unresolved, not excluded', () => {
        const resolution = resolveLibrariesFilter(['g999999']);
        expect(resolution).toEqual({ libraryIds: [], unresolved: ['g999999'], excluded: [] });
        expect(librariesFilterError(resolution)?.error_code).toBe('library_not_found');
    });

    it('names the available libraries by portable ref when nothing resolved', () => {
        const error = librariesFilterError(resolveLibrariesFilter(['Nope']));
        expect(error?.message).toContain('Library not found: "Nope"');
        expect(error?.message).toContain('"My Library" (u)');
        expect(error?.message).toContain('"Group Alpha" (g555)');
    });

    it('distinguishes an excluded library from an unknown one', () => {
        const resolution = resolveLibrariesFilter(['g777']);
        expect(resolution.libraryIds).toEqual([]);
        expect(resolution.unresolved).toEqual([]);
        expect(resolution.excluded).toEqual([{ input: 'g777', libraryId: 300 }]);
        expect(librariesFilterError(resolution)?.error_code).toBe('library_not_searchable');
    });

    it('reports an unresolvable numeric id as not found rather than excluded', () => {
        const resolution = resolveLibrariesFilter([9999]);
        expect(resolution).toEqual({ libraryIds: [], unresolved: ['9999'], excluded: [] });
    });

    it('treats a partially resolvable filter as usable and raises no error', () => {
        const resolution = resolveLibrariesFilter(['u', 'g999999']);
        expect(resolution.libraryIds).toEqual([1]);
        expect(resolution.unresolved).toEqual(['g999999']);
        expect(librariesFilterError(resolution)).toBeNull();
    });

    it('counts a name matching both a searchable and an excluded library as resolved', () => {
        // "group" matches Group Alpha (searchable) and Excluded Group (not).
        const resolution = resolveLibrariesFilter(['group']);
        expect(resolution.libraryIds).toEqual([100]);
        expect(resolution.excluded).toEqual([]);
        expect(librariesFilterError(resolution)).toBeNull();
    });

    it('falls back to name matching for a non-strict numeric string instead of reading it as an id', () => {
        const resolution = resolveLibrariesFilter(['100abc']);
        expect(resolution).toEqual({ libraryIds: [], unresolved: ['100abc'], excluded: [] });
    });

    it('raises no error for an empty filter, so callers keep their own no-filter path', () => {
        expect(librariesFilterError(resolveLibrariesFilter([]))).toBeNull();
    });
});

describe('librariesFilterError while the library-access snapshot is loading', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        previousZotero = (globalThis as any).Zotero;
        installZoteroMock();
        // Fail-closed loading state: no searchable libraries known yet.
        setLibraryAccess([], false);
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('does not claim a valid library reference is excluded', () => {
        const resolution = resolveLibrariesFilter(['u']);
        // Fail-closed: the search still covers nothing.
        expect(resolution.libraryIds).toEqual([]);
        // ...but the reason must not be reported, since it is not yet known.
        expect(librariesFilterError(resolution)).toBeNull();
    });

    it('does not claim a valid library name is unknown', () => {
        expect(librariesFilterError(resolveLibrariesFilter(['My Library']))).toBeNull();
    });

    it('reports normally once the snapshot has loaded', () => {
        setLibraryAccess([1, 100], true);
        expect(librariesFilterError(resolveLibrariesFilter(['g777']))?.error_code)
            .toBe('library_not_searchable');
    });
});

describe('resolveLibrariesFilter name matching and the exclusion boundary', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        setSearchableLibraryIds([1, 100]);
        previousZotero = (globalThis as any).Zotero;
        installZoteroMock();
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('never resolves a name to an excluded library, so its name cannot leak', () => {
        // "Excluded Group" is a local library, but only reachable by name here.
        const resolution = resolveLibrariesFilter(['Excluded']);
        expect(resolution.libraryIds).toEqual([]);
        expect(resolution.excluded).toEqual([]);
        expect(resolution.unresolved).toEqual(['Excluded']);

        const error = librariesFilterError(resolution);
        expect(error?.error_code).toBe('library_not_found');
        expect(error?.message).not.toContain('Excluded Group');
    });

    it('still reports an excluded library named by an explicit ref or id', () => {
        // An explicit reference is precise enough to answer honestly, matching
        // validateLibraryAccess.
        for (const entry of ['g777', 300, '300'] as Array<string | number>) {
            const error = librariesFilterError(resolveLibrariesFilter([entry]));
            expect(error?.error_code).toBe('library_not_searchable');
        }
    });
});
