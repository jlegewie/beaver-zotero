/**
 * Focused unit tests for getCollectionByIdOrName (src/services/agentDataProvider/utils.ts).
 *
 * The module has a wide transitive dependency surface (document extraction,
 * sync, popups, etc.) that getCollectionByIdOrName itself never touches, so
 * every unrelated dependency is stubbed out just to make the module
 * importable in isolation.
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
    store: { get: vi.fn(() => [1, 100]) },
}));
vi.mock('../../../react/agents/atoms', () => ({
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

import { getCollectionByIdOrName } from '../../../src/services/agentDataProvider/utils';

const personalCollection = { id: 10, key: 'ABCD1234', libraryID: 1, name: 'Personal Coll' };
const groupCollection = { id: 20, key: 'GRPC0001', libraryID: 100, name: 'Group Coll' };

describe('getCollectionByIdOrName', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        previousZotero = (globalThis as any).Zotero;
        (globalThis as any).Zotero = {
            Libraries: {
                getAll: vi.fn(() => [{ libraryID: 1 }, { libraryID: 100 }]),
                userLibraryID: 1,
            },
            Groups: {
                getGroupIDFromLibraryID: vi.fn((libId: number) => (libId === 100 ? 12345 : false)),
                getLibraryIDFromGroupID: vi.fn((groupId: number) => (groupId === 12345 ? 100 : false)),
            },
            Collections: {
                get: vi.fn(),
                getByLibraryAndKey: vi.fn((libraryID: number, key: string) => {
                    if (libraryID === 1 && key === personalCollection.key) return personalCollection;
                    if (libraryID === 100 && key === groupCollection.key) return groupCollection;
                    return false;
                }),
                getByLibrary: vi.fn(() => []),
            },
            Utilities: {
                isValidObjectKey: vi.fn((key: string) => /^[A-Z0-9]{8}$/.test(key)),
            },
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('resolves a bare key without a library hint', () => {
        const result = getCollectionByIdOrName(personalCollection.key);
        expect(result).toEqual({ collection: personalCollection, libraryID: 1 });
    });

    it('resolves a legacy numeric compound "<libraryID>-<key>" id', () => {
        const result = getCollectionByIdOrName(`1-${personalCollection.key}`);
        expect(result).toEqual({ collection: personalCollection, libraryID: 1 });
    });

    it('resolves a portable "u-<key>" compound id to the personal library', () => {
        const result = getCollectionByIdOrName(`u-${personalCollection.key}`);
        expect(result).toEqual({ collection: personalCollection, libraryID: 1 });
    });

    it('resolves a portable "g<id>-<key>" compound id to the mapped group library', () => {
        const result = getCollectionByIdOrName(`g12345-${groupCollection.key}`);
        expect(result).toEqual({ collection: groupCollection, libraryID: 100 });
    });

    it('falls through to a not-found result for an unresolvable portable group ref', () => {
        // Group 99999 isn't registered locally, so resolveLibraryRef returns
        // null and the compound branch can't do a getByLibraryAndKey lookup.
        // isValidObjectKey still passes, so this only fails the compound path,
        // and the bare-key fallback below also can't find a match.
        const result = getCollectionByIdOrName(`g99999-${groupCollection.key}`);
        expect(result).toBeNull();
    });

    it('preserves fallback semantics: a hyphenated name that is not a compound id falls through to name lookup', () => {
        const namedCollection = { id: 30, key: 'NAMEDCOL', libraryID: 1, name: 'My-Notes' };
        (globalThis as any).Zotero.Collections.getByLibrary = vi.fn((libraryID: number) => {
            return libraryID === 1 ? [namedCollection] : [];
        });
        const result = getCollectionByIdOrName('My-Notes', 1);
        expect(result).toEqual({ collection: namedCollection, libraryID: 1 });
    });

    it('returns null for null/undefined input', () => {
        expect(getCollectionByIdOrName(null)).toBeNull();
        expect(getCollectionByIdOrName(undefined)).toBeNull();
    });
});
