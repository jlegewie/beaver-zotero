import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    atoms: {
        libraryView: Symbol("libraryView"),
        selectedItems: Symbol("selectedItems"),
        selectedTags: Symbol("selectedTags"),
        readerItem: Symbol("readerItem"),
        isLibraryTab: Symbol("isLibraryTab"),
        searchableLibraryIds: Symbol("searchableLibraryIds"),
    },
    values: new Map<symbol, unknown>(),
    post: vi.fn(),
    toSignalItem: vi.fn(),
    getActiveItems: vi.fn(),
    getTopCollections: vi.fn(),
    getAllCollections: vi.fn(),
    getRecentItems: vi.fn(),
    getLibraryShape: vi.fn(),
}));

vi.mock("../../../src/services/apiService", () => ({
    ApiService: class {
        post = mocks.post;
        constructor(_baseUrl: string) {}
    },
}));
vi.mock("../../../src/utils/getAPIBaseURL", () => ({ default: "http://test" }));
vi.mock("../../../src/utils/logger", () => ({ logger: vi.fn() }));
vi.mock("../../../src/utils/agentItemSupport", () => ({
    isAgentSupportedItem: vi.fn(() => true),
}));
vi.mock("../../../src/utils/librarySignals", () => ({
    toSignalItem: mocks.toSignalItem,
    getActiveItems: mocks.getActiveItems,
    getTopCollections: mocks.getTopCollections,
    getAllCollections: mocks.getAllCollections,
    getRecentItems: mocks.getRecentItems,
    getLibraryShape: mocks.getLibraryShape,
}));
vi.mock("../../../react/store", () => ({
    store: { get: (atom: symbol) => mocks.values.get(atom) },
}));
vi.mock("../../../react/atoms/zoteroContext", () => ({
    libraryViewAtom: mocks.atoms.libraryView,
    selectedZoteroItemsAtom: mocks.atoms.selectedItems,
    selectedTagsAtom: mocks.atoms.selectedTags,
}));
vi.mock("../../../react/atoms/messageComposition", () => ({
    currentReaderAttachmentAtom: mocks.atoms.readerItem,
}));
vi.mock("../../../react/atoms/ui", () => ({
    isLibraryTabAtom: mocks.atoms.isLibraryTab,
}));
vi.mock("../../../react/atoms/profile", () => ({
    searchableLibraryIdsAtom: mocks.atoms.searchableLibraryIds,
}));

import { LibrarySuggestionsService } from "../../../src/services/librarySuggestionsService";

const excludedItem = {
    libraryID: 1,
    isRegularItem: vi.fn(() => true),
};

describe("LibrarySuggestionsService library exclusions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.values.clear();
        mocks.values.set(mocks.atoms.libraryView, {
            libraryId: 1,
            treeRowType: "collection",
            collectionId: 99,
        });
        mocks.values.set(mocks.atoms.selectedItems, [excludedItem]);
        mocks.values.set(mocks.atoms.selectedTags, ["private-tag"]);
        mocks.values.set(mocks.atoms.readerItem, null);
        mocks.values.set(mocks.atoms.isLibraryTab, true);
        mocks.values.set(mocks.atoms.searchableLibraryIds, [2]);

        mocks.getActiveItems.mockResolvedValue([]);
        mocks.getTopCollections.mockResolvedValue([]);
        mocks.getAllCollections.mockResolvedValue([]);
        mocks.getRecentItems.mockResolvedValue([]);
        mocks.getLibraryShape.mockResolvedValue({
            total_tag_count: 0,
            unfiled_item_count: 0,
            library_size: 0,
        });

        Object.assign(Zotero, {
            Beaver: { pluginVersion: "test" },
            Libraries: { userLibraryID: 1 },
            Collections: { get: vi.fn() },
            Items: {
                getAsync: vi.fn(),
                loadDataTypes: vi.fn(),
            },
        });
    });

    it("rejects an explicitly requested excluded library before reading or posting", async () => {
        const service = new LibrarySuggestionsService("http://test");

        await expect(service.getSuggestions({ libraryId: 1 }))
            .rejects.toThrow("excluded from Beaver");

        expect(Zotero.Collections.get).not.toHaveBeenCalled();
        expect(Zotero.Items.loadDataTypes).not.toHaveBeenCalled();
        expect(mocks.getActiveItems).not.toHaveBeenCalled();
        expect(mocks.post).not.toHaveBeenCalled();
    });

    it("falls back from an excluded current library to a searchable library", async () => {
        const service = new LibrarySuggestionsService("http://test");

        const payload = await service.buildPayload();

        expect(mocks.getActiveItems).toHaveBeenCalledWith(2);
        expect(mocks.getTopCollections).toHaveBeenCalledWith(2, null);
        expect(mocks.getAllCollections).toHaveBeenCalledWith(2);
        expect(mocks.getRecentItems).toHaveBeenCalledWith(2);
        expect(mocks.getLibraryShape).toHaveBeenCalledWith(2);
        expect(Zotero.Collections.get).not.toHaveBeenCalled();
        expect(Zotero.Items.loadDataTypes).not.toHaveBeenCalled();
        expect(payload.selected_item).toBeNull();
        expect(payload.ui_view_type).toBeNull();
        expect(payload.ui_filter_tags).toEqual([]);
    });

    it("fails closed when every local library is excluded", async () => {
        mocks.values.set(mocks.atoms.searchableLibraryIds, []);
        const service = new LibrarySuggestionsService("http://test");

        await expect(service.buildPayload())
            .rejects.toThrow("No searchable Zotero libraries");

        expect(Zotero.Collections.get).not.toHaveBeenCalled();
        expect(mocks.getActiveItems).not.toHaveBeenCalled();
    });

    it("does not post when the target library is excluded during assembly", async () => {
        mocks.values.set(mocks.atoms.libraryView, {
            libraryId: 2,
            treeRowType: "library",
            collectionId: null,
        });
        mocks.getLibraryShape.mockImplementation(async () => {
            mocks.values.set(mocks.atoms.searchableLibraryIds, []);
            return {
                total_tag_count: 0,
                unfiled_item_count: 0,
                library_size: 0,
            };
        });
        const service = new LibrarySuggestionsService("http://test");

        await expect(service.getSuggestions())
            .rejects.toThrow("was excluded from Beaver");

        expect(mocks.post).not.toHaveBeenCalled();
    });
});
