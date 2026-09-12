import { MuPDFWorkerClient } from "../beaver-extract/MuPDFWorkerClient";
import type { PDFWorkerSlotName } from "../beaver-extract/config";
import { documentImplementations } from "./documentExtractionCore";
import { DocumentAccessRevokedError } from "./documentExtraction/accessRevoked";
const {
    extractAndCacheDocument,
    extractAndCacheResolvedPdfDocument,
    extractAndCacheEpubDocument,
    extractAndCacheSnapshotDocument,
} = documentImplementations;

/** Shared extraction closures, cancellation and worker clients live in the plugin realm. */
export class InstanceDocuments {
    private closed = false;
    private active = new Set<AbortController>();
    readonly extractAndCacheDocument = (
        args: Parameters<typeof extractAndCacheDocument>[0],
    ) => this.run(args, extractAndCacheDocument);
    readonly extractAndCacheResolvedPdfDocument = (
        args: Parameters<typeof extractAndCacheResolvedPdfDocument>[0],
    ) => this.run(args, extractAndCacheResolvedPdfDocument);
    readonly extractAndCacheEpubDocument = (
        args: Parameters<typeof extractAndCacheEpubDocument>[0],
    ) => this.run(args, extractAndCacheEpubDocument);
    readonly extractAndCacheSnapshotDocument = (
        args: Parameters<typeof extractAndCacheSnapshotDocument>[0],
    ) => this.run(args, extractAndCacheSnapshotDocument);

    private async run<
        A extends {
            externalAbortSignal?: AbortSignal;
            timeoutContext?: unknown;
        },
        R,
    >(args: A, execute: (args: A) => Promise<R>): Promise<R> {
        const account = Zotero.Beaver.account;
        const generation = account?.getGeneration();
        const source = (args as any).source;
        const libraryId: number | undefined =
            (args as any).libraryId ??
            (source?.kind === "zotero" ? source.item.libraryID : undefined);
        const controller = new AbortController();
        const allowed = () =>
            !this.closed &&
            !!account &&
            account.getGeneration() === generation &&
            Zotero.Beaver.libraryScopeInitialized &&
            (libraryId === undefined ||
                Zotero.Beaver.searchableLibraryIds?.includes(libraryId));
        if (!allowed())
            throw new DocumentAccessRevokedError("Document access is unavailable");
        const abort = () => controller.abort();
        this.active.add(controller);
        const unsubscribe = account?.subscribe(() => {
            if (!allowed()) abort();
        });
        args.externalAbortSignal?.addEventListener("abort", abort, {
            once: true,
        });
        if (args.externalAbortSignal?.aborted) abort();
        try {
            // The service creates its own deadline; renderer timer callbacks cannot own shared work.
            const result = await execute({
                ...args,
                timeoutContext: undefined,
                externalAbortSignal: controller.signal,
            });
            if (!allowed())
                throw new DocumentAccessRevokedError("Document access was revoked");
            return result;
        } finally {
            args.externalAbortSignal?.removeEventListener("abort", abort);
            unsubscribe?.();
            this.active.delete(controller);
        }
    }
    createClient(name: PDFWorkerSlotName): MuPDFWorkerClient {
        if (this.closed) throw new Error("Document runtime disposed");
        return new MuPDFWorkerClient({ slotName: name });
    }
    createWorker(url: string): Worker {
        if (this.closed) throw new Error("Document runtime disposed");
        const { createDocumentWorker } = ChromeUtils.importESModule(
            "chrome://beaver/content/scripts/documentWorker.sys.mjs",
        );
        return createDocumentWorker(url);
    }
    dispose(): void {
        this.closed = true;
        for (const controller of this.active) controller.abort();
    }
}
