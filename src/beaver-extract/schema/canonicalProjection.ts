import type { DocItem, SentenceItem } from "../types";
import { bboxToRect } from "./bbox";
import type {
    DebugSentenceFragment,
    DocumentItem,
    Sentence,
    StructuredPage,
} from "./schema";

interface InternalPageForProjection {
    index: number;
    label?: string;
    width: number;
    height: number;
    items: DocItem[];
    sentences?: SentenceItem[];
}

function sentenceFragments(
    sentence: SentenceItem,
    precision: number,
): DebugSentenceFragment[] | undefined {
    if (!sentence.fragments?.length) return undefined;
    return sentence.fragments.map((fragment) => ({
        lineIndex: fragment.lineIndex,
        text: fragment.text,
        bbox: bboxToRect(fragment.bbox, precision),
    }));
}

function projectSentence(
    sentence: SentenceItem,
    pageIndex: number,
    order: number,
    precision: number,
): Sentence {
    return {
        id: sentence.parentId
            ? `${sentence.parentId}:s${sentence.index + 1}`
            : `s${order + 1}`,
        itemId: sentence.parentId,
        pageIndex,
        order,
        text: sentence.text,
        bboxes: sentence.bboxes.map((bbox) => bboxToRect(bbox, precision)),
        ...(sentenceFragments(sentence, precision)
            ? { fragments: sentenceFragments(sentence, precision) }
            : {}),
        ...(sentence.joinWithNext ? { joinWithNext: true } : {}),
    };
}

function projectBase(item: DocItem, precision: number) {
    return {
        id: item.id,
        pageIndex: item.pageIndex,
        order: item.index,
        bboxes: [bboxToRect(item.bbox, precision)],
    };
}

function attachSentences(
    publicItem: DocumentItem,
    internalItem: DocItem,
    sentencesByParent: Map<string, SentenceItem[]>,
    precision: number,
): DocumentItem {
    if (
        publicItem.kind !== "text" &&
        publicItem.kind !== "caption" &&
        publicItem.kind !== "footnote" &&
        publicItem.kind !== "list_item"
    ) {
        return publicItem;
    }
    const sourceSentences = sentencesByParent.get(internalItem.id) ?? [];
    if (sourceSentences.length === 0) return publicItem;
    const sentences = sourceSentences.map((sentence, index) =>
        projectSentence(sentence, internalItem.pageIndex, index, precision),
    );
    return { ...publicItem, sentences } as DocumentItem;
}

/** Convert the internal pipeline page into the canonical structured page. */
export function projectStructuredPage(
    page: InternalPageForProjection,
    bboxPrecision = 1,
): StructuredPage {
    const sentencesByParent = new Map<string, SentenceItem[]>();
    for (const sentence of page.sentences ?? []) {
        const list = sentencesByParent.get(sentence.parentId) ?? [];
        list.push(sentence);
        sentencesByParent.set(sentence.parentId, list);
    }

    const items: DocumentItem[] = page.items.map((item) => {
        const base = projectBase(item, bboxPrecision);
        switch (item.kind) {
            case "text":
                return attachSentences({
                    ...base,
                    kind: "text",
                    text: item.text,
                }, item, sentencesByParent, bboxPrecision);
            case "section_header":
                return {
                    ...base,
                    kind: "section_header",
                    text: item.text,
                    level: item.level,
                };
            case "margin":
                return {
                    ...base,
                    kind: "margin",
                    text: item.text,
                };
            case "caption":
            case "footnote":
            case "list_item":
                return attachSentences({
                    ...base,
                    kind: item.kind,
                    text: item.text,
                } as DocumentItem, item, sentencesByParent, bboxPrecision);
            case "formula":
                return {
                    ...base,
                    kind: "formula",
                    text: item.text,
                };
            case "table":
                return { ...base, kind: "table" };
            case "picture":
                return { ...base, kind: "picture" };
        }
    });

    return {
        index: page.index,
        label: page.label,
        width: page.width,
        height: page.height,
        items,
    };
}
