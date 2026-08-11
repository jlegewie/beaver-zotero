/**
 * Get the window that contains a given DOM element.
 *
 * The same components render into more than one window (in the Zotero client, a
 * sidebar in the main window and a separate Beaver window), so anything that
 * measures the viewport, attaches listeners, or portals must ask the element
 * which window it is in.
 *
 * There is deliberately no fallback to "the" window: a component that cannot
 * yet tell which window it belongs to must wait rather than guess, since
 * guessing is how a tooltip or menu ends up in the wrong window.
 *
 * @param element - A DOM element (typically from a ref)
 * @returns The window containing the element, or `null` when the element is
 *          absent or not attached to a document
 */
export function getWindowFromElement(element: Element | null): Window | null {
    return element?.ownerDocument?.defaultView ?? null;
}

/**
 * Get the document that contains a given DOM element.
 *
 * Like `getWindowFromElement`, this has no fallback — see the note there.
 *
 * @param element - A DOM element (typically from a ref)
 * @returns The document containing the element, or `null` when the element is
 *          absent or not attached to a document
 */
export function getDocumentFromElement(element: Element | null): Document | null {
    return element?.ownerDocument ?? null;
}
