import type {
    CitationIndex,
    CitationIndexEntry,
    DocumentItem,
    Rect,
    Sentence,
    StructuredDocument,
    StructuredPage,
} from "./schema";

export interface ResolvedCitation {
    pageIndex: number;
    pageLabel?: string;
    item: DocumentItem;
    sentence?: Sentence;
    bboxes: Rect[];
}

function entryForItem(page: StructuredPage, item: DocumentItem): CitationIndexEntry {
    return {
        id: item.id,
        kind: "item",
        pageIndex: page.index,
        pageLabel: page.label,
        itemId: item.id,
    };
}

function entryForSentence(
    page: StructuredPage,
    item: DocumentItem,
    sentence: Sentence,
): CitationIndexEntry {
    return {
        id: sentence.id,
        kind: "sentence",
        pageIndex: page.index,
        pageLabel: page.label,
        itemId: item.id,
        sentenceId: sentence.id,
    };
}

/** Build a compact lookup for every citable item and sentence id. */
export function buildCitationIndex(pages: StructuredPage[]): CitationIndex {
    const index: CitationIndex = {};
    for (const page of pages) {
        for (const item of page.items) {
            index[item.id] = entryForItem(page, item);
            if (!("sentences" in item) || !item.sentences?.length) continue;
            for (const sentence of item.sentences) {
                index[sentence.id] = entryForSentence(page, item, sentence);
            }
        }
    }
    return index;
}

/** Resolve a citable id to its page, owning item, optional sentence, and bboxes. */
export function resolveCitation(
    document: StructuredDocument,
    id: string,
): ResolvedCitation | undefined {
    const entry = document.citationIndex[id];
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
        pageLabel: page.label,
        item,
        sentence,
        bboxes: sentence?.bboxes ?? item.bboxes,
    };
}
