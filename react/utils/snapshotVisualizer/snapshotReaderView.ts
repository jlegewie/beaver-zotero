/**
 * Typed access to the Zotero snapshot reader's primary DOM view. Unlike the EPUB
 * reader there are no spine sections — a snapshot is a single continuous DOM view
 * exposed through `_iframeDocument`.
 */

export type SnapshotAnnotationType = "highlight" | "underline" | "note";

/** Annotation shape the reader's `getAnnotationFromRange` returns for a snapshot. */
export interface SnapshotRangeAnnotation {
    type: SnapshotAnnotationType;
    color?: string;
    sortIndex: string;
    position: unknown;
    text?: string;
}

export interface SnapshotPrimaryView {
    _iframeWindow?: Window;
    _iframeDocument?: Document;
    /** Reading mode restructures the displayed DOM; selectors map back to the original. */
    _readingMode?: { enabled?: boolean };
    /** Reader-owned range-to-annotation builder. */
    getAnnotationFromRange?: (
        range: Range,
        type: SnapshotAnnotationType,
        color?: string,
    ) => SnapshotRangeAnnotation | null;
}

/** Return the live snapshot body element, or undefined when unavailable. */
export function getSnapshotBody(primaryView: SnapshotPrimaryView): HTMLElement | undefined {
    return primaryView._iframeDocument?.body ?? undefined;
}

/** True when the reader is currently displaying the Readability reading view. */
export function isSnapshotReadingModeEnabled(primaryView: SnapshotPrimaryView): boolean {
    return primaryView._readingMode?.enabled === true;
}

/** Build reader annotation metadata for a live DOM range. */
export function annotationFromRange(
    primaryView: SnapshotPrimaryView,
    range: Range,
    type: SnapshotAnnotationType,
    color?: string,
): SnapshotRangeAnnotation | null {
    const getAnnotation = primaryView.getAnnotationFromRange;
    if (typeof getAnnotation !== "function") return null;
    return getAnnotation.call(primaryView, range, type, color);
}
