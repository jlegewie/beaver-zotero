import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    fulltext: vi.fn(),
    cleanup: vi.fn(),
    embedding: vi.fn(),
    stop: vi.fn(),
    collect: vi.fn(),
}));
vi.mock("../../../src/services/backgroundQueue/ocrExecutor", () => ({
    OcrExecutor: class {
        jobType = "document_ocr";
    },
}));
vi.mock(
    "../../../src/services/backgroundProcessing/fulltextUpsertLane",
    () => ({ startFulltextUpsertLane: mocks.fulltext }),
);
vi.mock(
    "../../../src/services/backgroundProcessing/backgroundProcessingScopeCleanup",
    () => ({ startBackgroundProcessingScopeCleanup: mocks.cleanup }),
);
vi.mock("../../../src/services/instanceEmbeddingIndex", () => ({
    initialEmbeddingState: {
        status: "idle",
        phase: "initial",
        progress: 0,
        totalItems: 0,
        indexedItems: 0,
        failedItems: 0,
    },
    startEmbeddingIndex: mocks.embedding,
}));
vi.mock("../../../src/services/backgroundProcessing/statusSnapshot", () => ({
    collectProcessingStatus: mocks.collect,
}));
import { InstanceBackground } from "../../../src/services/instanceBackground";

describe("InstanceBackground", () => {
    let notify: (snapshot: any) => void;
    let snapshot: any;
    let owner: any;
    beforeEach(() => {
        vi.clearAllMocks();
        for (const start of [mocks.fulltext, mocks.cleanup, mocks.embedding])
            start.mockReturnValue(mocks.stop);
        snapshot = {
            generation: 1,
            session: {},
            data: { profile: { has_authorized_access: true } },
            libraries: [{ library_id: 1 }],
        };
        owner = {
            libraryScopeInitialized: true,
            searchableLibraryIds: [1],
            hasOcrAccess: true,
            hasSearchIndexAccess: true,
            backgroundExtractor: {
                registerExecutor: vi.fn(),
                unregisterExecutor: vi.fn(),
            },
            account: {
                subscribe: vi.fn((fn) => {
                    notify = fn;
                    fn(snapshot);
                    return vi.fn();
                }),
                getSnapshot: () => snapshot,
                getGeneration: () => snapshot.generation,
            },
        };
        (Zotero as any).Beaver = owner;
    });
    it("starts one set of lanes regardless of renderer count and same-account refresh", async () => {
        const service = new InstanceBackground();
        service.start(owner.account);
        service.start(owner.account);
        notify({ ...snapshot, revision: 2 });
        expect(owner.account.subscribe).toHaveBeenCalledTimes(1);
        expect(
            owner.backgroundExtractor.registerExecutor,
        ).toHaveBeenCalledTimes(1);
        expect(mocks.embedding).toHaveBeenCalledTimes(1);
        expect(mocks.stop).not.toHaveBeenCalled();
        await service.dispose();
        expect(mocks.stop).toHaveBeenCalledTimes(3);
    });
    it("revokes every lane synchronously when account access disappears", async () => {
        const service = new InstanceBackground();
        service.start(owner.account);
        owner.libraryScopeInitialized = false;
        owner.searchableLibraryIds = [];
        notify({ ...snapshot, generation: 2, session: null, data: null });
        expect(mocks.stop).toHaveBeenCalledTimes(3);
        expect(
            owner.backgroundExtractor.unregisterExecutor,
        ).toHaveBeenCalledTimes(1);
        expect(mocks.embedding).toHaveBeenCalledTimes(1);
        await service.dispose();
    });
    it("reconciles changed scope once and sends manual rebuild to the instance executor", async () => {
        const service = new InstanceBackground();
        service.start(owner.account);
        owner.searchableLibraryIds = [];
        notify(snapshot);
        expect(mocks.embedding).toHaveBeenLastCalledWith(
            [],
            false,
            expect.any(Function),
            expect.any(Function),
            expect.objectContaining({
                modifiedItemIds: expect.any(Set),
                deletedItemIds: expect.any(Set),
            }),
        );
        const lanesStarted = mocks.fulltext.mock.calls.length;
        const stopped = mocks.stop.mock.calls.length;
        service.reindex();
        expect(mocks.fulltext).toHaveBeenCalledTimes(lanesStarted);
        expect(mocks.cleanup).toHaveBeenCalledTimes(lanesStarted);
        expect(
            owner.backgroundExtractor.registerExecutor,
        ).toHaveBeenCalledTimes(lanesStarted);
        expect(mocks.stop).toHaveBeenCalledTimes(stopped + 1);
        expect(mocks.embedding).toHaveBeenLastCalledWith(
            [],
            true,
            expect.any(Function),
            expect.any(Function),
            expect.objectContaining({
                modifiedItemIds: expect.any(Set),
                deletedItemIds: expect.any(Set),
            }),
        );
        await service.dispose();
    });
    it("holds an early rebuild until authorized scope is available, then consumes it once", async () => {
        const service = new InstanceBackground();
        owner.libraryScopeInitialized = false;
        service.reindex();
        service.reindex();
        service.start(owner.account);
        expect(mocks.embedding).not.toHaveBeenCalled();
        owner.libraryScopeInitialized = true;
        notify({ ...snapshot, session: null });
        expect(mocks.embedding).not.toHaveBeenCalled();
        notify(snapshot);
        expect(mocks.embedding).toHaveBeenCalledTimes(1);
        expect(mocks.embedding.mock.calls[0][1]).toBe(true);
        owner.hasOcrAccess = false;
        notify(snapshot);
        expect(mocks.embedding.mock.calls[1][1]).toBe(false);
        await service.dispose();
    });

    it("allows only one renderer to claim each notification", () => {
        const service = new InstanceBackground();
        expect(service.claimNotification("welcome")).toBe(true);
        expect(service.claimNotification("welcome")).toBe(false);
        expect(service.claimNotification("reader")).toBe(true);
    });
    it("silently discards successful and failed status reads from an old account", async () => {
        const service = new InstanceBackground();
        for (const reject of [false, true]) {
            let finish!: () => void;
            mocks.collect.mockImplementationOnce(
                () =>
                    new Promise((resolve, fail) => {
                        finish = () =>
                            reject
                                ? fail(new Error("old request failed"))
                                : resolve({ queue: {} });
                    }),
            );
            const pending = service.collectStatus();
            expect(service.collectStatus()).toBe(pending);
            snapshot.generation++;
            finish();
            await expect(pending).resolves.toBeNull();
        }
    });
    it("keeps notification cooldowns shared across renderers", () => {
        const service = new InstanceBackground();
        const now = vi.spyOn(Date, "now").mockReturnValue(1000);
        try {
            expect(service.claimNotification("worker", 600_000)).toBe(true);
            expect(service.claimNotification("worker", 600_000)).toBe(false);
            now.mockReturnValue(601_000);
            expect(service.claimNotification("worker", 600_000)).toBe(true);
        } finally {
            now.mockRestore();
        }
    });
});
