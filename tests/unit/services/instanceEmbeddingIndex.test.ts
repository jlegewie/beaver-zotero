import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    index: vi.fn(),
    diff: vi.fn(),
    deleteEmbeddings: vi.fn(),
}));
vi.mock("../../../src/services/embeddingIndexer", () => ({
    MIN_CONTENT_LENGTH: 10,
    INDEX_BATCH_SIZE: 100,
    mergeIndexingErrors: vi.fn(),
    EmbeddingIndexer: class {
        cleanupUnsyncedLibraries = async () => ({ librariesRemoved: 0 });
        shouldRunFullDiff = mocks.diff;
        getItemsReadyForRetry = async () => [];
        getFailedStats = async () => ({ permanentlyFailed: 0 });
        indexItemIdsBatch = mocks.index;
    },
}));
vi.mock("../../../src/utils/prefs", () => ({
    getPref: () => false,
    setPref: vi.fn(),
}));
vi.mock("../../../src/services/backgroundQueue/ocrExecutor", () => ({
    OcrExecutor: class {
        jobType = "document_ocr";
    },
}));
vi.mock(
    "../../../src/services/backgroundProcessing/fulltextUpsertLane",
    () => ({
        startFulltextUpsertLane: () => () => {},
    }),
);
vi.mock(
    "../../../src/services/backgroundProcessing/backgroundProcessingScopeCleanup",
    () => ({
        startBackgroundProcessingScopeCleanup: () => () => {},
    }),
);
import { InstanceBackground } from "../../../src/services/instanceBackground";

describe("instance embedding events across background generations", () => {
    let service: InstanceBackground;
    let owner: any;
    let snapshot: any;
    let reconcile: (snapshot: any) => void;
    let observer: {
        notify: (
            event: string,
            type: string,
            ids: number[],
            data?: any,
        ) => Promise<void>;
    };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        // The fast scan cannot detect a second edit within the same timestamp second.
        mocks.diff.mockResolvedValue({ needsDiff: false, reason: "unchanged" });
        mocks.index.mockResolvedValue({ indexed: 1, skipped: 0, failed: 0 });
        mocks.deleteEmbeddings.mockResolvedValue(undefined);
        snapshot = {
            generation: 1,
            session: {},
            data: { profile: { has_authorized_access: true } },
            libraries: [{ library_id: 1 }, { library_id: 2 }],
        };
        owner = {
            db: { deleteEmbeddingsBatch: mocks.deleteEmbeddings },
            libraryScopeInitialized: true,
            searchableLibraryIds: [1, 2],
            hasOcrAccess: true,
            hasSearchIndexAccess: true,
            backgroundExtractor: {
                registerExecutor: vi.fn(),
                unregisterExecutor: vi.fn(),
            },
            account: {
                subscribe: (fn: typeof reconcile) => {
                    reconcile = fn;
                    fn(snapshot);
                    return () => {};
                },
                getSnapshot: () => snapshot,
            },
        };
        (Zotero as any).Beaver = owner;
        (Zotero as any).Items = {
            getAsync: vi.fn(async (ids: number[]) =>
                ids.map((id) => ({ id, libraryID: id === 2 ? 2 : 1 })),
            ),
        };
        (Zotero as any).Notifier = {
            registerObserver: vi.fn((value) => {
                observer = value;
                return "embedding";
            }),
            unregisterObserver: vi.fn(),
        };
        service = new InstanceBackground();
        service.start(owner.account);
    });
    afterEach(async () => {
        await vi.runAllTimersAsync();
        await service.dispose();
        vi.useRealTimers();
        delete (Zotero as any).Beaver;
    });

    it("retains debounced modifications and deletions when entitlements change", async () => {
        await vi.advanceTimersByTimeAsync(500);
        await observer.notify("modify", "item", [1]);
        await observer.notify("delete", "item", [3], { 3: { libraryID: 1 } });
        await vi.advanceTimersByTimeAsync(1000);
        owner.hasOcrAccess = false;
        reconcile(snapshot);
        await vi.advanceTimersByTimeAsync(4500);
        expect(mocks.diff).toHaveBeenCalledTimes(4);
        expect(mocks.index).toHaveBeenCalledExactlyOnceWith(
            [1],
            expect.objectContaining({ skipUnchanged: true }),
        );
        expect(mocks.deleteEmbeddings).toHaveBeenCalledExactlyOnceWith([3]);
    });

    it("filters retained modifications against the new searchable libraries", async () => {
        await vi.advanceTimersByTimeAsync(500);
        await observer.notify("modify", "item", [1, 2]);
        owner.searchableLibraryIds = [1];
        reconcile(snapshot);
        await vi.advanceTimersByTimeAsync(4500);
        expect(mocks.index).toHaveBeenCalledExactlyOnceWith(
            [1],
            expect.anything(),
        );
    });

    it("retains pending changes while access is unavailable and coalesces later deletion", async () => {
        await vi.advanceTimersByTimeAsync(500);
        await observer.notify("modify", "item", [1, 3]);
        reconcile({ ...snapshot, session: null });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mocks.index).not.toHaveBeenCalled();
        reconcile(snapshot);
        await observer.notify("delete", "item", [3], { 3: { libraryID: 1 } });
        await vi.advanceTimersByTimeAsync(4500);
        expect(mocks.index).toHaveBeenCalledExactlyOnceWith(
            [1],
            expect.anything(),
        );
        expect(mocks.deleteEmbeddings).toHaveBeenCalledExactlyOnceWith([3]);
    });
});
