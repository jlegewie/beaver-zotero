import { TextSelection } from '../types/attachments/apiTypes';
import { logger } from '../../src/utils/logger';
import { ZoteroReader } from './annotationUtils';
import { waitForPDFDocument } from './pdfUtils';


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
 * @param waitForPDF - If true, also waits for the PDF document to be loaded (default: false for backwards compatibility)
 * @returns The current reader instance or undefined if no reader is found.
 */
async function getCurrentReaderAndWaitForView(window?: Window, waitForPDF: boolean = false): Promise<any | undefined> {
    // Get reader
    const reader = getCurrentReader(window)
    if (!reader) return undefined;

    await waitForReaderView(reader, waitForPDF);
    return reader;
}

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a reader instance and its primary view to be ready for navigation.
 */
async function waitForReaderView(reader: any, waitForPDF: boolean = false): Promise<void> {
    await reader?._initPromise;
    await reader?._internalReader?._primaryView?.initializedPromise;

    if (waitForPDF && reader?.type === 'pdf') {
        const pdfLoaded = await waitForPDFDocument(reader, 3000);
        if (!pdfLoaded) {
            logger(`waitForReaderView: PDF document failed to load within timeout`, 1);
        }
    }
}

/**
 * Waits for Zotero.Reader.open() to produce or select a reader for an item.
 */
async function waitForReaderForItem(itemID: number, openedReader?: any, timeoutMs: number = 5000): Promise<any | undefined> {
    if (openedReader?.itemID === itemID) {
        await waitForReaderView(openedReader, true);
        return openedReader;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const reader = getCurrentReader();
        if (reader?.itemID === itemID) {
            await waitForReaderView(reader, true);
            return reader;
        }
        await delay(100);
    }

    return undefined;
}

function getAnnotationPageIndex(annotationItem: Zotero.Item): number | undefined {
    try {
        const position = JSON.parse((annotationItem as any).annotationPosition || '{}');
        return typeof position?.pageIndex === 'number' ? position.pageIndex : undefined;
    } catch {
        return undefined;
    }
}

function isAnnotationLoadedInReader(reader: any, annotationID: string): boolean | null {
    const annotationLists = [
        reader?._internalReader?._state?.annotations,
        reader?._internalReader?._primaryView?._annotations,
    ].filter(Array.isArray);

    if (annotationLists.length === 0) return null;
    return annotationLists.some((annotations) => annotations.some((annotation: any) => annotation?.id === annotationID));
}

/**
 * Navigates to an annotation once the reader has had time to load and render it.
 */
async function navigateReaderToAnnotation(reader: any, annotationID: string, pageIndex?: number): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt++) {
        const annotationLoaded = isAnnotationLoadedInReader(reader, annotationID);
        if (annotationLoaded === false) {
            if (attempt === 1 && typeof pageIndex === 'number') {
                try {
                    await reader?.navigate?.({ pageIndex });
                } catch {
                    // Page navigation is a best-effort fallback before retrying annotation navigation.
                }
            }
            await delay(150);
            continue;
        }

        try {
            await reader?.navigate?.({ annotationID });
            return true;
        } catch {
            // Retry while the newly opened reader finishes registering annotations.
        }

        try {
            await reader?._internalReader?.navigate?.({ annotationID });
            return true;
        } catch {
            // Retry below.
        }

        if (attempt === 1 && typeof pageIndex === 'number') {
            try {
                await reader?.navigate?.({ pageIndex });
            } catch {
                // Page navigation is a best-effort fallback before retrying annotation navigation.
            }
        }

        await delay(150);
    }

    return false;
}

/**
 * Navigates to a page in the reader.
 * 
 * @param itemID - The item ID.
 * @param page - The page number to navigate to.
 */
