import type {
    EpubCitationIndex,
    EpubCitationIndexEntry,
    EpubSection,
} from "./schema";

/** Build raw-id citation lookup entries for EPUB items and sentences. */
export function buildEpubCitationIndex(sections: EpubSection[]): EpubCitationIndex {
    const index: EpubCitationIndex = {};

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

/** Resolve a raw EPUB item or sentence id from a citation index. */
export function resolveEpubCitationId(
    index: EpubCitationIndex,
    id: string,
): EpubCitationIndexEntry | undefined {
    return index[id];
}
