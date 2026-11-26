/** Finding the separate Beaver window. Free of UI imports, for plugin-realm services. */

export const BEAVER_WINDOW_NAME = 'beaver-separate-window';

/** The separate Beaver window, when one is open or opening. */
export function findBeaverWindow(): Window | undefined {
    const pending = Zotero.Beaver?.runtime?.standaloneWindow;
    if (pending && !pending.closed) return pending;
    try {
        const enumerator = Services.wm.getEnumerator('beaver:window');
        while (enumerator.hasMoreElements()) {
            const win = enumerator.getNext() as Window;
            if (!win.closed && win.name === BEAVER_WINDOW_NAME) return win;
        }
    } catch {
        // No window mediator: no window.
    }
    return undefined;
}
