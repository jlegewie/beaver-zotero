import { installMutationInstance } from '../../helpers/mutationInstance';
/**
 * `zotero_data` requests carry portable references, not device-local rowids.
 *
 * Once the backend stops pinning a numeric `library_id`, every reference in one
 * request arrives with the same `library_id: 0` sentinel and is told apart only
 * by its `library_ref`. The lookup keys request references by that portable
 * identity, so two items with the same `zotero_key` in different libraries do
 * not collapse onto one map entry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    storeGet: vi.fn(),
}));

vi.mock('../../../react/store', () => ({ store: { get: mocks.storeGet } }));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
    syncWithZoteroAtom: Symbol('syncWithZoteroAtom'),
}));
vi.mock('../../../react/atoms/auth', () => ({ userIdAtom: Symbol('userIdAtom') }));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: vi.fn(() => null),
    computeItemStatus: vi.fn(async () => 'in_library'),
    prefetchSyncDates: vi.fn(async () => new Map()),
    getAttachmentFileStatus: vi.fn(),
    getAttachmentFileStatusLightweight: vi.fn(),
    getBestAttachmentBatch: vi.fn(async () => new Map()),
}));

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    formatZoteroCreatorsString: vi.fn(() => ''),
    getCreatorsFromItem: vi.fn(() => []),
    getYearFromItem: vi.fn(() => null),
    serializeAttachment: vi.fn(),
    serializeAnnotation: vi.fn(),
    // Enough to tell the two items apart in the response.
    serializeItem: vi.fn(async (item: any) => ({
        library_id: item.libraryID,
        zotero_key: item.key,
        title: item.title,
    })),
    serializeNote: vi.fn(),
    serializeItemStub: vi.fn(),
}));

import { lookupZoteroReferences } from '../../../src/services/agentDataProvider/lookupZoteroReferences';

// Group 555 -> local rowid 100, group 777 -> local rowid 300. Both hold an item
// under the same key, which is exactly what a per-library key space allows.
const SHARED_KEY = '3RRUYX5J';

function regularItem(libraryID: number, title: string) {
    return {
        id: libraryID,
        key: SHARED_KEY,
        libraryID,
        title,
        parentID: null,
        isAttachment: () => false,
        isNote: () => false,
        isAnnotation: () => false,
        isRegularItem: () => true,
        getAttachments: () => [],
        getNotes: () => [],
    };
}

const alphaItem = regularItem(100, 'Alpha paper');
const excludedGroupItem = regularItem(300, 'Beta paper');

beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeGet.mockImplementation(() => [1, 100, 300]);
    (globalThis as any).Zotero = {
        Libraries: {
            get: vi.fn((id: number) => ({ libraryID: id, name: `Library ${id}` })),
            getAll: vi.fn(() => []),
            userLibraryID: 1,
        },
        Groups: {
            getGroupIDFromLibraryID: vi.fn((libId: number) =>
                libId === 100 ? 555 : libId === 300 ? 777 : false),
            getLibraryIDFromGroupID: vi.fn((groupId: number) =>
                groupId === 555 ? 100 : groupId === 777 ? 300 : false),
        },
        Items: {
            getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) => {
                if (key !== SHARED_KEY) return null;
                if (libraryID === 100) return alphaItem;
                if (libraryID === 300) return excludedGroupItem;
                return null;
            }),
            loadDataTypes: vi.fn(async () => undefined),
            getAsync: vi.fn(async () => []),
        },
    };
});

beforeEach(() => {
    installMutationInstance();
    (Zotero as any).Beaver.searchableLibraryIds = [1, 100, 300];
});

describe('lookupZoteroReferences with portable-only references', () => {
    it('keeps same-key items in different libraries apart when no numeric id distinguishes them', async () => {
        const result = await lookupZoteroReferences(
            [
                { library_id: 0, library_ref: 'g555', zotero_key: SHARED_KEY },
                { library_id: 0, library_ref: 'g777', zotero_key: SHARED_KEY },
            ],
            { include_attachments: false, include_parents: false, include_notes: false, file_status_level: 'none' },
        );

        expect(result.errors).toEqual([]);
        expect(result.items.map(i => i.item.title).sort()).toEqual(['Alpha paper', 'Beta paper']);
    });

    it('keeps legacy references apart when they share a malformed library_ref', async () => {
        // Historical threads still carry numeric library ids. `resolveLibraryRef`
        // ignores a ref that does not parse and falls back to the rowid, so both
        // of these load — from *different* libraries. A key that trusted the
        // unparseable ref would collapse them and serialize one item twice.
        const result = await lookupZoteroReferences(
            [
                { library_id: 100, library_ref: '', zotero_key: SHARED_KEY } as any,
                { library_id: 300, library_ref: '', zotero_key: SHARED_KEY } as any,
            ],
            { include_attachments: false, include_parents: false, include_notes: false, file_status_level: 'none' },
        );

        expect(result.errors).toEqual([]);
        expect(result.items.map(i => i.item.title).sort()).toEqual(['Alpha paper', 'Beta paper']);
    });

    it('keeps them apart when the malformed ref is a non-empty bogus string', async () => {
        const result = await lookupZoteroReferences(
            [
                { library_id: 100, library_ref: 'not-a-ref', zotero_key: SHARED_KEY } as any,
                { library_id: 300, library_ref: 'not-a-ref', zotero_key: SHARED_KEY } as any,
            ],
            { include_attachments: false, include_parents: false, include_notes: false, file_status_level: 'none' },
        );

        expect(result.errors).toEqual([]);
        expect(result.items.map(i => i.item.title).sort()).toEqual(['Alpha paper', 'Beta paper']);
    });

    it('reports a group that is not on this device as library_unavailable', async () => {
        const result = await lookupZoteroReferences(
            [{ library_id: 0, library_ref: 'g999999', zotero_key: SHARED_KEY }],
            { include_attachments: false, include_parents: false, include_notes: false, file_status_level: 'none' },
        );

        expect(result.items).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].error_code).toBe('library_unavailable');
    });
});
