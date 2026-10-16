/**
 * The `__warmup` worker op and its generated document: the document is a
 * well-formed PDF whose pages extract as article text, and the op runs a
 * structured extraction of it without touching the worker's document cache.
 * Runs the real MuPDF and sentencex WASM.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { ensureExtractionRuntime } from "../../../src/beaver-extract/node/bootstrap";
import { getCacheStats } from "../../../src/beaver-extract/worker/docCache";
import { opExtract, opWarmup } from "../../../src/beaver-extract/worker/ops";
import { buildWarmupPdf } from "../../../src/beaver-extract/worker/warmupPdf";

describe("warm-up document", () => {
    it("has a cross-reference table that points at every object", () => {
        const text = new TextDecoder().decode(buildWarmupPdf(3));
        // `startxref` also ends in "xref": anchor on the table's own line.
        const xrefStart = text.lastIndexOf("\nxref\n") + 1;
        const xref = text.slice(xrefStart);
        const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
        expect(offsets).toHaveLength(4 + 2 * 3);
        offsets.forEach((offset, index) => {
            expect(text.startsWith(`${index + 1} 0 obj\n`, offset)).toBe(true);
        });
        expect(text).toContain("/Count 3");
        expect(Number(text.match(/startxref\n(\d+)/)![1])).toBe(xrefStart);
    });
});

describe("warm-up op", () => {
    beforeAll(async () => {
        await ensureExtractionRuntime();
    });

    it("extracts every page as article text with headings and figures", async () => {
        const { result } = await opExtract({
            pdfData: buildWarmupPdf(4),
            mode: "structured",
            settings: { checkTextLayer: true },
        });
        expect(result.mode).toBe("structured");
        const pages = result.mode === "structured" ? result.document.pages : [];
        expect(pages).toHaveLength(4);
        for (const page of pages) {
            const kinds = page.items.map((item) => item.kind);
            expect(kinds).toContain("section_header");
            expect(kinds.filter((kind) => kind === "text").length).toBeGreaterThan(5);
        }
        expect(pages[0].items.map((item) => item.kind)).toEqual(expect.arrayContaining(["picture", "caption"]));
    });

    it("runs a structured extraction outside the document cache", async () => {
        const before = getCacheStats();
        const { result } = await opWarmup({ pages: 2 });
        expect(result.sentencexMs).not.toBeNull();
        expect(result.extractMs).toBeGreaterThan(0);
        expect(getCacheStats()).toMatchObject({ entries: before.entries, misses: before.misses, hits: before.hits });
    });
});
