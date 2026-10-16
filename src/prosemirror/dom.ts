/**
 * DOM provider for ProseMirror normalization.
 *
 * ProseMirror's schema (parseDOM/toDOM rules, DOMParser, DOMSerializer)
 * requires a DOM document. In Zotero's plugin context we use a window's
 * document to create a detached HTMLDocument, which avoids side effects on
 * the visible DOM.
 */

declare const Zotero: any;
declare const Services: any;

/**
 * A window to borrow DOM machinery from: Zotero's main window, else any open
 * window (the standalone Beaver window outlives the main windows), else the
 * application's hidden window. Null outside Zotero.
 */
export function getDomWindow(): Window | null {
    if (typeof Zotero !== 'undefined' && Zotero.getMainWindow) {
        const main = Zotero.getMainWindow();
        if (main?.document) return main;
    }
    const services = typeof Services !== 'undefined' ? Services : undefined;
    const open = services?.wm?.getMostRecentWindow?.(null);
    if (open?.document) return open;
    try {
        const hidden = services?.appShell?.hiddenDOMWindow;
        if (hidden?.document) return hidden;
    } catch {
        // No hidden window in this application.
    }
    return null;
}

export function getDocument(): Document {
    const win = getDomWindow();
    if (win) return win.document.implementation.createHTMLDocument('');
    // Fallback: global document (jsdom/browser test environments)
    // eslint-disable-next-line no-restricted-globals
    if (typeof document !== 'undefined') {
        // eslint-disable-next-line no-restricted-globals
        return document.implementation.createHTMLDocument('');
    }
    throw new Error('No DOM available for ProseMirror normalization — no window is open');
}
