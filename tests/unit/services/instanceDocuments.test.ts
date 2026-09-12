import { beforeEach, describe, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("../../../src/beaver-extract/MuPDFWorkerClient", () => ({
    MuPDFWorkerClient: class {},
}));
vi.mock("../../../src/services/documentExtractionCore", () => ({
    documentImplementations: {
        extractAndCacheDocument: execute,
        extractAndCacheResolvedPdfDocument: execute,
        extractAndCacheEpubDocument: execute,
        extractAndCacheSnapshotDocument: execute,
    },
}));
import { InstanceDocuments } from "../../../src/services/instanceDocuments";

describe("InstanceDocuments", () => {
    let owner: any;
    let listeners: Set<() => void>;
    beforeEach(() => {
        execute.mockReset();
        listeners = new Set();
        owner = {
            libraryScopeInitialized: true,
            searchableLibraryIds: [1],
            account: {
                getGeneration: () => 1,
                subscribe: (fn: () => void) => {
                    listeners.add(fn);
                    fn();
                    return () => listeners.delete(fn);
                },
            },
        };
        (Zotero as any).Beaver = owner;
    });
    it("rejects excluded content before starting extraction", async () => {
        const service = new InstanceDocuments();
        await expect(
            service.extractAndCacheDocument({ libraryId: 2 } as any),
        ).rejects.toMatchObject({ code: "DOCUMENT_ACCESS_REVOKED" });
        expect(execute).not.toHaveBeenCalled();
    });
    it("owns deadlines and cancels the affected request on scope revocation", async () => {
        const service = new InstanceDocuments();
        let finish!: () => void;
        execute.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const request = service.extractAndCacheDocument({
            libraryId: 1,
            timeoutContext: { fromWindow: true },
        } as any);
        const args = execute.mock.calls[0][0];
        expect(args.timeoutContext).toBeUndefined();
        expect(args.externalAbortSignal.aborted).toBe(false);
        owner.searchableLibraryIds = [];
        for (const listener of listeners) listener();
        expect(args.externalAbortSignal.aborted).toBe(true);
        finish();
        await expect(request).rejects.toMatchObject({
            code: "DOCUMENT_ACCESS_REVOKED",
        });
        expect(listeners.size).toBe(0);
    });
    it("one caller cancelling does not abort another request and disposal closes admission", async () => {
        const service = new InstanceDocuments();
        const finishes: (() => void)[] = [];
        execute.mockImplementation(
            () => new Promise<void>((resolve) => finishes.push(resolve)),
        );
        const controller = new AbortController();
        const a = service.extractAndCacheDocument({
            libraryId: 1,
            externalAbortSignal: controller.signal,
        } as any);
        const b = service.extractAndCacheDocument({ libraryId: 1 } as any);
        controller.abort();
        expect(execute.mock.calls[0][0].externalAbortSignal.aborted).toBe(true);
        expect(execute.mock.calls[1][0].externalAbortSignal.aborted).toBe(
            false,
        );
        finishes.forEach((fn) => fn());
        await Promise.all([a, b]);
        service.dispose();
        await expect(
            service.extractAndCacheDocument({ libraryId: 1 } as any),
        ).rejects.toMatchObject({ code: "DOCUMENT_ACCESS_REVOKED" });
        expect(listeners.size).toBe(0);
    });
});
