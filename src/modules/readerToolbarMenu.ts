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
import { ActionCategory } from '../../react/types/actions';

// Module-level handler reference for cleanup
let toolbarHandler: ((event: any) => void) | null = null;

// Cached SVG strings fetched at init time
let cachedIconSvg: string | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ICON_URL = 'chrome://beaver/content/icons/beaver_bw.png';

// Inline SVG dropmarker matching the reader's IconChevronDown8 (8x8, currentColor)
const BUTTON_CLASS = 'beaver-reader-toolbar-button';

const DROPMARKER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" fill="none"><path fill="currentColor" d="m0 2.707 4 4 4-4L7.293 2 4 5.293.707 2z"/></svg>`;

// ---------------------------------------------------------------------------
// Category icons — mirror the same icons used for skill categories in the
// React UI (homepage launcher, Actions preferences, slash menu). Built as
// inline data-URI SVGs since native XUL menuitems can't render React icons.
// Uncategorized actions fall back to the general "Actions" icon (Zap).
// ---------------------------------------------------------------------------

const CATEGORY_ICON_PATHS: Record<ActionCategory, string> = {
    research: '<path d="M18.5 17.5L21 20M19 15C19 16.6569 17.6569 18 16 18C14.3431 18 13 16.6569 13 15C13 13.3431 14.3431 12 16 12C17.6569 12 19 13.3431 19 15Z"/><path d="M17 22H5C3.89543 22 3 21.1046 3 20M10 18H5C3.89543 18 3 18.8954 3 20M3 20V8C3 5.17157 3 3.75736 3.87868 2.87868C4.75736 2 6.17157 2 9 2H15C16.8856 2 17.8284 2 18.4142 2.58579C19 3.17157 19 4.11438 19 6V9"/>',
    organize: '<path d="M8.64298 3.14559L6.93816 3.93362C4.31272 5.14719 3 5.75397 3 6.75C3 7.74603 4.31272 8.35281 6.93817 9.56638L8.64298 10.3544C10.2952 11.1181 11.1214 11.5 12 11.5C12.8786 11.5 13.7048 11.1181 15.357 10.3544L17.0618 9.56638C19.6873 8.35281 21 7.74603 21 6.75C21 5.75397 19.6873 5.14719 17.0618 3.93362L15.357 3.14559C13.7048 2.38186 12.8786 2 12 2C11.1214 2 10.2952 2.38186 8.64298 3.14559Z"/><path d="M20.788 11.0972C20.9293 11.2959 21 11.5031 21 11.7309C21 12.7127 19.6873 13.3109 17.0618 14.5072L15.357 15.284C13.7048 16.0368 12.8786 16.4133 12 16.4133C11.1214 16.4133 10.2952 16.0368 8.64298 15.284L6.93817 14.5072C4.31272 13.3109 3 12.7127 3 11.7309C3 11.5031 3.07067 11.2959 3.212 11.0972"/><path d="M20.3767 16.2661C20.7922 16.5971 21 16.927 21 17.3176C21 18.2995 19.6873 18.8976 17.0618 20.0939L15.357 20.8707C13.7048 21.6236 12.8786 22 12 22C11.1214 22 10.2952 21.6236 8.64298 20.8707L6.93817 20.0939C4.31272 18.8976 3 18.2995 3 17.3176C3 16.927 3.20778 16.5971 3.62334 16.2661"/>',
    annotate: '<path d="M6.6777 16.2071L8.79289 18.3223M6.6777 16.2071L2.5 20.5H6.5L8.79289 18.3223M6.6777 16.2071C6.28717 15.8166 6.29534 15.1872 6.63537 14.752C7.42742 13.7383 7.71531 12.8216 7.79924 12.1382C7.89158 11.3863 8.07366 10.5734 8.60933 10.0377L9.50122 9.14828M8.79289 18.3223C9.18342 18.7128 9.81278 18.7047 10.248 18.3646C11.2617 17.5726 12.1784 17.2847 12.8618 17.2008C13.6137 17.1084 14.4266 16.9263 14.9623 16.3907L15.8517 15.4988M15.8517 15.4988L9.50122 9.14828M15.8517 15.4988C16.2422 15.8893 16.8754 15.8893 17.2659 15.4988L21.5 11.2647M9.50122 9.14828C9.1107 8.75776 9.1107 8.12459 9.50122 7.73407L13.7353 3.5"/>',
};

