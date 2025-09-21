import { createSourceIdentifier } from './sourceUtils';
import { TextSelection } from '../types/attachments/apiTypes';
import { logger } from '../../src/utils/logger';
import { ZoteroReader } from './annotationUtils';


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
 * Retrieves the current reader instance and waits for the view to be initialized.
 * 
 * @param window - The window to get the reader from.
 * @returns The current reader instance or undefined if no reader is found.
 */
async function getCurrentReaderAndWaitForView(window?: Window): Promise<any | undefined> {
    // Get reader
    const reader = getCurrentReader(window)
    if (!reader) return undefined;

    // Wait for reader to be initialized
    await reader._initPromise;
    await reader._internalReader?._primaryView?.initializedPromise;
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
    reader.navigate({pageIndex: page - 1})
}

/**
 * Navigates to an annotation in the current reader.
 * 
 * @param annotation - The annotation to navigate to.
 * @param reader - The reader instance.
 */
async function navigateToAnnotation(annotationItem: Zotero.Item) {
    if (!annotationItem.isAnnotation()) return;
    // Get reader
    const reader = getCurrentReader();
    
    // Navigate to annotation if reader is open and current item is the annotation's parent
    if (reader && reader.itemID === annotationItem.parentID) {
        reader.navigate({annotationID: annotationItem.key});
        return;
    }

    // Open reader if not open
    if (annotationItem.parentID) {
        await Zotero.Reader.open(annotationItem.parentID, {pageLabel: annotationItem.annotationPageLabel});
    }
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
    formatted_citation: string | null;
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

/**
 * Ensures the reader is initialized.
 * 
 * @param reader - The reader instance.
 */
async function ensureReaderInitialized(reader: ZoteroReader): Promise<void> {
    try {
        if (reader && (reader as any)._initPromise) {
            await (reader as any)._initPromise;
        }
    } catch (error) {
        logger(`ensureReaderInitialized failed: ${error}`, 1);
    }
}

/**
 * Ensures the PDF pages are available.
 * 
 * @param reader - The reader instance.
 */
async function ensurePdfPagesAvailable(reader: any): Promise<void> {
    const iframeWindow = reader?._internalReader?._primaryView?._iframeWindow;
    if (!iframeWindow) {
        throw new Error('Reader iframe window not found.');
    }

    let pdfViewer = iframeWindow.PDFViewerApplication?.pdfViewer;

    // The viewer might not be available immediately. Let's wait for it.
    let attempts = 0;
    while (!pdfViewer && attempts < 100) { // Wait up to 5 seconds
        await new Promise(resolve => setTimeout(resolve, 50));
        pdfViewer = iframeWindow.PDFViewerApplication?.pdfViewer;
        attempts++;
    }

    if (!pdfViewer) {
        throw new Error('PDF viewer not available.');
    }

    // `firstPagePromise` is a good signal that the document is loading.
    if (pdfViewer.firstPagePromise) {
        await pdfViewer.firstPagePromise;
    }

    // After the first page promise resolves, the `_pages` array should be populated.
    // We'll wait a bit just in case it's not immediate.
    attempts = 0;
    while ((!pdfViewer._pages || pdfViewer._pages.length === 0) && attempts < 50) { // Wait up to 2.5 seconds more
        await new Promise(resolve => setTimeout(resolve, 50));
        attempts++;
    }

    if (!pdfViewer._pages || pdfViewer._pages.length === 0) {
        throw new Error('PDF pages did not become available.');
    }
}

export {
    getCurrentReader,
    getCurrentReaderAndWaitForView,
    getCurrentPage,
    navigateToPage,
    getSelectedText,
    ensurePdfPagesAvailable,
    ensureReaderInitialized,
    getCurrentItem,
    addSelectionChangeListener,
    getSelectedTextAsTextSelection,
    navigateToPageInCurrentReader,
    navigateToAnnotation
};

