import type { DocumentItem, StructuredPage } from "./schema";
import { ID_PREFIXES } from "./schema";

function sortedItems(page: StructuredPage): DocumentItem[] {
    return [...page.items].sort((a, b) => a.order - b.order);
}

/** Assign deterministic document-wide item and sentence ids in reading order. */
export function assignDocumentIds(pages: StructuredPage[]): void {
    const counters = new Map<string, number>();
    const nextId = (prefix: string): string => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}${next}`;
    };

    const sortedPages = [...pages].sort((a, b) => a.index - b.index);
    for (const page of sortedPages) {
        for (const item of sortedItems(page)) {
            item.id = nextId(ID_PREFIXES[item.kind]);
        }
    }

    for (const page of sortedPages) {
        for (const item of sortedItems(page)) {
            if (!("sentences" in item) || !item.sentences?.length) continue;
            for (const sentence of [...item.sentences].sort((a, b) => a.order - b.order)) {
                sentence.id = nextId(ID_PREFIXES.sentence);
            }
        }
    }
}
