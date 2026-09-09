// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { isRemoteAccessAvailableMock } = vi.hoisted(() => ({
    isRemoteAccessAvailableMock: vi.fn(),
}));

vi.mock("../../../src/services/documentExtraction/attachmentSource", () => ({
    isRemoteAccessAvailable: isRemoteAccessAvailableMock,
}));

import {
    EpubStructureError,
    extractEpubDocument,
    extractEpubDocumentFromFile,
    extractEpubDocumentSafe,
} from "../../../src/services/documentExtraction/epub";
// The file-size ceiling is read through the platform runtime adapter, which the
// running plugin installs at bundle load. This suite mocks away
// `attachmentSource`, the module that would otherwise pull it in, so install it
// here to make `Zotero.Prefs` the source of the ceiling.
import { registerZoteroRuntime } from "../../../src/platform/zoteroRuntime";

registerZoteroRuntime();

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
        (globalThis as any).Zotero.Prefs.get = vi.fn().mockReturnValue(undefined);
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
        // The ceiling comes from the preference, not a per-call argument.
        Zotero.Prefs.get = vi.fn((key: string) =>
            key.endsWith(".maxAttachmentFileSizeMB") ? 1 : undefined,
        ) as any;

        const result = await extractEpubDocumentSafe({
            isEPUBAttachment: () => true,
            getFilePathAsync: vi.fn().mockResolvedValue("/tmp/book.epub"),
        } as any);

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

/**
 * A book whose container or OPF is unreadable can never extract, however many
 * times it is retried, so the background queue needs to tell that apart from a
 * transient extractor fault.
 *
 * The distinction cannot be drawn from *when* the failure happened: Zotero's
 * `EPUB.mjs` resolves the OPF and reads the first spine section inside the same
 * first `next()` call, so a transient read error and a malformed OPF both throw
 * before anything is yielded. The extractor therefore re-reads the container
 * after a failure and classifies on what it finds.
 */
