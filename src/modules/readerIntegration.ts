/**
 * Reader integration: text selection popup, view context menu, and annotation context menu.
 *
 * Registers three Zotero.Reader event listeners:
 * 1. renderTextSelectionPopup — adds "Explain" and "Ask..." buttons
 * 2. createViewContextMenu — adds "Explain Selection" and "Ask Beaver..." items
 * 3. createAnnotationContextMenu — adds "Explain" and "Ask..." items for annotations
 *
 * All dispatch events via __beaverEventBus so the webpack bundle can orchestrate the UI flow.
 *
 * Lives in the esbuild bundle — must NOT import from react/store or Jotai.
 */

// Module-level references for cleanup
let popupHandler: ((event: any) => void) | null = null;
let contextMenuHandler: ((event: any) => void) | null = null;
let annotationMenuHandler: ((event: any) => void) | null = null;

// Reader view types Beaver integrates with: PDF, EPUB, and web snapshots.
// EPUB and snapshot are DOM-based views with section/continuous layout and no
// PDF-style page numbers (the reader position is captured downstream).
function isSupportedReaderType(type: unknown): boolean {
    return type === 'pdf' || type === 'epub' || type === 'snapshot';
}

// Annotation actions serialize Zotero annotation positions as PDF page/rect data.
function isSupportedAnnotationReaderType(type: unknown): boolean {
    return type === 'pdf';
}

/**
 * Extract the currently selected text from a reader, regardless of view type.
 */
function getReaderSelectedText(reader: any): string | null {
    try {
        // EPUB and snapshot are DOM-based views that expose the selection through
        // the content iframe's window selection rather than `_selectionRanges`.
        if (reader?.type === 'epub' || reader?.type === 'snapshot') {
            const selection = reader?._internalReader?._primaryView?._iframeWindow?.getSelection();
            const text = selection?.toString();
            return text && text.trim() ? text : null;
        }
        if (reader?.type === 'pdf') {
            const ranges = reader?._internalReader?._primaryView?._selectionRanges;
            if (ranges?.length > 0) {
                const text = ranges.map((range: any) => range.text).join('\n\n');
                return text || null;
            }
        }
    } catch (_e) {
        // Graceful fallback — no selection available
    }
    return null;
}

// ---------------------------------------------------------------------------
// Event dispatch helper
// ---------------------------------------------------------------------------

function dispatchReaderAction(
    action: 'explain' | 'ask',
    text: string,
    page: number | undefined,
    readerItemID: number,
): void {
    const win = Zotero.getMainWindow();
    const eventBus = win?.__beaverEventBus;
    if (!eventBus) return;

    eventBus.dispatchEvent(new win.CustomEvent('readerSelectionAction', {
        detail: { action, text, page, readerItemID },
    }));
}

// ---------------------------------------------------------------------------
// Text selection popup handler
// ---------------------------------------------------------------------------

function onRenderTextSelectionPopup(event: any): void {
    const { reader, doc, params, append } = event;

    if (!isSupportedReaderType(reader?.type)) return;

    const annotationText = params?.annotation?.text;
    if (!annotationText) return;

    // PDF annotations carry a 0-based pageIndex; EPUB/snapshot selections have
    // no PDF-style page (the reader position is captured downstream when the
    // message is sent).
    const page = reader.type === 'pdf'
        ? (params.annotation.pageIndex ?? 0) + 1
        : undefined;
    const readerItemID = reader?.itemID;
    if (!readerItemID) return;

    const container = doc.createElement('div');
    container.className = 'beaver-selection-popup';
    container.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

    // "Beaver" label
    const label = doc.createElement('span');
    label.textContent = 'Beaver';
    label.style.cssText = 'font-size: 11px; color: #888; user-select: none; padding-left: 4px;';
    container.appendChild(label);

    // Button row — match width/style of the highlight/underline row above
    const row = doc.createElement('div');
    row.style.cssText = 'display: flex; gap: 4px;';

    const explainBtn = doc.createElement('button');
    explainBtn.className = 'toolbar-button wide-button';
    explainBtn.style.cssText = 'flex: 1;';
    explainBtn.textContent = 'Explain';
    explainBtn.addEventListener('click', () => {
        dispatchReaderAction('explain', annotationText, page, readerItemID);
    });

    const askBtn = doc.createElement('button');
    askBtn.className = 'toolbar-button wide-button';
    askBtn.style.cssText = 'flex: 1;';
    askBtn.textContent = 'Ask...';
    askBtn.addEventListener('click', () => {
        dispatchReaderAction('ask', annotationText, page, readerItemID);
    });

    row.appendChild(explainBtn);
    row.appendChild(askBtn);
    container.appendChild(row);
    append(container);
}

