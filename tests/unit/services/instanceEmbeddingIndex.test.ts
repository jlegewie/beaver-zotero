import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    index: vi.fn(),
    diff: vi.fn(),
    deleteEmbeddings: vi.fn(),
}));
vi.mock("../../../src/services/embeddingIndexer", () => ({
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
import { EMBEDDING_TEXT_VERSION } from "../../../src/services/documentExtraction/embeddingText";

const zoteroItems = new Map<number, any>();
const regular = (id: number, libraryID = 1) => ({
    id,
    libraryID,
    isRegularItem: () => true,
    isAttachment: () => false,
});
const attachment = (id: number, parentID: number | false, libraryID = 1) => ({
    id,
    libraryID,
    parentID,
    isRegularItem: () => false,
    isAttachment: () => true,
});

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
        mocks.index.mockResolvedValue({ indexed: 1, skipped: 0, failed: 0, unindexable: [] });
        mocks.deleteEmbeddings.mockResolvedValue(undefined);
        snapshot = {
            generation: 1,
            session: {},
            data: { profile: { has_authorized_access: true } },
            libraries: [{ library_id: 1 }, { library_id: 2 }],
        };
        owner = {
            db: {
                deleteEmbeddingsBatch: mocks.deleteEmbeddings,
                deleteAttachmentEmbeddingTextsByItemIds: vi.fn(),
                getUnitIdsBySourceAttachment: vi.fn(async () => []),
                getPendingAttachmentEmbeddingTextIds: vi.fn(async () => []),
                getEmbeddingTextIndexVersion: vi.fn(async () => EMBEDDING_TEXT_VERSION),
                setEmbeddingTextIndexVersion: vi.fn(),
                deleteEmbeddingIndexState: vi.fn(),
                clearAttachmentEmbeddingTextPending: vi.fn(),
                subscribeProcessingChanges: () => () => {},
                configureProcessingProgress: async () => {},
                getProcessingProgress: async () => ({ runId: 0, total: 0, pending: 0 }),
            },
            libraryScopeInitialized: true,
            searchableLibraryIds: [1, 2],
            hasOcrAccess: true,
            hasSearchIndexAccess: true,
            backgroundExtractor: {
                registerExecutor: vi.fn(),
                unregisterExecutor: vi.fn(),
                getLaneStatus: () => ({}),
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
        zoteroItems.clear();
        (Zotero as any).Items = {
            getAsync: vi.fn(async (ids: number[]) =>
                ids.map((id) => zoteroItems.get(id) ?? regular(id, id === 2 ? 2 : 1)),
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
    describe("derived attachment text", () => {
        const drain = async () => {
            await vi.advanceTimersByTimeAsync(4500);
        };

        it("recomputes an attachment's parent and re-checks the attachment's file", async () => {
            zoteroItems.set(20, attachment(20, 10));
            await vi.advanceTimersByTimeAsync(500);
            await observer.notify("modify", "item", [20]);
            await drain();
            expect(mocks.index).toHaveBeenCalledExactlyOnceWith(
                [10],
                expect.objectContaining({
                    skipUnchanged: true,
                    extractions: { checkFileIdentity: new Set([20]) },
                }),
            );
            expect(owner.db.clearAttachmentEmbeddingTextPending).toHaveBeenCalledWith(
                [20],
                expect.any(Number),
            );
        });

        it("treats a file download like a change to the attachment", async () => {
            zoteroItems.set(20, attachment(20, 10));
            await vi.advanceTimersByTimeAsync(500);
            await observer.notify("download", "file", [20]);
            await drain();
            expect(mocks.index).toHaveBeenCalledExactlyOnceWith([10], expect.anything());
        });

        it("finds the units of an erased attachment through the reverse link", async () => {
            owner.db.getUnitIdsBySourceAttachment.mockResolvedValue([10]);
            await vi.advanceTimersByTimeAsync(500);
            await observer.notify("delete", "item", [20], { 20: { libraryID: 1, key: "ATTACH01" } });
            await drain();
            expect(owner.db.getUnitIdsBySourceAttachment).toHaveBeenCalledWith([20]);
            expect(mocks.deleteEmbeddings).toHaveBeenCalledWith([20]);
            expect(owner.db.deleteAttachmentEmbeddingTextsByItemIds).toHaveBeenCalledWith([20]);
            expect(mocks.index).toHaveBeenCalledExactlyOnceWith([10], expect.anything());
        });

        it("ignores standalone attachments and units outside the searchable libraries", async () => {
            zoteroItems.set(20, attachment(20, false));
            owner.db.getUnitIdsBySourceAttachment.mockResolvedValue([2]);
            await vi.advanceTimersByTimeAsync(500);
            await observer.notify("modify", "item", [20]);
            owner.searchableLibraryIds = [1];
            reconcile(snapshot);
            await drain();
            expect(mocks.index).not.toHaveBeenCalled();
            expect(owner.db.clearAttachmentEmbeddingTextPending).toHaveBeenCalledWith([20], expect.any(Number));
        });

        it("removes embeddings of units that are no longer indexable", async () => {
            mocks.index.mockResolvedValue({ indexed: 0, skipped: 1, failed: 0, unindexable: [10] });
            await vi.advanceTimersByTimeAsync(500);
            await observer.notify("modify", "item", [10]);
            await drain();
            expect(mocks.deleteEmbeddings).toHaveBeenCalledExactlyOnceWith([10]);
        });

        it("keeps derived text pending when indexing could not finish", async () => {
            zoteroItems.set(20, attachment(20, 10));
            mocks.index.mockResolvedValue({ indexed: 0, skipped: 0, failed: 0, unindexable: [], incomplete: true });
            await vi.advanceTimersByTimeAsync(500);
            await observer.notify("modify", "item", [20]);
            await drain();
            expect(owner.db.clearAttachmentEmbeddingTextPending).not.toHaveBeenCalled();
        });

        it("applies newly derived text marked dirty by the instance", async () => {
            zoteroItems.set(20, attachment(20, 10));
            await vi.advanceTimersByTimeAsync(500);
            service.markEmbeddingDirty([20]);
            await drain();
            expect(mocks.index).toHaveBeenCalledExactlyOnceWith([10], expect.anything());
        });

        it("runs one full diff for a new derived-text version", async () => {
            await vi.runAllTimersAsync();
            await service.dispose();
            (Zotero as any).Libraries = { getAll: () => [{ libraryID: 1 }, { libraryID: 2 }] };
            owner.db.getEmbeddingTextIndexVersion.mockResolvedValue(null);
            service = new InstanceBackground();
            service.start(owner.account);
            await vi.advanceTimersByTimeAsync(500);
            expect(owner.db.deleteEmbeddingIndexState).toHaveBeenCalledWith(1);
            expect(owner.db.deleteEmbeddingIndexState).toHaveBeenCalledWith(2);
            expect(owner.db.setEmbeddingTextIndexVersion).toHaveBeenCalledWith(EMBEDDING_TEXT_VERSION);
        });

        it("catches up on derived text stored while no generation ran", async () => {
            await vi.runAllTimersAsync();
            await service.dispose();
            mocks.index.mockClear();
            zoteroItems.set(20, attachment(20, 10));
            owner.db.getPendingAttachmentEmbeddingTextIds.mockResolvedValue([20]);
            mocks.diff.mockResolvedValue({ needsDiff: false, reason: "unchanged" });
            service = new InstanceBackground();
            service.start(owner.account);
            await vi.advanceTimersByTimeAsync(500);
            await drain();
            expect(owner.db.getPendingAttachmentEmbeddingTextIds).toHaveBeenCalledWith([1, 2]);
            expect(mocks.index).toHaveBeenCalledWith([10], expect.anything());
        });
    });
});