async function navigateToPage(itemID: number, page: number): Promise<void | _ZoteroTypes.ReaderInstance> {
    const pageIndex = page - 1;
    const openedReader = await Zotero.Reader.open(itemID, {pageIndex})
    const reader = await waitForReaderForItem(itemID, openedReader);
    if (reader) {
        await reader.navigate?.({ pageIndex });
    }
    return reader;
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
    const parentID = annotationItem.parentID;
    if (!parentID) return;

    const annotationID = annotationItem.key;
    const pageIndex = getAnnotationPageIndex(annotationItem);
    // Get reader
    const reader = getCurrentReader();
    
    // Navigate to annotation if reader is open and current item is the annotation's parent
    if (reader && reader.itemID === parentID) {
        await waitForReaderView(reader, true);
        const didNavigate = await navigateReaderToAnnotation(reader, annotationID, pageIndex);
        if (!didNavigate && typeof pageIndex === 'number') {
            await reader.navigate?.({ pageIndex });
        }
        return;
    }

    // Open reader if not open
    const openedReader = await Zotero.Reader.open(parentID, {annotationID} as any);
    const openedOrSelectedReader = await waitForReaderForItem(parentID, openedReader);
    if (!openedOrSelectedReader) return;

    const didNavigate = await navigateReaderToAnnotation(openedOrSelectedReader, annotationID, pageIndex);
    if (!didNavigate) {
        if (typeof pageIndex === 'number') {
            await openedOrSelectedReader.navigate?.({ pageIndex });
        } else if (annotationItem.annotationPageLabel) {
            await openedOrSelectedReader.navigate?.({ pageLabel: annotationItem.annotationPageLabel });
        }
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
 * Retrieves the current reading position of the reader as a 1-based "page".
 *
 * For PDFs this is the current page number. For EPUBs it is the spine section
 * ordinal (section index + 1) of the section at the top of the viewport — the
 * same coordinate used as "page N" by reading and citation tools.
 *
 * @param reader - The reader instance.
 * @returns The 1-based position, or null for unsupported reader types.
 */
function getCurrentPage(reader?: any): number | null {
    if (!reader) reader = getCurrentReader();
    if (!reader) return null;
    if (reader.type === 'epub') {
        try {
            // The EPUB view's flow tracks the spine section at the top of the
            // viewport. Reader spine indexes count every spine itemref, while
            // extraction skips non-XHTML spine items — for such EPUBs this
            // ordinal can run ahead of the extraction section numbering.
            const sectionIndex = reader._internalReader?._primaryView?.flow?.startSection?.index;
            return typeof sectionIndex === 'number' ? sectionIndex + 1 : null;
        }
        catch (e) {
            console.error('Error getting current EPUB section:', e);
            return null;
        }
    }
    if (reader.type !== 'pdf') {
        return null;
    }

    try {
        // Access the PDF.js viewer instance
        const pdfViewer = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer;
        
        // Get the current page index (0-based)
        const currentPageIndex = pdfViewer.currentPageNumber - 1;
        
        // Return the 1-based page number (more user-friendly)
        return pdfViewer.currentPageNumber || null;
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
        if (!reader) return null;

        // EPUB (and other DOM-based) views expose the selection through the
        // content iframe's window selection rather than _selectionRanges.
        if (reader.type === 'epub') {
            const selection = (reader as any)._internalReader?._primaryView?._iframeWindow?.getSelection();
            const text = selection?.toString();
            return text?.trim() ? text : null;
        }
        if (reader.type !== 'pdf') return null;

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
 * Retrieves the item of the current reader.
 * 
 * @returns The item.
 */
async function getCurrentReaderItemAsync(win?: Window): Promise<Zotero.Item | null> {
    win = win || Zotero.getMainWindow();
    const selectedTabType = win.Zotero_Tabs.selectedType;
    if (selectedTabType !== 'reader') return null;
    const reader = getCurrentReader(win);
    if (!reader || !reader.itemID) return null;
    return await Zotero.Items.getAsync(reader.itemID);
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
    // PDF and EPUB views both render content into an iframe whose document
    // fires selectionchange; other reader types are not supported.
    if (reader.type !== "pdf" && reader.type !== "epub") {
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
 * Whether the given item is open as the *currently selected* tab in the main
 * window. Works for both reader tabs (attachments) and note tabs, since both
 * store the item ID on their tab data.
 *
 * Used to disable an "Open Attachment"/"Open Note" action only when the user is
 * already looking at that item. An item open in a background tab returns false
 * (re-opening it just switches to that tab).
 */
function isItemActiveTab(itemId: number): boolean {
    try {
        const tabs = Zotero.getMainWindow()?.Zotero_Tabs;
        if (!tabs) return false;
        const tabID = tabs.getTabIDByItemID?.(itemId);
        return !!tabID && tabID === tabs.selectedID;
    } catch {
        return false;
    }
}

/**
 * Ensures the reader is initialized.
 *
 * @param reader - The reader instance.
 */
async function ensureReaderInitialized(reader: ZoteroReader, waitForView: boolean = true): Promise<void> {
    try {
        if (reader && (reader as any)._initPromise) {
            await (reader as any)._initPromise;
            if (waitForView) {
                await (reader as any)._internalReader?._primaryView?.initializedPromise;
            }
        }
    } catch (error) {
        logger(`ensureReaderInitialized failed: ${error}`, 1);
    }
}

export {
    getCurrentReaderItemAsync,
    getCurrentReader,
    getCurrentReaderAndWaitForView,
    waitForReaderForItem,
    getCurrentPage,
    navigateToPage,
    getSelectedText,
    ensureReaderInitialized,
    getCurrentItem,
    addSelectionChangeListener,
    getSelectedTextAsTextSelection,
    navigateToPageInCurrentReader,
    navigateToAnnotation,
    isItemActiveTab
};
