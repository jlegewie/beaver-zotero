// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractEpubDocument } from "../../../src/services/documentExtraction/epub";

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

describe("extractEpubDocument", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Promise = { delay: vi.fn().mockResolvedValue(undefined) };
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
});
