// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { isRemoteAccessAvailableMock } = vi.hoisted(() => ({
    isRemoteAccessAvailableMock: vi.fn(),
}));

vi.mock("../../../src/services/documentExtraction/attachmentSource", () => ({
    isRemoteAccessAvailable: isRemoteAccessAvailableMock,
}));

import {
    extractEpubDocument,
    extractEpubDocumentFromFile,
    extractEpubDocumentSafe,
} from "../../../src/services/documentExtraction/epub";

function parseXhtml(markup: string): Document {
    return new DOMParser().parseFromString(
        `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${markup}</body></html>`,
        "application/xhtml+xml",
    );
}

async function* sections(entries: Array<{ href: string; doc: Document }>) {
    for (const entry of entries) {
        yield entry;
    }
}

function installEpubModule(entries: Array<{ href: string; doc: Document }>) {
    const close = vi.fn();
    const importESModule = vi.fn(() => ({
        EPUB: class {
            constructor(public filePath: string) {}
            getSectionDocuments() {
                expect(this.filePath).toBe("/tmp/book.epub");
                return sections(entries);
            }
            close = close;
        },
    }));
    (globalThis as any).ChromeUtils = { importESModule };
    return { close, importESModule };
}

describe("extractEpubDocument", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Promise = { delay: vi.fn().mockResolvedValue(undefined) };
        isRemoteAccessAvailableMock.mockReturnValue(false);
        (globalThis as any).IOUtils.stat.mockResolvedValue({ lastModified: 0, size: 0 });
    });

    it("extracts sections in order and closes the EPUB handle on success", async () => {
        const close = vi.fn();
        const importESModule = vi.fn(() => ({
            EPUB: class {
                constructor(public filePath: string) {}
                getSectionDocuments() {
                    expect(this.filePath).toBe("/tmp/book.epub");
                    return sections([
                        { href: "EPUB/index.xhtml", doc: parseXhtml("<p>First.</p>") },
                        { href: "EPUB/chapter.xhtml", doc: parseXhtml("<p>Second.</p>") },
                    ]);
                }
                close = close;
            },
        }));
        (globalThis as any).ChromeUtils = { importESModule };

        const doc = await extractEpubDocument({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue("/tmp/book.epub"),
        } as any);

        expect(importESModule).toHaveBeenCalledWith("chrome://zotero/content/EPUB.mjs");
        expect(close).toHaveBeenCalledTimes(1);
        expect(doc).toMatchObject({
            content_kind: "epub",
            schemaVersion: "2",
            sectionCount: 2,
            sections: [
                { index: 0, rawHref: "EPUB/index.xhtml" },
                { index: 1, rawHref: "EPUB/chapter.xhtml" },
            ],
        });
        expect(doc.sections[0].items[0]).toMatchObject({ id: "p1", text: "First." });
        expect(doc.sections[1].items[0]).toMatchObject({ id: "p2", text: "Second." });
        expect(doc.citationIndex.s1).toMatchObject({ kind: "sentence", itemId: "p1" });
        expect((globalThis as any).Zotero.Promise.delay).toHaveBeenCalledTimes(2);
    });

    it("closes the EPUB handle when section iteration throws", async () => {
        const close = vi.fn();
        (globalThis as any).ChromeUtils = {
            importESModule: vi.fn(() => ({
                EPUB: class {
                    async *getSectionDocuments() {
                        yield { href: "EPUB/index.xhtml", doc: parseXhtml("<p>First.</p>") };
                        throw new Error("iteration failed");
                    }
                    close = close;
                },
            })),
        };

        await expect(extractEpubDocument({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue("/tmp/book.epub"),
        } as any)).rejects.toThrow("iteration failed");
        expect(close).toHaveBeenCalledTimes(1);
    });

    it("rejects non-EPUB attachments and missing local files", async () => {
        await expect(extractEpubDocument({
            isEPUBAttachment: () => false,
            getFilePathAsync: vi.fn(),
        } as any)).rejects.toThrow("Item is not an EPUB attachment");

        await expect(extractEpubDocument({
            attachmentContentType: "application/epub+zip",
            getFilePathAsync: vi.fn().mockResolvedValue(""),
        } as any)).rejects.toThrow("EPUB attachment has no local file");
    });

    it("honors an abort signal before opening the EPUB", async () => {
        const importESModule = vi.fn();
        (globalThis as any).ChromeUtils = { importESModule };
        const controller = new AbortController();
        controller.abort();

        await expect(extractEpubDocumentFromFile("/tmp/book.epub", {
            abortSignal: controller.signal,
        })).rejects.toThrow("Operation aborted");
        expect(importESModule).not.toHaveBeenCalled();
    });

    it("stamps item and sentence page labels for physical EPUB sections", async () => {
        installEpubModule([
            { href: "EPUB/one.xhtml", doc: parseXhtml('<a id="page_1"></a><p>First sentence.</p>') },
            { href: "EPUB/two.xhtml", doc: parseXhtml('<a id="page_2"></a><p>Second sentence.</p>') },
        ]);

        const doc = await extractEpubDocumentFromFile("/tmp/book.epub");

        expect(doc.sections[0].items[0]).toMatchObject({
            text: "First sentence.",
            pageLabel: "1",
            sentences: [{ text: "First sentence.", pageLabel: "1" }],
        });
        expect(doc.sections[1].items[0]).toMatchObject({
            text: "Second sentence.",
            pageLabel: "2",
            sentences: [{ text: "Second sentence.", pageLabel: "2" }],
        });
    });

    it("leaves page labels unset when marker coverage is not physical", async () => {
        installEpubModule([
            { href: "EPUB/one.xhtml", doc: parseXhtml('<a id="page_1"></a><p>Marked.</p>') },
            { href: "EPUB/two.xhtml", doc: parseXhtml("<p>Unmarked.</p>") },
            { href: "EPUB/three.xhtml", doc: parseXhtml("<p>Also unmarked.</p>") },
        ]);

        const doc = await extractEpubDocumentFromFile("/tmp/book.epub");

        expect(doc.sections[0].items[0].pageLabel).toBeUndefined();
        expect(doc.sections[0].items[0].sentences?.[0]?.pageLabel).toBeUndefined();
        expect(doc.sections[1].items[0].pageLabel).toBeUndefined();
    });

    it("detects mid-paragraph page markers and applies item-level labels", async () => {
        installEpubModule([
            {
                href: "EPUB/one.xhtml",
                doc: parseXhtml(
                    '<p><span epub:type="pagebreak" title="1"></span>Before break <span epub:type="pagebreak" title="2"></span>after break.</p>'
                    + "<p>Next paragraph.</p>",
                ),
            },
        ]);

        const doc = await extractEpubDocumentFromFile("/tmp/book.epub");
        const [spanningParagraph, nextParagraph] = doc.sections[0].items;

        expect(spanningParagraph).toMatchObject({
            text: "Before break after break.",
            pageLabel: "1",
        });
        expect(nextParagraph).toMatchObject({
            text: "Next paragraph.",
            pageLabel: "2",
        });
    });

    it("labels flushed loose text from its emitted first text node", async () => {
        installEpubModule([
            {
                href: "EPUB/one.xhtml",
                doc: parseXhtml(
                    '<div><a id="page_1"></a>A text.<p>Middle text.</p><a id="page_2"></a> B text.</div>',
                ),
            },
        ]);

        const doc = await extractEpubDocumentFromFile("/tmp/book.epub");

        expect(doc.sections[0].items.map((item) => ({
            text: item.text,
            pageLabel: item.pageLabel,
        }))).toEqual([
            { text: "A text.", pageLabel: "1" },
            { text: "Middle text.", pageLabel: "1" },
            { text: "B text.", pageLabel: "2" },
        ]);
    });
});

