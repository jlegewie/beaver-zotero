import { describe, expect, it, vi, beforeEach } from 'vitest';

// =============================================================================
// Module mocks
// =============================================================================

const mockLoadFullItemDataWithAllTypes = vi.fn();
const mockExtractZoteroReferences = vi.fn();

vi.mock('../../../react/atoms/externalReferences', () => ({
    checkExternalReferencesAtom: {},
}));

vi.mock('@beaver/agent-core/citations/externalReferences', () => ({
    addExternalReferencesToMappingAtom: {},
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: (...args: unknown[]) => mockLoadFullItemDataWithAllTypes(...args),
}));

vi.mock('@beaver/agent-core/run-state/toolResultTypes', () => ({
    extractZoteroReferences: (...args: unknown[]) => mockExtractZoteroReferences(...args),
    isExternalSearchResult: vi.fn(() => false),
    isLookupWorkResult: vi.fn(() => false),
    extractExternalSearchData: vi.fn(),
    extractLookupWorkData: vi.fn(),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

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

    it('skips a non-success return, whose content is a message rather than results', async () => {
        const failed = { ...makePart(), outcome: 'failed', content: 'Reading files is not available.' };

        await expect(processToolReturnResults(failed, vi.fn() as any)).resolves.toBeUndefined();

        expect(mockExtractZoteroReferences).not.toHaveBeenCalled();
        expect(mockLoadFullItemDataWithAllTypes).not.toHaveBeenCalled();
    });

    // Parts from a pre-outcome backend must keep taking the original path.
    it('still processes a part with no outcome field', async () => {
        mockExtractZoteroReferences.mockReturnValue([{ library_id: 1, zotero_key: 'GOODKEY1' }]);
        const legacy = makePart();
        expect('outcome' in legacy).toBe(false);

        await processToolReturnResults(legacy, vi.fn() as any);

        expect(mockExtractZoteroReferences).toHaveBeenCalled();
        expect(mockLoadFullItemDataWithAllTypes).toHaveBeenCalledWith([foundItem]);
    });
});
