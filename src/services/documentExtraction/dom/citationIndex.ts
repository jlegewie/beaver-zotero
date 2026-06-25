import type {
    DomCitationIndex,
    DomCitationIndexEntry,
    DomSection,
} from "./schema";

/** Build raw-id citation lookup entries for DOM items and sentences. */
export function buildDomCitationIndex(sections: DomSection[]): DomCitationIndex {
    const index: DomCitationIndex = {};

    for (const section of sections) {
        for (const item of section.items) {
            index[item.id] = {
                id: item.id,
                kind: "item",
                sectionIndex: section.index,
                itemId: item.id,
                anchorId: item.anchorId,
            };

            for (const sentence of item.sentences ?? []) {
                index[sentence.id] = {
                    id: sentence.id,
                    kind: "sentence",
                    sectionIndex: section.index,
                    itemId: item.id,
                    sentenceId: sentence.id,
                    anchorId: item.anchorId,
                };
            }
        }
    }

    return index;
}

/** Resolve a raw DOM item or sentence id from a citation index. */
export function resolveDomCitationId(
    index: DomCitationIndex,
    id: string,
): DomCitationIndexEntry | undefined {
    return index[id];
}
