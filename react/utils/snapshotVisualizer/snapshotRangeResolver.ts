import {
    citationSearchTextCandidates,
    createSentenceRange,
    findAnchorElement,
} from "../../../src/services/documentExtraction/dom/textRange";

export interface SnapshotCitationTarget {
    /** DOM id of the cited element, when known. */
    anchorId?: string;
    /** Cited passage text used to locate a precise range. */
    text?: string;
}

/**
 * Resolve a cited passage to a live DOM range inside the snapshot reader body.
 * Searches the anchor element first (when given), then the whole body. Matching
 * is whitespace-normalized, so the range survives inline markup splitting the
 * sentence. Returns null when nothing matches.
 */
export function resolveSnapshotCitationRange(
    body: HTMLElement,
    target: SnapshotCitationTarget,
): Range | null {
    const searchTexts = citationSearchTextCandidates(target.text);
    if (searchTexts.length === 0) return null;

    const anchorElement = target.anchorId ? findAnchorElement(body, target.anchorId) : undefined;

    let range: Range | undefined;
    if (anchorElement) {
        for (const searchText of searchTexts) {
            range = createSentenceRange(anchorElement, searchText);
            if (range) break;
        }
    }
    if (!range) {
        for (const searchText of searchTexts) {
            range = createSentenceRange(body, searchText);
            if (range) break;
        }
    }
    return range ?? null;
}