const FALLBACK_ICON_PATH = '<path d="M8.62814 12.6736H8.16918C6.68545 12.6736 5.94358 12.6736 5.62736 12.1844C5.31114 11.6953 5.61244 11.0138 6.21504 9.65083L8.02668 5.55323C8.57457 4.314 8.84852 3.69438 9.37997 3.34719C9.91142 3 10.5859 3 11.935 3H14.0244C15.6632 3 16.4826 3 16.7916 3.53535C17.1007 4.0707 16.6942 4.78588 15.8811 6.21623L14.8092 8.10188C14.405 8.81295 14.2029 9.16849 14.2057 9.45952C14.2094 9.83775 14.4105 10.1862 14.7354 10.377C14.9854 10.5239 15.3927 10.5239 16.2074 10.5239C17.2373 10.5239 17.7523 10.5239 18.0205 10.7022C18.3689 10.9338 18.5513 11.3482 18.4874 11.7632C18.4382 12.0826 18.0918 12.4656 17.399 13.2317L11.8639 19.3523C10.7767 20.5545 10.2331 21.1556 9.86807 20.9654C9.50303 20.7751 9.67833 19.9822 10.0289 18.3962L10.7157 15.2896C10.9826 14.082 11.1161 13.4782 10.7951 13.0759C10.4741 12.6736 9.85877 12.6736 8.62814 12.6736Z"/>';

