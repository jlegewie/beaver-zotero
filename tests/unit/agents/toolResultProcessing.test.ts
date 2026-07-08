import { describe, expect, it, vi, beforeEach } from 'vitest';

// =============================================================================
// Module mocks
// =============================================================================

const mockLoadFullItemDataWithAllTypes = vi.fn();
const mockExtractZoteroReferences = vi.fn();

vi.mock('../../../react/atoms/externalReferences', () => ({
    addExternalReferencesToMappingAtom: {},
    checkExternalReferencesAtom: {},
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: (...args: unknown[]) => mockLoadFullItemDataWithAllTypes(...args),
}));

vi.mock('../../../react/agents/toolResultTypes', () => ({
    extractZoteroReferences: (...args: unknown[]) => mockExtractZoteroReferences(...args),
    isExternalSearchResult: vi.fn(() => false),
    isLookupWorkResult: vi.fn(() => false),
    extractExternalSearchData: vi.fn(),
    extractLookupWorkData: vi.fn(),
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

import { processToolReturnResults } from '../../../react/agents/toolResultProcessing';

// =============================================================================
// Setup
// =============================================================================

const foundItem = { id: 42, key: 'GOODKEY1', libraryID: 1 };

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        Libraries: { userLibraryID: 1 },
        Groups: {
            // No groups on this device: portable group refs are unresolvable.
            getLibraryIDFromGroupID: vi.fn(() => false),
            getGroupIDFromLibraryID: vi.fn(() => {
                throw new Error('Group not found');
            }),
        },
        Items: {
            getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) => {
                // Mirrors Zotero's getIDFromLibraryAndKey: a falsy library id
                // throws rather than returning false.
                if (!libraryID) throw new Error('Library ID not provided');
                return libraryID === 1 && key === 'GOODKEY1' ? foundItem : false;
            }),
        },
    };
});

function makePart(): any {
    return { part_kind: 'tool-return', tool_name: 'zotero_search', content: {}, metadata: {} };
}

// =============================================================================
// Tests
// =============================================================================

describe('processToolReturnResults — eager item loading', () => {
    it('loads resolvable refs and skips an unresolvable portable group ref without rejecting', async () => {
        mockExtractZoteroReferences.mockReturnValue([
            { library_id: 1, zotero_key: 'GOODKEY1' },
            { library_id: 0, library_ref: 'g999', zotero_key: 'GONEKEY1' },
        ]);

        await expect(processToolReturnResults(makePart(), vi.fn() as any)).resolves.toBeUndefined();

        expect(mockLoadFullItemDataWithAllTypes).toHaveBeenCalledWith([foundItem]);
        // The unresolvable ref must never reach a Zotero lookup with library 0.
        const lookupCalls = (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync.mock.calls;
        expect(lookupCalls.every(([libraryID]: [number]) => libraryID !== 0)).toBe(true);
    });

    it('treats a missing key in an available library as a simple skip', async () => {
        mockExtractZoteroReferences.mockReturnValue([
            { library_id: 1, zotero_key: 'MISSING1' },
        ]);

        await expect(processToolReturnResults(makePart(), vi.fn() as any)).resolves.toBeUndefined();

        expect(mockLoadFullItemDataWithAllTypes).toHaveBeenCalledWith([]);
    });
});
