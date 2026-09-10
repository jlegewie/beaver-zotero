import { store } from '../store';
import { addPopupMessageAtom } from './popupMessageUtils';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';

/** Report an activation failure only to the live renderer that initiated it. */
export function notifyNavigationUnavailable(target: Window): void {
    const runtime = tryGetWindowRuntime();
    if (!runtime || runtime.contextWindow !== target || target.closed) return;
    store.set(addPopupMessageAtom, {
        id: 'navigation-window-unavailable',
        type: 'warning',
        title: 'Could not open this item',
        text: 'Bring this Zotero window to the front, then try again.',
    });
}
