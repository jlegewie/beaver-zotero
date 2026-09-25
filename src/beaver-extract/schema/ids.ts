import type { DocumentItem, StructuredPage } from "@beaver/agent-core/extract/schema";
import { ID_PREFIXES } from "@beaver/agent-core/extract/schema";
import { formatExtractId, type ExtractIdScheme } from "@beaver/agent-core/extract/ids";

function sortedItems(page: StructuredPage): DocumentItem[] {
    return [...page.items].sort((a, b) => a.order - b.order);
}

/**
 * Assign deterministic item and sentence ids in reading order.
 *
 * Each kind prefix has its own counter. Under the `document` scheme the
 * counters run across the whole document; under the `page` scheme they restart
 * on every page and the id carries the 1-based physical page. Items are
 * numbered before sentences; sentences are numbered across the items of a
 * page (document) in item order, then sentence order.
 */
export function assignDocumentIds(pages: StructuredPage[], scheme: ExtractIdScheme): void {
    const counters = new Map<string, number>();
    const nextId = (prefix: string, page: StructuredPage): string => {
        const key = scheme === "page" ? `${page.index}:${prefix}` : prefix;
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return formatExtractId(prefix, next, scheme === "page" ? page.index + 1 : undefined);
    };

    const sortedPages = [...pages].sort((a, b) => a.index - b.index);
    for (const page of sortedPages) {
        for (const item of sortedItems(page)) {
            item.id = nextId(ID_PREFIXES[item.kind], page);
        }
    }

    for (const page of sortedPages) {
        for (const item of sortedItems(page)) {
            if (!("sentences" in item) || !item.sentences?.length) continue;
            for (const sentence of [...item.sentences].sort((a, b) => a.order - b.order)) {
                sentence.id = nextId(ID_PREFIXES.sentence, page);
            }
        }
    }
}