describe("stampEpubPageNumbers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Promise = { delay: vi.fn().mockResolvedValue(undefined) };
        isRemoteAccessAvailableMock.mockReturnValue(false);
    });

    it("numbers physical pages by marker ordinal, letting a page span sections", async () => {
        installEpubModule([
            { href: "EPUB/one.xhtml", doc: parseXhtml('<a id="page_1"></a><p>Alpha.</p>') },
            { href: "EPUB/two.xhtml", doc: parseXhtml("<p>Bravo.</p>") },
            { href: "EPUB/three.xhtml", doc: parseXhtml('<a id="page_2"></a><p>Charlie.</p>') },
        ]);

        const doc = await extractEpubDocumentFromFile("/tmp/book.epub");

        expect(doc.sections[0].items[0]).toMatchObject({ text: "Alpha.", pageNumber: 1, pageLabel: "1" });
        // A physical page can span section boundaries.
        expect(doc.sections[1].items[0]).toMatchObject({ text: "Bravo.", pageNumber: 1, pageLabel: "1" });
        expect(doc.sections[2].items[0]).toMatchObject({ text: "Charlie.", pageNumber: 2, pageLabel: "2" });
        expect(doc.pageCount).toBe(2);
    });

    it("demotes to synthetic page numbers when a physical page is too large, keeping marker labels", async () => {
        const huge = "a".repeat(6500); // exceeds MAX_PHYSICAL_PAGE_CHARS
        installEpubModule([
            { href: "EPUB/one.xhtml", doc: parseXhtml(`<a id="page_1"></a><p>${huge}</p>`) },
            { href: "EPUB/two.xhtml", doc: parseXhtml("<p>Bravo.</p>") },
            { href: "EPUB/three.xhtml", doc: parseXhtml("<p>Charlie.</p>") },
            { href: "EPUB/four.xhtml", doc: parseXhtml('<a id="page_2"></a><p>Delta.</p>') },
        ]);

        const doc = await extractEpubDocumentFromFile("/tmp/book.epub");

        // Marker labels remain independent from synthetic page numbers.
        expect(doc.sections[1].items[0].pageLabel).toBe("1");
        expect(doc.sections[3].items[0].pageLabel).toBe("2");
        expect(doc.sections[0].items[0].pageNumber).toBe(1);
        expect(doc.sections[1].items[0].pageNumber).toBe(5);
        expect(doc.sections[2].items[0].pageNumber).toBe(6);
        expect(doc.sections[3].items[0].pageNumber).toBe(7);
        expect(doc.pageCount).toBe(7);
    });

    it("synthesizes uniform pages with section-boundary resets when no markers exist", async () => {
        installEpubModule([
            { href: "EPUB/one.xhtml", doc: parseXhtml("<p>Alpha.</p><p>Bravo.</p>") },
            { href: "EPUB/two.xhtml", doc: parseXhtml("<p>Charlie.</p>") },
        ]);

        const doc = await extractEpubDocumentFromFile("/tmp/book.epub");

        // Small items in one section share a page; a new section starts a new page.
        expect(doc.sections[0].items[0]).toMatchObject({ text: "Alpha.", pageNumber: 1 });
        expect(doc.sections[0].items[1]).toMatchObject({ text: "Bravo.", pageNumber: 1 });
        expect(doc.sections[1].items[0]).toMatchObject({ text: "Charlie.", pageNumber: 2 });
        expect(doc.sections[0].items[0].pageLabel).toBeUndefined();
        expect(doc.pageCount).toBe(2);
    });

    it("splits a long section into multiple synthetic pages by char interval", async () => {
        const para = `<p>${"a".repeat(299)}.</p>`;
        installEpubModule([
            { href: "EPUB/one.xhtml", doc: parseXhtml(para.repeat(8)) },
        ]);

        const doc = await extractEpubDocumentFromFile("/tmp/book.epub");
        const items = doc.sections[0].items;

        expect(items).toHaveLength(8);
        expect(items[0].pageNumber).toBe(1);
        expect(items[6].pageNumber).toBe(1);
        expect(items[7].pageNumber).toBe(2);
        expect(doc.pageCount).toBe(2);
    });

    it("assigns page 1 to front matter before the first marker", async () => {
        installEpubModule([
            { href: "EPUB/one.xhtml", doc: parseXhtml('<p>Frontmatter.</p><a id="page_1"></a><p>Body.</p>') },
            { href: "EPUB/two.xhtml", doc: parseXhtml('<a id="page_2"></a><p>More.</p>') },
        ]);

        const doc = await extractEpubDocumentFromFile("/tmp/book.epub");
        const [frontmatter, body] = doc.sections[0].items;

        expect(frontmatter).toMatchObject({ text: "Frontmatter.", pageNumber: 1 });
        expect(frontmatter.pageLabel).toBeUndefined(); // no label precedes the first marker
        expect(body).toMatchObject({ text: "Body.", pageNumber: 1, pageLabel: "1" });
        expect(doc.sections[1].items[0]).toMatchObject({ text: "More.", pageNumber: 2, pageLabel: "2" });
    });
});

