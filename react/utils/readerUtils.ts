
/**
 * Retrieves the current reader instance.
 * 
 * @returns The current reader instance or undefined if no reader is found.
 */
function getCurrentReader(): any | undefined {
    const window = Zotero.getMainWindow();
    const reader = Zotero.Reader.getByTabID(window.Zotero_Tabs.selectedID);
    return reader;
}

/**
 * Retrieves the current page number of the reader.
 * 
 * @param reader - The reader instance.
 * @returns The current page number or null if the reader is not a PDF reader.
 */
function getCurrentPage(reader: any): number | null {
    if (reader.type !== 'pdf') {
        return null;
    }
    
    try {
        // Access the PDF.js viewer instance
        const pdfViewer = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer;
        
        // Get the current page index (0-based)
        const currentPageIndex = pdfViewer.currentPageNumber - 1;
        
        // Return the 1-based page number (more user-friendly)
        return pdfViewer.currentPageNumber;
    }
    catch (e) {
        console.error('Error getting current page:', e);
        return null;
    }
}

/**
 * Retrieves the selected text from the reader.
 * 
 * @param reader - The reader instance.
 * @returns The selected text or null if the reader is not a PDF reader.
 */
function getSelectedText(reader: any): string | null {
    if (reader.type !== 'pdf') {
        return null;
    }
    
    try {
        // Access the PDF.js iframe window
        const iframeWindow = reader._internalReader._primaryView._iframeWindow;
        
        // Get the current selection from the window
        const selection = iframeWindow.getSelection();
        
        // Return the selected text
        return selection.toString();
    }
    catch (e) {
        console.error('Error getting selected text:', e);
        return null;
    }
}

/**
 * Retrieves the item of the current reader.
 * 
 * @returns The item.
 */
function getCurrentItem(reader: any): Zotero.Item {
    return Zotero.Items.get(reader.itemID);
}


/**
 * Context for the reader.
 */
export type ReaderContext = {
    itemKey: string;
    page: number | null;
    identifier: string;
    itemType: string;
    reference: string | null;
    selection: string | null;
}


/**
 * Retrieves the reader context.
 * 
 * @returns The reader context.
 */
function getReaderContext(): ReaderContext | undefined {
    let context: ReaderContext | undefined;
    const reader = getCurrentReader();
    if (reader && reader.type === 'pdf') {
        const item = getCurrentItem(reader);
        const parentItem = item.parentItem;
        const reference = parentItem
            // @ts-ignore Beaver exists
            ? Zotero.Beaver.citationService.formatBibliography(parentItem)
            : null;
        const type = parentItem
            ? Zotero.ItemTypes.getLocalizedString(parentItem.itemType)
            : 'article, book, report or other document';
        context = {
            itemKey: item.key,
            page: getCurrentPage(reader),
            selection: getSelectedText(reader),
            identifier: `${item.libraryID}-${item.key}`,
            itemType: type,
            reference: reference,
        } as ReaderContext;
    }
    return context;
}


export { getCurrentReader, getCurrentPage, getSelectedText, getCurrentItem, getReaderContext };