/** Build a themed data-URI SVG icon for an action's skill category (Zap for uncategorized). */
function categoryIconDataUri(category: ActionCategory | undefined, win: Window): string {
    const isDark = win.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
    const stroke = isDark ? '%23ffffff8c' : '%230000008c';
    const paths = category ? CATEGORY_ICON_PATHS[category] : FALLBACK_ICON_PATH;
    return `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

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

/** Create the toolbar button element in the given document. */
function createToolbarButton(reader: any, doc: Document): HTMLElement {
    const button = doc.createElement('button');
    button.className = `toolbar-button toolbar-dropdown-button ${BUTTON_CLASS}`;
    button.title = 'Beaver';
    button.tabIndex = -1;
    button.innerHTML = `${cachedIconSvg || ''}${DROPMARKER_SVG}`;
    button.addEventListener('click', () => {
        openBeaverMenu(reader, button);
    });
    return button;
}

function onRenderToolbar(event: any): void {
    const { reader, doc, append } = event;
    append(createToolbarButton(reader, doc));
}

/** Inject the button into an already-open reader that missed the renderToolbar event. */
function injectIntoExistingReader(reader: any): void {
    try {
        const iframeDoc = reader?._iframeWindow?.document;
        if (!iframeDoc) return;

        // Skip if already injected
        if (iframeDoc.querySelector(`.${BUTTON_CLASS}`)) return;

        // Find the custom-sections container inside the toolbar's .end section
        const toolbar = iframeDoc.querySelector('.toolbar .end .custom-sections');
        if (!toolbar) return;

        const button = createToolbarButton(reader, iframeDoc);
        // Wrap in a .section div to match what CustomSections does
        const section = iframeDoc.createElement('div');
        section.className = 'section';
        section.appendChild(button);
        toolbar.appendChild(section);
    } catch (_e) {
        // Best-effort — reader may not be fully initialized
    }
}

// Dev-only: dispatch an extraction-visualizer action so the React layer
// (which owns the visualizer code in the webpack bundle) can run it.
function dispatchVisualizerAction(
    action:
        | 'columns'
        | 'lines'
        | 'items'
        | 'sentences'
        | 'columns-graphics'
        | 'items-graphics'
        | 'sentences-graphics'
        | 'clear'
        | 'copy-extract-fixture-command'
        | 'copy-ocr-fixture-command',
): void {
    const win = Zotero.getMainWindow();
    const eventBus = win?.__beaverEventBus;
    if (!eventBus) return;

    eventBus.dispatchEvent(new win.CustomEvent('readerVisualizerAction', {
        detail: { action },
    }));
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
    const appendSeparator = () => {
        popup.appendChild(xulDoc.createXULElement('menuseparator'));
    };
    const appendVisualizerItem = (
        label: string,
        action: Parameters<typeof dispatchVisualizerAction>[0],
    ) => {
        const menuitem = xulDoc.createXULElement('menuitem');
        menuitem.setAttribute('label', label);
        menuitem.addEventListener('command', () => {
            dispatchVisualizerAction(action);
        });
        popup.appendChild(menuitem);
    };

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

    // ---- Actions section (attachment actions, PDF and EPUB readers) ----
    const isPdf = reader.type === 'pdf';
    const isEpub = reader.type === 'epub';
    const readerItemID: number | undefined = reader.itemID;

    if (isPdf || isEpub) {
        const actions = getMergedActions().filter(a => a.targetType === 'attachment');

        if (actions.length > 0) {
            appendSeparator();

            // Disabled header
            const header = xulDoc.createXULElement('menuitem');
            header.setAttribute('label', 'Actions');
            header.setAttribute('disabled', 'true');
            popup.appendChild(header);

            for (const action of actions) {
                const menuitem = xulDoc.createXULElement('menuitem');
                menuitem.setAttribute('label', action.title);
                menuitem.classList.add('menuitem-iconic');
                menuitem.setAttribute('image', categoryIconDataUri(action.category, win));
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
    appendSeparator();

    const addItem = xulDoc.createXULElement('menuitem');
    addItem.setAttribute('label', 'Add custom action\u2026');
    addItem.addEventListener('command', () => {
        openPreferencesWindow('actions');
    });
    popup.appendChild(addItem);

    // ---- Dev-only: extraction visualizer controls ----
    // Dropped from production builds at compile time.
    if (process.env.NODE_ENV === 'development' && (isPdf || isEpub)) {
        appendSeparator();
        appendVisualizerItem('Visualize Items', 'items');
        appendVisualizerItem('Visualize Sentences', 'sentences');
        appendVisualizerItem('Clear Visualization', 'clear');

        if (isPdf) {
            appendSeparator();
            appendVisualizerItem('Visualize Columns', 'columns');
            appendVisualizerItem('Visualize Lines', 'lines');

            appendSeparator();
            appendVisualizerItem('Visualize Columns (graphics)', 'columns-graphics');
            appendVisualizerItem('Visualize Items (graphics)', 'items-graphics');
            appendVisualizerItem('Visualize Sentences (graphics)', 'sentences-graphics');

            appendSeparator();
            appendVisualizerItem('Copy Extract Fixture Command', 'copy-extract-fixture-command');
            appendVisualizerItem('Copy OCR Fixture Command', 'copy-ocr-fixture-command');
        }
    }

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

    // Inject into already-open readers (e.g. plugin re-enable while reader tabs are open)
    const readers = (Zotero.Reader as any)?._readers;
    if (Array.isArray(readers)) {
        for (const reader of readers) {
            injectIntoExistingReader(reader);
        }
    }

    ztoolkit.log('readerToolbarMenu: Registered renderToolbar listener');
}

export function cleanupReaderToolbarMenu(): void {
    if (toolbarHandler) {
        removeListenerSafely('renderToolbar', toolbarHandler);
        toolbarHandler = null;
    }

    // Remove buttons already injected into open reader iframes
    try {
        const readers = (Zotero?.Reader as any)?._readers;
        if (Array.isArray(readers)) {
            for (const reader of readers) {
                const iframeDoc = reader?._iframeWindow?.document;
                if (!iframeDoc) continue;
                const buttons = iframeDoc.querySelectorAll(`.${BUTTON_CLASS}`);
                buttons.forEach((btn: Element) => btn.closest('.section')?.remove() ?? btn.remove());
            }
        }
    } catch (_e) {
        // Best-effort cleanup
    }
}
