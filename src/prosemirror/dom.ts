/**
 * DOM provider for ProseMirror normalization.
 *
 * ProseMirror's schema (parseDOM/toDOM rules, DOMParser, DOMSerializer)
 * requires a DOM document. In Zotero's plugin context we use the main
 * window's document to create a detached HTMLDocument, which avoids
 * side effects on the visible DOM.
 */

declare const Zotero: any;

export function getDocument(): Document {
    // Primary: Zotero main window (plugin runtime)
    if (typeof Zotero !== 'undefined' && Zotero.getMainWindow) {
        const win = Zotero.getMainWindow();
        if (win?.document) {
            return win.document.implementation.createHTMLDocument('');
        }
    }
    // Fallback: global document (jsdom/browser test environments)
    if (typeof document !== 'undefined') {
        return document.implementation.createHTMLDocument('');
    }
    throw new Error('No DOM available for ProseMirror normalization — main window not open');
}
