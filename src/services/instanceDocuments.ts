import { MuPDFWorkerClient } from "../beaver-extract/MuPDFWorkerClient";
import type {
    PDFCompiledWasm,
    PDFWorkerSlotName,
    PDFWorkerUrls,
} from "../beaver-extract/config";
import { logger } from "@beaver/agent-core/platform/logger";
import { documentImplementations } from "./documentExtractionCore";
import { DocumentAccessRevokedError } from "./documentExtraction/accessRevoked";
const {
    extractAndCacheDocument,
    extractAndCacheResolvedPdfDocument,
    extractAndCacheEpubDocument,
    extractAndCacheSnapshotDocument,
} = documentImplementations;

/** After a failed precompile, workers load the binaries themselves for this long. */
const COMPILED_WASM_RETRY_MS = 60_000;

async function compileWasm(url: string): Promise<WebAssembly.Module> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fetch ${url} failed with status ${response.status}`);
    return WebAssembly.compile(await response.arrayBuffer());
}

/** Shared extraction closures, cancellation and worker clients live in the plugin realm. */
export class InstanceDocuments {
    private closed = false;
    private active = new Set<AbortController>();
    private compiledWasm: PDFCompiledWasm | null = null;
    private compiledWasmLoad: Promise<PDFCompiledWasm | null> | null = null;
    /** When the last precompile failed; another attempt waits for the retry delay. */
    private compiledWasmFailedAt: number | null = null;
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
    /**
     * Compile the document workers' WASM once and share it with every worker
     * (both slots, every respawn), so a new worker instantiates it instead of
     * loading and compiling ~12 MB of binaries. The compiled code (~13 MB)
     * stays in this realm until disposal; live workers share it rather than
     * holding their own copies. Returns null for a minute after a failure
     * (the workers then load the binaries themselves), then tries again.
     */
    getCompiledWasm(
        urls: PDFWorkerUrls,
    ): PDFCompiledWasm | Promise<PDFCompiledWasm | null> | null {
        if (this.closed) return null;
        if (
            this.compiledWasmFailedAt !== null
            && Date.now() - this.compiledWasmFailedAt < COMPILED_WASM_RETRY_MS
        ) {
            return null;
        }
        if (this.compiledWasm) return this.compiledWasm;
        this.compiledWasmLoad ??= Promise.all([
            compileWasm(urls.mupdfWasmBinaryUrl),
            compileWasm(urls.sentencexWasmBinaryUrl),
        ]).then(
            ([mupdf, sentencex]) => {
                this.compiledWasmLoad = null;
                this.compiledWasmFailedAt = null;
                if (this.closed) return null;
                this.compiledWasm = { mupdf, sentencex };
                return this.compiledWasm;
            },
            (e) => {
                this.compiledWasmLoad = null;
                this.compiledWasmFailedAt = Date.now();
                logger(`Document WASM precompile failed; workers will compile it themselves: ${e}`, 2);
                return null;
            },
        );
        return this.compiledWasmLoad;
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
        this.compiledWasm = null;
        this.compiledWasmLoad = null;
        for (const controller of this.active) controller.abort();
    }
}
