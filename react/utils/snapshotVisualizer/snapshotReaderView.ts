/**
 * Typed access to the Zotero snapshot reader's primary DOM view. Unlike the EPUB
 * reader there are no spine sections — a snapshot is a single continuous DOM view
 * exposed through `_iframeDocument`.
 */
export interface SnapshotPrimaryView {
    _iframeWindow?: Window;
    _iframeDocument?: Document;
}

/** Return the live snapshot body element, or undefined when unavailable. */
export function getSnapshotBody(primaryView: SnapshotPrimaryView): HTMLElement | undefined {
    return primaryView._iframeDocument?.body ?? undefined;
}
