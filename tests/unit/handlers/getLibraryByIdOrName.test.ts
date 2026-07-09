/**
 * Focused unit tests for getLibraryByIdOrName, validateLibraryAccess, and
 * resolveLibrariesFilterToSearchableIds (src/services/agentDataProvider/utils.ts).
 *
 * The module has a wide transitive dependency surface (document extraction,
 * sync, popups, etc.) that these functions never touch, so every unrelated
 * dependency is stubbed out just to make the module importable in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
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

import { store } from '../../../react/store';
import {
    getLibraryByIdOrName,
    validateLibraryAccess,
    resolveLibrariesFilterToSearchableIds,
} from '../../../src/services/agentDataProvider/utils';

// A group library reachable from this device (group id 555 -> local library 100)
// and a resolvable-but-excluded group library (group id 777 -> local library 300,
// deliberately left out of the searchable set below).
const userLibrary = { libraryID: 1, name: 'My Library' };
const groupAlpha = { libraryID: 100, name: 'Group Alpha' };
const groupExcluded = { libraryID: 300, name: 'Excluded Group' };
const allLibraries = [userLibrary, groupAlpha, groupExcluded];

function setSearchableLibraryIds(ids: number[]) {
    vi.mocked(store.get).mockReturnValue(ids);
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
        setSearchableLibraryIds([1, 100]);
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
        setSearchableLibraryIds([1, 100]);
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
});
