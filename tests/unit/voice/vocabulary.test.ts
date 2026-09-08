import { expect, it, vi } from "vitest";
import {
    collectVoiceVocabulary,
    selectVoiceTerms,
} from "../../../react/voice/vocabulary";
it("prioritizes groups and deduplicates normalized names within independent bounds", () => {
    expect(
        selectVoiceTerms(
            [
                [" Collection ", "Bourdieu"],
                ["collection", "Habitus", "x".repeat(81), "\0bad", "bad\ud800"],
            ],
            3,
            100,
            80,
        ),
    ).toEqual(["Collection", "Bourdieu", "Habitus"]);
    expect(selectVoiceTerms([["long term", "short"]], 4, 5, 80)).toEqual([
        "short",
    ]);
});
it("does not read excluded items or leak excluded collection names", async () => {
    const read = vi.fn();
    const context: any = {
        isLibraryTab: true,
        selectedItems: [{ libraryID: 2, loadDataType: read }],
        libraryView: {
            selectedCollections: [
                { libraryId: 2, collectionName: "Secret", collectionId: 3 },
            ],
        },
    };
    const result = await collectVoiceVocabulary(
        context,
        "en",
        (id) => id === 1,
    );
    expect(read).not.toHaveBeenCalled();
    expect(result.options.biasTerms).toEqual([]);
    expect(result.libraryIds).toEqual([]);
});
it("captures eligible sources and rechecks eligibility after asynchronous loading", async () => {
    let allowed = true;
    const item = {
        libraryID: 1,
        id: 5,
        loadDataType: vi.fn(async () => {
            allowed = false;
        }),
        getCreators: vi.fn(),
        getTags: vi.fn(),
        getField: vi.fn(),
    };
    const context: any = {
        isLibraryTab: true,
        selectedItems: [item],
        libraryView: { selectedCollections: [] },
    };
    await expect(
        collectVoiceVocabulary(context, "en", () => allowed),
    ).rejects.toThrow("eligibility");
    expect(item.getCreators).not.toHaveBeenCalled();
});
it("ranks collection and author names ahead of relevant tags and journals", async () => {
    const item = {
        libraryID: 1,
        id: 5,
        loadDataType: vi.fn(async () => {}),
        getCreators: () => [{ lastName: "Bourdieu" }],
        getCollections: () => [],
        getTags: () => [{ tag: "habitus" }],
        getField: (key: string) =>
            key === "title" ? "Social Fields" : "Sociology Journal",
    };
    const context: any = {
        isLibraryTab: true,
        selectedItems: [item],
        libraryView: {
            selectedCollections: [
                { libraryId: 1, collectionId: 3, collectionName: "Theory" },
            ],
        },
    };
    const result = await collectVoiceVocabulary(context, "fr", () => true);
    expect(result.options.biasTerms).toEqual(["Theory", "Bourdieu", "habitus"]);
    expect(result.options.correctionVocabulary.at(-1)).toBe(
        "Sociology Journal",
    );
    expect(result).toMatchObject({
        libraryIds: [1],
        itemIds: [5],
        collectionIds: [3],
        options: { language: "fr" },
    });
});

it("uses the reader parent collection names instead of stale library selection", async () => {
    const parent = {
        libraryID: 1,
        id: 5,
        loadDataType: vi.fn(async () => {}),
        getCollections: () => [8],
        getCreators: () => [{ lastName: "Bourdieu" }],
        getTags: () => [],
        getField: (key: string) =>
            key === "title" ? "The Study of Habitus" : "",
    };
    (Zotero as any).Items = { getAsync: vi.fn(async () => parent) };
    (Zotero as any).Collections = {
        getAsync: vi.fn(async () => ({ libraryID: 1, name: "Social Theory" })),
    };
    const context: any = {
        isLibraryTab: false,
        readerAttachment: { libraryID: 1, parentID: 5 },
        libraryView: {
            selectedCollections: [
                { libraryId: 2, collectionId: 9, collectionName: "Unrelated" },
            ],
        },
    };
    const result = await collectVoiceVocabulary(
        context,
        "en",
        (id) => id === 1,
    );
    expect(result.options.biasTerms).toEqual([
        "Social Theory",
        "Bourdieu",
        "Habitus",
    ]);
    expect(result.collectionIds).toEqual([8]);
});