describe("extractEpubDocumentSafe", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Promise = { delay: vi.fn().mockResolvedValue(undefined) };
        isRemoteAccessAvailableMock.mockReturnValue(false);
        (globalThis as any).IOUtils.stat.mockResolvedValue({ lastModified: 0, size: 1024 });
    });

    it("returns ok for a local EPUB that parses successfully", async () => {
        installEpubModule([
            { href: "EPUB/index.xhtml", doc: parseXhtml("<p>First.</p>") },
        ]);

        const result = await extractEpubDocumentSafe({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue("/tmp/book.epub"),
        } as any);

        expect(result).toMatchObject({
            kind: "ok",
            document: {
                content_kind: "epub",
                sectionCount: 1,
            },
        });
    });

    it("returns file_missing for a missing local file without remote availability", async () => {
        const onFileNotSyncedLocally = vi.fn();

        const result = await extractEpubDocumentSafe({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue(""),
        } as any, { onFileNotSyncedLocally });

        expect(result).toMatchObject({
            kind: "response_error",
            code: "file_missing",
        });
        expect(onFileNotSyncedLocally).not.toHaveBeenCalled();
    });

    it("returns file_missing and notifies when the EPUB is remote but not synced locally", async () => {
        isRemoteAccessAvailableMock.mockReturnValue(true);
        const onFileNotSyncedLocally = vi.fn();

        const result = await extractEpubDocumentSafe({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue(""),
        } as any, { onFileNotSyncedLocally });

        expect(result).toMatchObject({
            kind: "response_error",
            code: "file_missing",
            message: expect.stringContaining("available remotely"),
        });
        expect(onFileNotSyncedLocally).toHaveBeenCalledTimes(1);
    });

    it("returns extraction_failed when file path resolution throws", async () => {
        const result = await extractEpubDocumentSafe({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockRejectedValue(new Error("lookup failed")),
        } as any);

        expect(result).toMatchObject({
            kind: "response_error",
            code: "extraction_failed",
        });
    });

    it("returns file_missing when the file vanishes before stat", async () => {
        const error = new Error("missing");
        error.name = "NotFoundError";
        (globalThis as any).IOUtils.stat.mockRejectedValue(error);

        const result = await extractEpubDocumentSafe({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue("/tmp/book.epub"),
        } as any);

        expect(result).toMatchObject({
            kind: "response_error",
            code: "file_missing",
        });
    });

    it("returns extraction_failed when stat fails for another reason", async () => {
        (globalThis as any).IOUtils.stat.mockRejectedValue(new Error("permission denied"));

        const result = await extractEpubDocumentSafe({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue("/tmp/book.epub"),
        } as any);

        expect(result).toMatchObject({
            kind: "response_error",
            code: "extraction_failed",
        });
    });

    it("returns file_too_large when the EPUB exceeds the effective size cap", async () => {
        (globalThis as any).IOUtils.stat.mockResolvedValue({
            lastModified: 0,
            size: 2 * 1024 * 1024,
        });

        const result = await extractEpubDocumentSafe({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue("/tmp/book.epub"),
        } as any, { maxFileSizeMB: 1 });

        expect(result).toMatchObject({
            kind: "response_error",
            code: "file_too_large",
            message: expect.stringContaining("1 MB limit"),
        });
    });

    it("returns extraction_failed when parsing fails and still closes the EPUB handle", async () => {
        const close = vi.fn();
        (globalThis as any).ChromeUtils = {
            importESModule: vi.fn(() => ({
                EPUB: class {
                    async *getSectionDocuments() {
                        yield { href: "EPUB/index.xhtml", doc: parseXhtml("<p>First.</p>") };
                        throw new Error("iteration failed");
                    }
                    close = close;
                },
            })),
        };

        const result = await extractEpubDocumentSafe({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue("/tmp/book.epub"),
        } as any);

        expect(result).toMatchObject({
            kind: "response_error",
            code: "extraction_failed",
        });
        expect(close).toHaveBeenCalledTimes(1);
    });

    it("returns unsupported_type for non-EPUB attachments", async () => {
        const result = await extractEpubDocumentSafe({
            isEPUBAttachment: () => false,
            getFilePathAsync: vi.fn(),
        } as any);

        expect(result).toMatchObject({
            kind: "response_error",
            code: "unsupported_type",
        });
    });
});
