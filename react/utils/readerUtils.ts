import { createSourceIdentifier } from './sourceUtils';

/**
 * Represents a text selection in the reader.
 */
interface TextSelection {
    text: string;
    page: number;
    hasSelection: boolean;
}


/**
 * Retrieves the current reader instance.
 * 
 * @returns The current reader instance or undefined if no reader is found.
 */
function getCurrentReader(window?: Window): any | undefined {
    window = window || Zotero.getMainWindow();
    const reader = Zotero.Reader.getByTabID(window.Zotero_Tabs.selectedID);
    return reader;
}

/**
 * Retrieves the current page number of the reader.
 * 
 * @param reader - The reader instance.
 * @returns The current page number or null if the reader is not a PDF reader.
 */
function getCurrentPage(reader?: any): number | null {
    if (!reader) reader = getCurrentReader();
    if (!reader) return null;
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

function getSelectedTextAsTextSelection(reader: any): TextSelection | null {
    const text = getSelectedText(reader);
    if (!text) return null;
    return {
        text,
        page: getCurrentPage(reader),
        hasSelection: !!text,
    } as TextSelection;
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
    libraryID: number;
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
            libraryID: item.libraryID,
            itemKey: item.key,
            page: getCurrentPage(reader),
            selection: getSelectedText(reader),
            identifier: createSourceIdentifier(item),
            itemType: type,
            reference: reference,
        } as ReaderContext;
    }
    return context;
}

function addSelectionChangeListener(reader: any, callback: (selection: TextSelection) => void) {
    if (reader.type !== "pdf") {
        return null;
    }
    try {
        // Access the PDF.js iframe window
        const iframeWindow = reader._internalReader._primaryView._iframeWindow;
        
        // Keep track of previous selection state
        let hadPreviousSelection = false;
        
        // Define the event handler function
        const handleSelectionChange = () => {
            const selection = iframeWindow.getSelection();
            const selectedText = selection.toString();
            
            // Call the callback in two cases:
            // 1. When text is selected
            // 2. When text was previously selected but now is empty (selection removed)
            if (selectedText) {
                hadPreviousSelection = true;
                callback({
                    text: selectedText,
                    page: iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber,
                    hasSelection: true
                } as TextSelection);
            } else if (hadPreviousSelection) {
                // TextSelection was removed
                hadPreviousSelection = false;
                callback({
                    text: "",
                    page: iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber,
                    hasSelection: false
                } as TextSelection);
            }
        };
        
        // Add the event listener
        iframeWindow.document.addEventListener(
            "selectionchange",
            handleSelectionChange,
        );
        
        // Return a function to remove the event listener when no longer needed
        return () => {
            iframeWindow.document.removeEventListener(
                "selectionchange",
                handleSelectionChange,
            );
        };
    } catch (e) {
        console.error("Error setting up selection listener:", e);
        return null;
    }
}

export { getCurrentReader, getCurrentPage, getSelectedText, getCurrentItem, getReaderContext, TextSelection, addSelectionChangeListener, getSelectedTextAsTextSelection };

