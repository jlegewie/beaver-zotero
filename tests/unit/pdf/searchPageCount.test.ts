/**
 * `opSearch` reports the page count the page tree resolves to, like
 * extraction and rendering, on a fresh open as well as on a document reopened
 * from the worker's cache. Runs the real MuPDF WASM.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { ensureExtractionRuntime } from "../../../src/beaver-extract/node/bootstrap";
import { clearAllCachedDocs } from "../../../src/beaver-extract/worker/docCache";
import { opGetPageCount, opSearch } from "../../../src/beaver-extract/worker/ops";
import { buildWarmupPdf } from "../../../src/beaver-extract/worker/warmupPdf";

/** A 3-page PDF whose page tree advertises 9 pages (same byte length, so offsets stay valid). */
function overstatedPageCountPdf(): Uint8Array {
    const text = new TextDecoder("latin1").decode(buildWarmupPdf(3));
    expect(text).toContain("/Count 3");
    return Uint8Array.from(text.replace("/Count 3", "/Count 9"), (c) => c.charCodeAt(0));
}

describe("opSearch page count", () => {
    beforeAll(async () => {
        await ensureExtractionRuntime();
    });

    it("reports the resolved page count on a fresh open and after reuse", async () => {
        const pdfData = overstatedPageCountPdf();
        clearAllCachedDocs();
        const fresh = await opSearch({ pdfData, query: "the" });
        const reused = await opSearch({ pdfData, query: "the" });

        expect(fresh.result.totalPages).toBe(3);
        expect(reused.result.totalPages).toBe(3);
        expect(fresh.result.pagesWithMatches).toBe(reused.result.pagesWithMatches);
    });

    it("applies the page-count gate to the resolved count", async () => {
        clearAllCachedDocs();
        const result = await opSearch({ pdfData: overstatedPageCountPdf(), query: "the", maxPageCount: 5 });
        expect(result.result.exceedsPageCountLimit).toBeUndefined();
        expect(result.result.totalPages).toBe(3);
    });

    it("leaves the page-count op on the advertised count", async () => {
        // Kept byte-identical on purpose; documents why search differs from it.
        clearAllCachedDocs();
        const { result } = await opGetPageCount({ pdfData: overstatedPageCountPdf() });
        expect(result.count).toBe(9);
    });
});
