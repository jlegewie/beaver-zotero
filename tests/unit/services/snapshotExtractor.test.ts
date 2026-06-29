// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { extractSnapshotDocumentFromFile } from "../../../src/services/documentExtraction/snapshot";

function htmlBytes(body: string, opts?: { title?: string; lang?: string }): Uint8Array {
    const title = opts?.title ? `<title>${opts.title}</title>` : "";
    const lang = opts?.lang ? ` lang="${opts.lang}"` : "";
    const html = `<!DOCTYPE html><html${lang}><head>${title}</head><body>${body}</body></html>`;
    return new TextEncoder().encode(html);
}

describe("extractSnapshotDocumentFromFile", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("extracts a single section with sentence-split items and a citation index", async () => {
        (globalThis as any).IOUtils.read.mockResolvedValue(
            htmlBytes("<h1>Heading</h1><p>First sentence. Second sentence.</p>", { title: "My Page" }),
        );

        const doc = await extractSnapshotDocumentFromFile("/tmp/page.html", {
            rawHref: "https://example.com/article",
        });

        expect(doc.content_kind).toBe("snapshot");
        expect(doc.schemaVersion).toBe("1");
        expect(doc.sectionCount).toBe(1);
        expect(doc.sections).toHaveLength(1);
        expect(doc.sections[0].index).toBe(0);
        expect(doc.sections[0].rawHref).toBe("https://example.com/article");
        expect(doc.sections[0].label).toBe("My Page");

        const items = doc.sections[0].items;
        expect(items.length).toBeGreaterThan(0);
        // The body paragraph carries sentence-level breakdowns.
        const textItem = items.find((item) => item.kind === "text");
        expect(textItem?.sentences?.length).toBeGreaterThanOrEqual(1);

        // Citation index maps the emitted item/sentence ids.
        expect(Object.keys(doc.citationIndex).length).toBeGreaterThan(0);
        expect(typeof doc.diagnostics.extractedTextChars).toBe("number");
    });

    it("stamps a synthetic pageNumber on every item and reports pageCount", async () => {
        // Long body to span multiple synthetic pages (~1800-char interval).
        const para = "word ".repeat(500); // ~2500 chars per paragraph
        (globalThis as any).IOUtils.read.mockResolvedValue(htmlBytes(`<p>${para}</p><p>${para}</p>`));

        const doc = await extractSnapshotDocumentFromFile("/tmp/page.html");
        const items = doc.sections[0].items;

        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(typeof item.pageNumber).toBe("number");
            expect(item.pageNumber).toBeGreaterThanOrEqual(1);
            // Snapshots carry no publisher page markers.
            expect(item.pageLabel).toBeUndefined();
        }
        const maxPage = Math.max(...items.map((item) => item.pageNumber ?? 1));
        expect(doc.pageCount).toBe(maxPage);
        expect(doc.pageCount).toBeGreaterThan(1);
    });

    it("falls back to the filename for rawHref when no URL is given", async () => {
        (globalThis as any).IOUtils.read.mockResolvedValue(htmlBytes("<p>Body text here.</p>"));

        const doc = await extractSnapshotDocumentFromFile("/tmp/major-oak-tree-dies.html");

        expect(doc.sections[0].rawHref).toBe("major-oak-tree-dies.html");
        // No <title> and no fallbackLabel → undefined label.
        expect(doc.sections[0].label).toBeUndefined();
    });

    it("uses the provided fallback label when the document has no <title>", async () => {
        (globalThis as any).IOUtils.read.mockResolvedValue(htmlBytes("<p>Body text here.</p>"));

        const doc = await extractSnapshotDocumentFromFile("/tmp/page.html", {
            fallbackLabel: "Item Title",
        });

        expect(doc.sections[0].label).toBe("Item Title");
    });

    it("reports zero extracted text and pageCount for an empty body", async () => {
        (globalThis as any).IOUtils.read.mockResolvedValue(htmlBytes(""));

        const doc = await extractSnapshotDocumentFromFile("/tmp/page.html");

        expect(doc.sections[0].items).toHaveLength(0);
        expect(doc.pageCount).toBe(0);
        expect(doc.diagnostics.extractedTextChars).toBe(0);
    });
});
