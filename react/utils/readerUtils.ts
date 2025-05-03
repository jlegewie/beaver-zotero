import { createSourceIdentifier } from './sourceUtils';
import { TextSelection } from '../types/attachments/apiTypes';


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
 * Navigates to a page in the reader.
 * 
 * @param itemID - The item ID.
 * @param page - The page number to navigate to.
 */
async function navigateToPage(itemID: number, page: number) {
    await Zotero.Reader.open(itemID, {pageIndex: page - 1})
}

async function navigateToPageInCurrentReader(page: number) {
    const reader = getCurrentReader();
    if (!reader) return;
    await Zotero.Reader.open(reader.itemID, {pageIndex: page - 1})
    // TODO: Use smooth scroll to page
    // const window = Zotero.getMainWindow();
    // const reader = Zotero.Reader.getByTabID(window.Zotero_Tabs.selectedID);
    // await reader._internalReader._primaryView.navigate({
    //     pageIndex: page  // Zero-based, so this will go to page 1
    // })
}

async function navigateToAnnotation(reader: any, annotation: Zotero.Item) {
    // const window = Zotero.getMainWindow();
    // const reader = Zotero.Reader.getByTabID(window.Zotero_Tabs.selectedID);
    // return await reader.navigate({annotationID: reader.annotationItemIDs[2]})
    reader.navigate({annotationID: annotation.id});
    // reader.setSelectedAnnotations([annotations[0].id])
    // await Zotero.Reader.open(reader.itemID, {annotationID: reader.annotationItemIDs[0]})
}


/**
 * Retrieves the annotations of the current reader.
 * 
 * @param reader - The reader instance.
 * @returns The annotations.
 */
function getCurrentReaderAnnotations(reader: any) {
    return reader.annotationItemIDs || [];
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
function getSelectedText(reader?: _ZoteroTypes.Reader): string | null {    
    try {
        // Get reader
        reader = reader || getCurrentReader();
        if (!reader || reader.type !== 'pdf') return null;

        // Access primaryView
        const primaryView = reader._internalReader._primaryView;
        
        // Get text selection
        const hasSelection = primaryView._selectionRanges.length > 0
        if (!hasSelection) return null;
        // const selection = primaryView._selectionRanges[0].text;
        const selection = primaryView._selectionRanges.map((range: any) => range.text).join('\n\n');
        if (!selection) return null;
        return selection;

        // Access the PDF.js iframe window
        // const iframeWindow = primaryView._iframeWindow;
        // const selection = iframeWindow.getSelection();
        // return selection.toString();
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
        page: getCurrentPage(reader)
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

function addSelectionChangeListener(reader: any, callback: (selection: TextSelection | null) => void) {
    if (reader.type !== "pdf") {
        return null;
    }
    try {
        // Handle initial selection
        const selection = getSelectedTextAsTextSelection(reader);
        if (selection) callback(selection);
                
        // Define the event handler for selection changes
        const handleSelectionChange = () => {
            const selection = getSelectedTextAsTextSelection(reader);
            if (selection) {
                callback(selection);
            } else {
                callback(null);
            }
        };
        
        // Add the event listener
        reader._internalReader._primaryView._iframeWindow.document.addEventListener(
            "selectionchange",
            handleSelectionChange,
        );
        
        // Return a function to remove the event listener when no longer needed
        return () => {
            reader._internalReader._primaryView._iframeWindow.document.removeEventListener(
                "selectionchange",
                handleSelectionChange,
            );
        };
    } catch (e) {
        console.error("Error setting up selection listener:", e);
        return null;
    }
}

export { getCurrentReader, getCurrentPage, navigateToPage, getSelectedText, getCurrentItem, addSelectionChangeListener, getSelectedTextAsTextSelection, navigateToPageInCurrentReader, navigateToAnnotation };

