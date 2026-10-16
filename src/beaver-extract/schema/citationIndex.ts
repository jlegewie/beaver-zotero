import type {
    CitationIndex,
    CitationIndexEntry,
    DocumentItem,
    Rect,
    Sentence,
    StructuredDocument,
    StructuredPage,
} from "@beaver/agent-core/extract/schema";
import { resolveZoteroLocatorPageLabels } from "@beaver/agent-core/extract/pageLabels/printedPageLabels";

export interface ResolvedCitation {
    pageIndex: number;
    pageLabel?: string;
    item: DocumentItem;
    sentence?: Sentence;
    bboxes: Rect[];
}

function entryForItem(page: StructuredPage, item: DocumentItem, pageLabel?: string): CitationIndexEntry {
    return {
        id: item.id,
        kind: "item",
        pageIndex: page.index,
        pageLabel,
        itemId: item.id,
    };
}

function entryForSentence(
    page: StructuredPage,
    item: DocumentItem,
    sentence: Sentence,
    pageLabel?: string,
): CitationIndexEntry {
    return {
        id: sentence.id,
        kind: "sentence",
        pageIndex: page.index,
        pageLabel,
        itemId: item.id,
        sentenceId: sentence.id,
    };
}

/**
 * Zotero locator label per page index (`resolveZoteroLocatorPageLabels`): the
 * printed labels, or the labels the PDF declares for a document without any.
 */
function locatorPageLabels(
    pages: StructuredPage[],
    derivedPageLabels?: Record<string, string> | null,
): Record<number, string> {
    const embedded: Record<number, string> = {};
    for (const page of pages) {
        if (page.label) embedded[page.index] = page.label;
    }
    return resolveZoteroLocatorPageLabels({ pageCount: null, derived: derivedPageLabels, embedded });
}

/**
 * Build a compact lookup for every citable item and sentence id. Entries carry
 * the Zotero locator label of their page: from `derivedPageLabels`, or from
 * the labels the PDF declares (`page.label`) for a document without printed
 * labels.
 */
export function buildCitationIndex(
    pages: StructuredPage[],
    derivedPageLabels?: Record<string, string> | null,
): CitationIndex {
    const labels = locatorPageLabels(pages, derivedPageLabels);
    const index: CitationIndex = {};
    for (const page of pages) {
        const pageLabel = labels[page.index];
        for (const item of page.items) {
            index[item.id] = entryForItem(page, item, pageLabel);
            if (!("sentences" in item) || !item.sentences?.length) continue;
            for (const sentence of item.sentences) {
                index[sentence.id] = entryForSentence(page, item, sentence, pageLabel);
            }
        }
    }
    return index;
}

const citationIndexes = new WeakMap<StructuredDocument, CitationIndex>();

/**
 * Citation index for a document. The index is derived data and is not stored
 * in the document; it is built on first use and memoized per document object.
 */
export function getCitationIndex(document: StructuredDocument): CitationIndex {
    let index = citationIndexes.get(document);
    if (!index) {
        index = buildCitationIndex(document.pages, document.derivedPageLabels);
        citationIndexes.set(document, index);
    }
    return index;
}

/** Resolve a citable id to its page, owning item, optional sentence, and bboxes. */
export function resolveCitation(
    document: StructuredDocument,
    id: string,
): ResolvedCitation | undefined {
    const entry = getCitationIndex(document)[id];
    if (!entry) return undefined;
    const page = document.pages.find((p) => p.index === entry.pageIndex);
    if (!page) return undefined;
    const item = page.items.find((candidate) => candidate.id === entry.itemId);
    if (!item) return undefined;
    const sentence = entry.sentenceId && "sentences" in item
        ? item.sentences?.find((candidate) => candidate.id === entry.sentenceId)
        : undefined;
    return {
        pageIndex: page.index,
        pageLabel: entry.pageLabel,
        item,
        sentence,
        bboxes: sentence?.bboxes ?? [item.bbox],
    };
}