// ---------------------------------------------------------------------------
// Context menu handler
// ---------------------------------------------------------------------------

function onCreateViewContextMenu(event: any): void {
    const { reader, append } = event;

    if (!isSupportedReaderType(reader?.type)) return;

    const readerItemID = reader?.itemID;

    const selectedText = getReaderSelectedText(reader);

    // Current page (1-based) from the PDF viewer. EPUB/snapshot selections have
    // no PDF-style page; their position is captured downstream.
    let page: number | undefined = undefined;
    if (reader?.type === 'pdf') {
        page = 1;
        try {
            const pdfViewer = reader?._internalReader?._primaryView
                ?._iframeWindow?.PDFViewerApplication?.pdfViewer;
            if (pdfViewer?.currentPageNumber) {
                page = pdfViewer.currentPageNumber;
            }
        } catch (_e) {
            // Fallback to page 1
        }
    }

    const hasSelection = !!selectedText && selectedText.length > 0;

    // Flat items — append does not support submenu/groups nesting
    append(
        {
            label: 'Explain with Beaver',
            disabled: !hasSelection,
            persistent: true,
            onCommand: () => {
                if (selectedText && readerItemID) {
                    dispatchReaderAction('explain', selectedText, page, readerItemID);
                }
            },
        },
        {
            label: 'Ask Beaver...',
            disabled: !hasSelection,
            persistent: true,
            onCommand: () => {
                if (selectedText && readerItemID) {
                    dispatchReaderAction('ask', selectedText, page, readerItemID);
                }
            },
        },
    );

}

// ---------------------------------------------------------------------------
// Annotation context menu handler
// ---------------------------------------------------------------------------

function dispatchAnnotationAction(
    action: 'explain' | 'ask',
    annotationIds: string[],
    readerItemID: number,
): void {
    const win = Zotero.getMainWindow();
    const eventBus = win?.__beaverEventBus;
    if (!eventBus) return;

    eventBus.dispatchEvent(new win.CustomEvent('readerAnnotationAction', {
        detail: { action, annotationIds, readerItemID },
    }));
}

function onCreateAnnotationContextMenu(event: any): void {
    const { reader, params, append } = event;

    if (!isSupportedAnnotationReaderType(reader?.type)) return;

    const readerItemID = reader?.itemID;
    if (!readerItemID) return;

    const annotationIds: string[] = params?.ids ?? [];
    if (annotationIds.length === 0) return;

    // Flat items: disabled "Beaver" header + action items (submenus not supported here)
    append(
        {
            label: 'Explain with Beaver...',
            persistent: true,
            onCommand: () => {
                dispatchAnnotationAction('explain', annotationIds, readerItemID);
            },
        },
        {
            label: 'Ask Beaver...',
            persistent: true,
            onCommand: () => {
                dispatchAnnotationAction('ask', annotationIds, readerItemID);
            },
        },
    );
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

function removeListenerSafely(type: string, handler: (...args: unknown[]) => unknown): boolean {
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

export function initReaderIntegration(): void {
    if (typeof Zotero?.Reader?.registerEventListener !== 'function') {
        ztoolkit.log('readerIntegration: Reader API not available, skipping');
        return;
    }

    // Clean up any previous listeners (e.g. plugin reload)
    cleanupReaderIntegration();

    popupHandler = onRenderTextSelectionPopup;
    contextMenuHandler = onCreateViewContextMenu;
    annotationMenuHandler = onCreateAnnotationContextMenu;

    Zotero.Reader.registerEventListener('renderTextSelectionPopup', popupHandler, addon.data.config.addonID);
    Zotero.Reader.registerEventListener('createViewContextMenu', contextMenuHandler, addon.data.config.addonID);
    Zotero.Reader.registerEventListener('createAnnotationContextMenu', annotationMenuHandler, addon.data.config.addonID);

    ztoolkit.log('readerIntegration: Registered reader event listeners');
}

export function cleanupReaderIntegration(): void {
    if (popupHandler) {
        removeListenerSafely('renderTextSelectionPopup', popupHandler);
        popupHandler = null;
    }
    if (contextMenuHandler) {
        removeListenerSafely('createViewContextMenu', contextMenuHandler);
        contextMenuHandler = null;
    }
    if (annotationMenuHandler) {
        removeListenerSafely('createAnnotationContextMenu', annotationMenuHandler);
        annotationMenuHandler = null;
    }
}
