import {
    closestElement,
    getUniqueSelectorContaining,
    iterateWalker,
    textPositionFromRange,
    type CssSelector,
    type SnapshotSelector,
} from "./vendor/readerSelectors";

/**
 * Snapshot annotation position + sortIndex helpers.
 *
 * The Zotero reader stores a snapshot annotation's location as a Web Annotation
 * `CssSelector` (optionally refined by a `TextPositionSelector`), or a bare
 * `TextPositionSelector` fallback, serialized to JSON in `annotationPosition`.
 * `sortIndex` is a 7-digit zero-padded count of trimmed text characters from the
 * body to the annotation start.
 *
 * These replicate `SnapshotView.toSelector` and `_getSortIndex`
 * (reader/src/dom/snapshot/snapshot-view.ts) byte-for-byte, minus the reading-mode
 * remapping: the reader maps a focus-DOM range back to the original DOM before
 * computing the stored selector, and the headless resolver already operates on the
 * original DOM, so the stored output is identical.
 */

export type { SnapshotSelector } from "./vendor/readerSelectors";

const ELEMENT_NODE = 1;
const SHOW_TEXT = 0x4;
// reader/src/dom/snapshot/defines.ts SORT_INDEX_LENGTH.
const SORT_INDEX_LENGTH = 7;

/** Convert a DOM range to the snapshot annotation selector (Css + optional TextPosition). */
export function toSnapshotSelector(range: Range): SnapshotSelector | null {
    const doc = range.commonAncestorContainer.ownerDocument;
    if (!doc) return null;

    let targetNode: Node;
    // In most cases the range wraps a single child of the commonAncestorContainer;
    // target that element, not the container.
    if (range.startContainer === range.endContainer
            && range.startOffset == range.endOffset - 1
            && range.startContainer.nodeType == ELEMENT_NODE) {
        targetNode = range.startContainer.childNodes[range.startOffset];
    } else {
        targetNode = range.commonAncestorContainer;
    }

    const targetElement = closestElement(targetNode);
    if (!targetElement) return null;

    const targetElementQuery = getUniqueSelectorContaining(targetElement);
    if (targetElementQuery) {
        const selector: CssSelector = {
            type: "CssSelector",
            value: targetElementQuery,
        };
        // Skip the TextPositionSelector when the range covers the element's full text.
        if (range.toString().trim() !== (targetElement.textContent || "").trim()) {
            selector.refinedBy = textPositionFromRange(range, targetElement) || undefined;
        }
        return selector;
    }

    const body = doc.body;
    return body ? textPositionFromRange(range, body) : null;
}

/** Compute the 7-digit snapshot sortIndex for a range, relative to `body`. */
export function buildSnapshotSortIndex(range: Range, body: Node): string {
    const getCount = (root: Node, stopContainer?: Node, stopOffset?: number): number => {
        const iter = root.ownerDocument!.createNodeIterator(root, SHOW_TEXT);
        let count = 0;
        for (const node of iterateWalker(iter)) {
            if (stopContainer?.contains(node)) {
                return count + (stopOffset ?? 0);
            }
            count += (node.nodeValue ?? "").trim().length;
        }
        return 0;
    };

    const count = getCount(body, range.startContainer, range.startOffset);
    let countString = String(count).padStart(SORT_INDEX_LENGTH, "0");
    if (countString.length > SORT_INDEX_LENGTH) {
        countString = countString.substring(0, SORT_INDEX_LENGTH);
    }
    return countString;
}
