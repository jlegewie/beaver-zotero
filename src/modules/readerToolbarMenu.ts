/**
 * Reader toolbar dropdown menu: adds a Beaver button to the PDF reader toolbar.
 *
 * On click the button opens a XUL menupopup with:
 *   1. "Ask Beaver"          — opens sidebar & focuses input
 *   2. Attachment actions     — same customisable list as the library context menu
 *   3. "Add custom action…"  — opens Preferences → Actions tab
 *
 * Lives in the esbuild bundle — must NOT import from react/store or Jotai.
 */

import { getMergedActions } from './zoteroContextMenu';
import { openPreferencesWindow } from '../ui/openPreferencesWindow';

// Module-level handler reference for cleanup
let toolbarHandler: ((event: any) => void) | null = null;

// Cached SVG strings fetched at init time
let cachedIconSvg: string | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ICON_URL = 'chrome://beaver/content/icons/beaver_bw.png';

// Inline SVG dropmarker matching the reader's IconChevronDown8 (8x8, currentColor)
const DROPMARKER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" fill="none"><path fill="currentColor" d="m0 2.707 4 4 4-4L7.293 2 4 5.293.707 2z"/></svg>`;

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------

/**
 * Build an inline SVG that embeds the PNG icon via an <image> element.
 * This avoids <img> border issues in the reader iframe.
 */
function buildIconSvg(dataUri: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="16" height="16" viewBox="0 0 16 16"><image width="16" height="16" xlink:href="${dataUri}"/></svg>`;
}

/** Fetch PNG as a data URI and cache the resulting SVG wrapper. */
async function cacheIcon(): Promise<void> {
    if (cachedIconSvg) return;
    try {
        const resp = await Zotero.HTTP.request('GET', ICON_URL, { responseType: 'arraybuffer' });
        const bytes = new Uint8Array(resp.response as ArrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const b64 = btoa(binary);
        cachedIconSvg = buildIconSvg(`data:image/png;base64,${b64}`);
    } catch (_e) {
        // Fallback: reference the chrome URL directly (may not render in iframe)
        cachedIconSvg = buildIconSvg(ICON_URL);
    }
}

// ---------------------------------------------------------------------------
// Toolbar handler
// ---------------------------------------------------------------------------

function onRenderToolbar(event: any): void {
    const { reader, doc, append } = event;

    // Create button using the same pattern as zotero-actions-tags:
    // classList + innerHTML with inline SVG content
    const button = doc.createElement('button');
    button.className = 'toolbar-button toolbar-dropdown-button';
    button.title = 'Beaver';
    button.tabIndex = -1;

    // Inject icon + dropmarker as innerHTML (no <img> elements)
    button.innerHTML = `${cachedIconSvg || ''}${DROPMARKER_SVG}`;

    button.addEventListener('click', () => {
        openBeaverMenu(reader, button);
    });

    append(button);
}

// ---------------------------------------------------------------------------
// Menu builder
// ---------------------------------------------------------------------------

function openBeaverMenu(reader: any, anchorButton: HTMLElement): void {
    const win = reader._window;
    const popupset = reader._popupset;
    const iframe = reader._iframe;
    if (!win || !popupset || !iframe) return;

    const xulDoc = win.document;
    const popup = xulDoc.createXULElement('menupopup');
    popupset.appendChild(popup);

    // Auto-cleanup
    popup.addEventListener('popuphidden', () => popup.remove());

    // ---- Ask Beaver ----
    const askItem = xulDoc.createXULElement('menuitem');
    askItem.setAttribute('label', 'Ask Beaver');
    askItem.addEventListener('command', () => {
        const mainWin = Zotero.getMainWindow();
        const eventBus = mainWin?.__beaverEventBus;
        if (!eventBus) return;
        eventBus.dispatchEvent(new mainWin.CustomEvent('toggleChat', {
            detail: { forceOpen: true },
        }));
        setTimeout(() => {
            eventBus.dispatchEvent(new mainWin.CustomEvent('focusInput', {
                detail: {},
            }));
        }, 100);
    });
    popup.appendChild(askItem);

    // ---- Actions section (attachment actions, PDF only) ----
    const isPdf = reader.type === 'pdf';
    const readerItemID: number | undefined = reader.itemID;

    if (isPdf) {
        const actions = getMergedActions().filter(a => a.targetType === 'attachment');

        if (actions.length > 0) {
            popup.appendChild(xulDoc.createXULElement('menuseparator'));

            // Disabled header
            const header = xulDoc.createXULElement('menuitem');
            header.setAttribute('label', 'Actions');
            header.setAttribute('disabled', 'true');
            popup.appendChild(header);

            for (const action of actions) {
                const menuitem = xulDoc.createXULElement('menuitem');
                menuitem.setAttribute('label', action.title);
                menuitem.addEventListener('command', () => {
                    const mainWin = Zotero.getMainWindow();
                    const eventBus = mainWin?.__beaverEventBus;
                    if (!eventBus) return;
                    eventBus.dispatchEvent(new mainWin.CustomEvent('contextMenuAction', {
                        detail: {
                            actionId: action.id,
                            actionText: action.text,
                            targetType: 'attachment',
                            itemIds: readerItemID ? [readerItemID] : [],
                            collectionId: null,
                        },
                    }));
                });
                popup.appendChild(menuitem);
            }
        }
    }

    // ---- Add custom action… ----
    popup.appendChild(xulDoc.createXULElement('menuseparator'));

    const addItem = xulDoc.createXULElement('menuitem');
    addItem.setAttribute('label', 'Add custom action\u2026');
    addItem.addEventListener('command', () => {
        openPreferencesWindow('actions');
    });
    popup.appendChild(addItem);

    // ---- Position & open ----
    const btnRect = anchorButton.getBoundingClientRect();
    const iframeRect = iframe.getBoundingClientRect();
    const screenRect = win.windowUtils.toScreenRectInCSSUnits(
        iframeRect.x + btnRect.left,
        iframeRect.y + btnRect.bottom,
        0,
        0,
    );
    setTimeout(() => popup.openPopupAtScreen(screenRect.x, screenRect.y, true));
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

function removeListenerSafely(type: string, handler: (event: unknown) => void): boolean {
    const reader = Zotero?.Reader as any;
    const listeners = reader?._registeredListeners;
    if (!Array.isArray(listeners)) return false;
    reader._registeredListeners = listeners.filter(
        (l: any) => !(l?.type === type && l?.handler === handler),
    );
    return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function initReaderToolbarMenu(): Promise<void> {
    if (typeof Zotero?.Reader?.registerEventListener !== 'function') {
        ztoolkit.log('readerToolbarMenu: Reader API not available, skipping');
        return;
    }

    // Clean up any previous listener (e.g. plugin reload)
    cleanupReaderToolbarMenu();

    // Cache the icon before registering so it's available synchronously in the handler
    await cacheIcon();

    toolbarHandler = onRenderToolbar;
    Zotero.Reader.registerEventListener('renderToolbar', toolbarHandler, addon.data.config.addonID);
    ztoolkit.log('readerToolbarMenu: Registered renderToolbar listener');
}

export function cleanupReaderToolbarMenu(): void {
    if (toolbarHandler) {
        removeListenerSafely('renderToolbar', toolbarHandler);
        toolbarHandler = null;
    }
}
