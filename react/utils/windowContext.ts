/**
 * Get the window object that contains a given DOM element.
 * 
 * This is essential for components that render in multiple windows (main window,
 * separate Beaver window) where Zotero.getMainWindow() would return the wrong window.
 * 
 * @param element - A DOM element (typically from a ref)
 * @returns The window containing the element, or falls back to Zotero.getMainWindow()
 */
export function getWindowFromElement(element: Element | null): Window {
    if (element && element.ownerDocument && element.ownerDocument.defaultView) {
        return element.ownerDocument.defaultView;
    }
    // Fallback to main window if element is not available
    return Zotero.getMainWindow();
}

/**
 * Get the document object that contains a given DOM element.
 * 
 * @param element - A DOM element (typically from a ref)
 * @returns The document containing the element, or falls back to main window's document
 */
export function getDocumentFromElement(element: Element | null): Document {
    if (element && element.ownerDocument) {
        return element.ownerDocument;
    }
    // Fallback to main window document if element is not available
    return Zotero.getMainWindow().document;
}