describe("structural EPUB failures", () => {
    const VALID_CONTAINER = `<?xml version="1.0"?>
        <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
            <rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles>
        </container>`;
    const VALID_OPF = `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf">
            <manifest><item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/></manifest>
            <spine><itemref idref="s1"/></spine>
        </package>`;
    /** An OPF that parses but has neither child EPUB.mjs requires. */
    const OPF_WITHOUT_MANIFEST_AND_SPINE = `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf"><metadata/></package>`;

    const A_VALID_BOOK: Record<string, string> = {
        "META-INF/container.xml": VALID_CONTAINER,
        "OEBPS/content.opf": VALID_OPF,
    };

    let zipClosed = 0;

    /**
     * Back the structure probe with an in-memory archive. `null` makes opening
     * the archive throw, standing in for a file that vanished or is unreadable.
     */
    function installZip(entries: Record<string, string> | null) {
        zipClosed = 0;
        (globalThis as any).Components = {
            Constructor: () => class {
                constructor() {
                    if (entries === null) throw new Error("zip open failed");
                }
                hasEntry(path: string) {
                    return Object.prototype.hasOwnProperty.call(entries ?? {}, path);
                }
                getInputStream(path: string) {
                    if (!this.hasEntry(path)) throw new Error(`no entry ${path}`);
                    return { _text: (entries ?? {})[path], close() {} };
                }
                close() {
                    zipClosed += 1;
                }
            },
        };
        (globalThis as any).Zotero.File = {
            pathToFile: (p: string) => p,
            getContentsAsync: async (stream: any) => stream._text,
        };
    }

    /** An EPUB module whose generator throws after `yieldCount` sections. */
    function installFailingEpubModule(options: {
        error: Error;
        yieldCount?: number;
        throwOnConstruct?: boolean;
    }) {
        const close = vi.fn();
        const { error, yieldCount = 0, throwOnConstruct = false } = options;
        (globalThis as any).ChromeUtils = {
            importESModule: vi.fn(() => ({
                EPUB: class {
                    constructor() {
                        if (throwOnConstruct) throw error;
                    }
                    async *getSectionDocuments() {
                        for (let i = 0; i < yieldCount; i += 1) {
                            yield { href: `s${i}.xhtml`, doc: parseXhtml("<p>Body text here.</p>") };
                        }
                        throw error;
                    }
                    close = close;
                },
            })),
        };
        return { close };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Promise = { delay: vi.fn().mockResolvedValue(undefined) };
    });

    it("classifies a missing container.xml as structural", async () => {
        installZip({ "OEBPS/content.opf": VALID_OPF });
        installFailingEpubModule({ error: new Error("EPUB file does not contain container.xml") });

        await expect(extractEpubDocumentFromFile("/tmp/book.epub"))
            .rejects.toBeInstanceOf(EpubStructureError);
    });

    it("classifies a container.xml without a rootfile as structural", async () => {
        installZip({
            "META-INF/container.xml": `<?xml version="1.0"?><container><rootfiles/></container>`,
        });
        installFailingEpubModule({
            error: new Error('container.xml does not contain <rootfile full-path="...">'),
        });

        await expect(extractEpubDocumentFromFile("/tmp/book.epub"))
            .rejects.toBeInstanceOf(EpubStructureError);
    });

    it("classifies an OPF without manifest and spine as structural", async () => {
        installZip({
            "META-INF/container.xml": VALID_CONTAINER,
            "OEBPS/content.opf": OPF_WITHOUT_MANIFEST_AND_SPINE,
        });
        installFailingEpubModule({
            error: new Error("content.opf does not contain <manifest> and <spine>"),
        });

        await expect(extractEpubDocumentFromFile("/tmp/book.epub"))
            .rejects.toBeInstanceOf(EpubStructureError);
    });

    it("preserves the original message when reclassifying", async () => {
        installZip({ "OEBPS/content.opf": VALID_OPF });
        installFailingEpubModule({ error: new Error("EPUB file does not contain container.xml") });

        await expect(extractEpubDocumentFromFile("/tmp/book.epub"))
            .rejects.toThrow("EPUB file does not contain container.xml");
    });

    it("keeps a read failure on a structurally sound book retryable", async () => {
        // The regression this guards: `EPUB.mjs` reads the first spine section
        // inside the same call that validates the OPF, so a transient I/O error
        // also throws before the first yield. Classifying on timing would mark
        // this permanent and the queue would never retry it.
        installZip(A_VALID_BOOK);
        installFailingEpubModule({ error: new Error("NS_ERROR_FILE_IO_ERROR reading s1.xhtml") });

        await expect(extractEpubDocumentFromFile("/tmp/book.epub"))
            .rejects.not.toBeInstanceOf(EpubStructureError);
    });

    it("classifies a broken container even when it fails after a section", async () => {
        // The mirror image: the verdict comes from the container, not from how
        // far extraction happened to get.
        installZip({ "OEBPS/content.opf": VALID_OPF });
        installFailingEpubModule({ error: new Error("blew up later"), yieldCount: 1 });

        await expect(extractEpubDocumentFromFile("/tmp/book.epub"))
            .rejects.toBeInstanceOf(EpubStructureError);
    });

    it("stays retryable when the probe cannot open the archive", async () => {
        // Undecidable — the file may simply have moved. Fail open.
        installZip(null);
        installFailingEpubModule({ error: new Error("Something went wrong") });

        await expect(extractEpubDocumentFromFile("/tmp/book.epub"))
            .rejects.not.toBeInstanceOf(EpubStructureError);
    });

    it("never reclassifies an abort", async () => {
        installZip({ "OEBPS/content.opf": VALID_OPF });
        installFailingEpubModule({ error: new Error("Operation aborted") });

        await expect(extractEpubDocumentFromFile("/tmp/book.epub"))
            .rejects.not.toBeInstanceOf(EpubStructureError);
    });

    it("closes the probe's archive handle", async () => {
        installZip(A_VALID_BOOK);
        installFailingEpubModule({ error: new Error("transient") });

        await expect(extractEpubDocumentFromFile("/tmp/book.epub")).rejects.toThrow();
        expect(zipClosed).toBe(1);
    });

    it("closes the EPUB handle when extraction fails", async () => {
        installZip(A_VALID_BOOK);
        const { close } = installFailingEpubModule({ error: new Error("transient") });

        await expect(extractEpubDocumentFromFile("/tmp/book.epub")).rejects.toThrow();
        expect(close).toHaveBeenCalledTimes(1);
    });
});
