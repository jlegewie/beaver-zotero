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
        `<html xmlns="http://www.w3.org/1999/xhtml"><body>${markup}</body></html>`,
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
            schemaVersion: "1",
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
