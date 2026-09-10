/** Immutable reader metadata carried with an explicit reader action. */
export interface ReaderActionLocation {
    contentKind: 'pdf' | 'epub' | 'snapshot';
    currentPage: number | null;
}

export function captureReaderActionLocation(reader: any): ReaderActionLocation | undefined {
    const contentKind = reader?.type;
    if (contentKind !== 'pdf' && contentKind !== 'epub' && contentKind !== 'snapshot') return undefined;
    let currentPage: number | null = null;
    try {
        const view = reader._internalReader?._primaryView;
        if (contentKind === 'pdf') {
            currentPage = view?._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber || null;
        } else if (contentKind === 'epub' && view?.pageMapping && view?.flow?.startRange) {
            const index = view.pageMapping.getPageIndex(view.flow.startRange);
            if (typeof index === 'number') currentPage = index + 1;
        }
    } catch {
        // Preserve the kind even if a reader is closing or its page is not ready.
    }
    return { contentKind, currentPage };
}
