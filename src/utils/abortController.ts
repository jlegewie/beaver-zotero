/**
 * Create an AbortController in Zotero scopes where web platform constructors
 * may live on the main window instead of the current global.
 */
export function createAbortController(): AbortController {
    const globalCtor = typeof globalThis.AbortController === 'function'
        ? globalThis.AbortController
        : null;
    if (globalCtor) {
        return new globalCtor();
    }

    const mainWindow = typeof Zotero !== 'undefined' && typeof Zotero.getMainWindow === 'function'
        ? Zotero.getMainWindow()
        : null;
    const windowCtor = mainWindow && typeof mainWindow.AbortController === 'function'
        ? mainWindow.AbortController
        : null;
    if (windowCtor) {
        return new windowCtor();
    }

    throw new Error('AbortController is not available in this runtime');
}
