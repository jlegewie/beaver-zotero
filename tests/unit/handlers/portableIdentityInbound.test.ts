/**
 * Portable identity is sufficient on every inbound backend -> plugin request.
 *
 * The backend must never have to turn `g5183253` into "library 3 on this Mac":
 * a Zotero `libraryID` is a device-local SQLite rowid, and only the plugin can
 * resolve one. These tests pin that contract on the seams every inbound request
 * class goes through, each exercised with NO usable numeric `library_id`:
 *
 *   library scope        -> validateLibraryAccess / resolveLibrariesFilterToSearchableIds
 *   item / attachment    -> validateZoteroItemReference + preflightZoteroAttachmentRequest
 *   compound object ids  -> resolveObjectId
 *   write actions        -> hasLibraryIdentity + resolveWriteTargetLibrary
 *
 * The module under test has a wide transitive dependency surface (document
 * extraction, sync, popups, …) that none of these functions touch, so every
 * unrelated dependency is stubbed out just to make it importable in isolation.
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
    preflightZoteroAttachmentRequest,
    resolveLibrariesFilterToSearchableIds,
    validateLibraryAccess,
} from '../../../src/services/agentDataProvider/utils';
// The real validator, not the barrel stub above: the attachment handlers pass
// it into the preflight explicitly, so the portable-only path must be the real one.
import { validateZoteroItemReference } from '../../../src/services/documentExtraction/referenceValidation';
import {
    hasLibraryIdentity,
    resolveObjectId,
    resolveWriteTargetLibrary,
} from '../../../src/utils/libraryIdentity';

// Group 555 is on this device (local rowid 100), group 777 is on it but
// excluded from Beaver (rowid 300), and group 999999 is not here at all —
// exactly the case a backend snapshot cannot distinguish.
const userLibrary = { libraryID: 1, name: 'My Library' };
const groupAlpha = { libraryID: 100, name: 'Group Alpha' };
const groupExcluded = { libraryID: 300, name: 'Excluded Group' };
const allLibraries = [userLibrary, groupAlpha, groupExcluded];

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
        Utilities: {
            isValidObjectKey: vi.fn((key: string) =>
                /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key)),
        },
        Items: { getByLibraryAndKeyAsync: vi.fn() },
    };
}

let previousZotero: any;

beforeEach(() => {
    vi.clearAllMocks();
    previousZotero = (globalThis as any).Zotero;
    installZoteroMock();
    vi.mocked(store.get).mockImplementation((atom: any) => {
        if (atom === isLibraryAccessReadyAtom) return true;
        if (atom === searchableLibraryIdsAtom) return [1, 100];
        return undefined;
    });
});

afterEach(() => {
    (globalThis as any).Zotero = previousZotero;
});

describe('library-scope requests accept a portable token alone', () => {
    it('scopes zotero_search / list_* / find_annotations by "g<groupID>"', () => {
        const validation = validateLibraryAccess('g555');
        expect(validation.valid).toBe(true);
        expect(validation.library).toEqual(groupAlpha);
    });

    it('scopes them by "u" without knowing the personal library rowid', () => {
        expect(validateLibraryAccess('u').library).toEqual(userLibrary);
    });

    it('reports a group that is not on this device as unavailable, never as the default library', () => {
        const validation = validateLibraryAccess('g999999');
        expect(validation.valid).toBe(false);
        expect(validation.error_code).toBe('library_unavailable');
        expect(validation.library).toBeUndefined();
    });

    it('still enforces exclusion on a portable token', () => {
        expect(validateLibraryAccess('g777').error_code).toBe('library_not_searchable');
    });

    it('resolves a libraries_filter of portable tokens only', () => {
        expect(resolveLibrariesFilterToSearchableIds(['u', 'g555'])).toEqual([1, 100]);
        expect(resolveLibrariesFilterToSearchableIds(['g999999'])).toEqual([]);
    });
});

describe('item / attachment targets accept a portable reference alone', () => {
    it('validates a reference whose numeric library_id is the unresolved sentinel', () => {
        expect(validateZoteroItemReference({
            library_id: 0,
            library_ref: 'g555',
            zotero_key: '3RRUYX5J',
        })).toBeNull();
    });

    it('validates a reference that carries no numeric library_id at all', () => {
        expect(validateZoteroItemReference({
            library_ref: 'g555',
            zotero_key: '3RRUYX5J',
        })).toBeNull();
    });

    it('routes a portable-only attachment request to the local library', () => {
        const result = preflightZoteroAttachmentRequest(
            { library_ref: 'g555', zotero_key: '3RRUYX5J' } as any,
            validateZoteroItemReference,
        );

        expect(result).toEqual({
            ok: true,
            responseAttachment: { library_id: 0, library_ref: 'g555', zotero_key: '3RRUYX5J' },
            requestKey: 'g555-3RRUYX5J',
            resolvedLibraryId: 100,
        });
    });

    it('lets library_ref win over a numeric library_id that disagrees', () => {
        const result = preflightZoteroAttachmentRequest(
            { library_id: 300, library_ref: 'g555', zotero_key: '3RRUYX5J' },
            validateZoteroItemReference,
        );
        expect(result.ok && result.resolvedLibraryId).toBe(100);
    });

    it('fails a group that is not on this device as library_unavailable, before any item lookup', () => {
        const result = preflightZoteroAttachmentRequest(
            { library_ref: 'g999999', zotero_key: '3RRUYX5J' } as any,
            validateZoteroItemReference,
        );
        expect(result).toMatchObject({ ok: false, errorCode: 'library_unavailable' });
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('rejects a reference that names no library at all', () => {
        expect(validateZoteroItemReference({ zotero_key: '3RRUYX5J' }))
            .toContain('Invalid library reference');
    });
});

describe('compound object ids parse the portable grammar first', () => {
    it('resolves "g<groupID>-KEY" to the local library', () => {
        expect(resolveObjectId('g555-3RRUYX5J')).toEqual({
            library_id: 100,
            library_ref: 'g555',
            zotero_key: '3RRUYX5J',
        });
    });

    it('resolves "u-KEY" to the personal library', () => {
        expect(resolveObjectId('u-3RRUYX5J')).toEqual({
            library_id: 1,
            library_ref: 'u',
            zotero_key: '3RRUYX5J',
        });
    });

    it('keeps the portable ref and flags the library as unresolved for a group that is not here', () => {
        expect(resolveObjectId('g999999-3RRUYX5J')).toEqual({
            library_id: 0,
            library_ref: 'g999999',
            zotero_key: '3RRUYX5J',
        });
    });

    it('still parses the legacy numeric grammar for old thread replay', () => {
        expect(resolveObjectId('100-3RRUYX5J')).toEqual({
            library_id: 100,
            library_ref: 'g555',
            zotero_key: '3RRUYX5J',
        });
    });
});

describe('write targets accept a portable library_ref alone', () => {
    it('treats a library_ref with no numeric id as a complete target', () => {
        expect(hasLibraryIdentity({ library_ref: 'g555' })).toBe(true);
        expect(hasLibraryIdentity({ library_ref: 'u', library_id: 0 })).toBe(true);
        expect(resolveWriteTargetLibrary({ library_ref: 'g555' })).toEqual({ ok: true, libraryID: 100 });
    });

    it('rejects a reference that names no library at all', () => {
        expect(hasLibraryIdentity({})).toBe(false);
        expect(hasLibraryIdentity({ library_id: 0 })).toBe(false);
        expect(hasLibraryIdentity({ library_ref: 'not-a-library' })).toBe(false);
    });

    it('fails closed on a group that is not on this device instead of writing to the personal library', () => {
        expect(resolveWriteTargetLibrary({ library_ref: 'g999999' })).toMatchObject({
            ok: false,
            code: 'library_unavailable',
        });
    });

    it('lets library_ref win over a numeric library_id that disagrees', () => {
        expect(resolveWriteTargetLibrary({ library_ref: 'u', library_id: 300 }))
            .toEqual({ ok: true, libraryID: 1 });
    });
});
