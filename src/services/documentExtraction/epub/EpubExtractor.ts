import {
    buildDomCitationIndex,
    createDomCounters,
    parseDomSection,
    type DomSection,
} from "../dom";
import {
    EPUB_CONTENT_KIND,
    EPUB_SCHEMA_VERSION,
    type EpubDocument,
} from "./schema";

interface ZoteroEpubModule {
    EPUB: new (filePath: string) => {
        getSectionDocuments(): AsyncIterable<{ href: string; doc: XMLDocument | Document }>;
        close(): void;
    };
}

/** Extract a local Zotero EPUB attachment into Beaver's section-based schema. */
export async function extractEpubDocument(item: Zotero.Item): Promise<EpubDocument> {
    if (!isEpubAttachment(item)) {
        throw new Error("Item is not an EPUB attachment");
    }

    const filePath = await item.getFilePathAsync();
    if (!filePath) {
        throw new Error("EPUB attachment has no local file");
    }

    const { EPUB } = (globalThis as any).ChromeUtils.importESModule(
        "chrome://zotero/content/EPUB.mjs",
    ) as ZoteroEpubModule;
    const epub = new EPUB(filePath);
    const counters = createDomCounters();
    const sections: DomSection[] = [];

    try {
        let sectionIndex = 0;
        for await (const { href, doc } of epub.getSectionDocuments()) {
            sections.push(parseDomSection({
                doc,
                sectionIndex,
                rawHref: href,
                counters,
            }));
            sectionIndex += 1;
            await Zotero.Promise.delay(0);
        }
    } finally {
        epub.close();
    }

    return {
        content_kind: EPUB_CONTENT_KIND,
        schemaVersion: EPUB_SCHEMA_VERSION,
        sectionCount: sections.length,
        sections,
        citationIndex: buildDomCitationIndex(sections),
    };
}

function isEpubAttachment(item: Zotero.Item): boolean {
    const maybeItem = item as Zotero.Item & {
        isEPUBAttachment?: () => boolean;
        attachmentContentType?: string;
    };
    if (typeof maybeItem.isEPUBAttachment === "function") {
        return maybeItem.isEPUBAttachment();
    }
    return maybeItem.attachmentContentType === "application/epub+zip";
}
