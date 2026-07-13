export interface ComposerSelection {
    anchor: number;
    focus: number;
    anchorType?: 'text' | 'element';
    focusType?: 'text' | 'element';
}

type ComposerSelectionProvider = () => ComposerSelection | null;

const selectionProviders = new WeakMap<
    HTMLElement,
    ComposerSelectionProvider
>();
const windowTokens = new WeakMap<Window, object>();

/** Stable window identity that does not retain the Window realm when stored. */
export function getComposerWindowToken(win: Window): object {
    let token = windowTokens.get(win);
    if (!token) {
        token = {};
        windowTokens.set(win, token);
    }
    return token;
}

/**
 * Registers the editor-owned selection reader for a composer element.
 *
 * Host adapters use the element as an opaque handle when they need to carry
 * focus across a host-level view transition. Keeping the reader in a WeakMap
 * avoids putting implementation details on the DOM node itself.
 */
export function registerComposerSelectionProvider(
    element: HTMLElement,
    provider: ComposerSelectionProvider,
): () => void {
    selectionProviders.set(element, provider);
    return () => {
        if (selectionProviders.get(element) === provider) {
            selectionProviders.delete(element);
        }
    };
}

export function captureComposerSelection(
    element: HTMLElement,
): ComposerSelection | null {
    return selectionProviders.get(element)?.() ?? null;
}
