/**
 * "Export with Beaver…" in the More menu of Zotero's note editor.
 *
 * The note editor's toolbar is a React app inside an iframe and has no plugin
 * API, so the entry is added to the More dropdown's DOM each time it opens.
 * Every window gets capture listeners; an interaction with a note editor's
 * More dropdown is followed, once React has rendered the popup, by adding the
 * entry. Choosing it opens a native popup of export formats where the
 * dropdown was. Nothing in Zotero is patched: if the dropdown's markup
 * changes, the entry is simply absent.
 *
 * Lives in the esbuild bundle — must NOT import from react/store or Jotai.
 */

import type { ExportFormat } from '../services/export/instanceExport';
import { exportErrorMessage } from '../services/export/exportErrors';
import { getEditorNoteHtml } from '../utils/noteEditorIO';

const NOTE_EDITOR_URL = 'resource://zotero/note-editor/editor.html';
const ENTRY_CLASS = 'beaver-note-export';
const SEPARATOR_CLASS = 'beaver-note-export-separator';

/**
 * Events that can open the More dropdown: a mouse press, a key press on the
 * button (Arrow Down, Enter), and a key release (Space).
 */
const OPENING_EVENTS = ['mousedown', 'click', 'keydown', 'keyup'];

/** Export formats in menu order, as the chat's export menus name them. */
const FORMATS: Array<{ format: ExportFormat; name: string }> = [
    { format: 'docx', name: 'Word' },
    { format: 'pdf', name: 'PDF' },
    { format: 'markdown', name: 'Markdown' },
    { format: 'latex', name: 'LaTeX' },
];

/** Windows with the capture listeners. */
const attachedWindows = new Set<Window>();
let windowListener: { onOpenWindow(xulWindow: any): void; onCloseWindow(xulWindow: any): void } | null = null;

// ---------------------------------------------------------------------------
// Dropdown entry
// ---------------------------------------------------------------------------

/** The `note-editor` element that hosts a note editor document. */
function noteEditorOf(doc: Document): any | null {
    try {
        const frame = (doc.defaultView as any)?.browsingContext?.embedderElement as Element | null;
        return frame?.closest('note-editor') ?? null;
    } catch {
        return null;
    }
}

/** The saved note a note editor shows, or null (an attachment note, an empty editor). */
function noteOf(editor: any): Zotero.Item | null {
    const item = editor?.item as Zotero.Item | undefined;
    return item?.id && item.isNote() ? item : null;
}

function onInteraction(event: Event): void {
    const target = event.target as Element | null;
    const doc = target?.ownerDocument;
    if (!doc || doc.documentURI !== NOTE_EDITOR_URL) return;
    const dropdown = target.closest?.('.more-dropdown');
    if (!dropdown) return;
    // React renders the popup while handling the event (or in a microtask
    // right after); a task later it is in the DOM.
    doc.defaultView?.setTimeout(() => {
        try {
            addEntry(dropdown);
        } catch (error) {
            Zotero.logError(error as Error);
        }
    }, 0);
}

/**
 * Put the entry last, after a separator unless one already ends the popup.
 * Other plugins add their own entries to the same popup, some only after it
 * has opened.
 */
function placeLast(popup: Element, separator: Element, button: Element): void {
    if (popup.lastElementChild === button) return;
    separator.remove();
    button.remove();
    const last = popup.lastElementChild;
    if (last && !last.classList.contains('separator')) popup.append(separator);
    popup.append(button);
    keepInside(popup as HTMLElement);
}

/**
 * Keep a popup that the entry widened inside the editor. Versions of the note
 * editor that position the popup by its left edge compute that edge from the
 * popup's width before the entry is added.
 */
function keepInside(popup: HTMLElement): void {
    const PADDING = 5;
    const win = popup.ownerDocument.defaultView;
    if (!win) return;
    const rect = popup.getBoundingClientRect();
    const width = popup.ownerDocument.documentElement?.clientWidth ?? 0;
    const overflow = Math.min(rect.right - (width - PADDING), rect.left - PADDING);
    if (overflow <= 0) return;
    const left = parseFloat(win.getComputedStyle(popup)?.left ?? '');
    if (Number.isFinite(left)) popup.style.left = `${left - overflow}px`;
}

/** Add "Export with Beaver…" to an open More dropdown that lacks it. */
function addEntry(dropdown: Element): void {
    const popup = dropdown.querySelector(':scope > .popup');
    if (!popup || popup.querySelector(`.${ENTRY_CLASS}`)) return;
    const doc = dropdown.ownerDocument;
    if (!noteOf(noteEditorOf(doc))) return;

    const separator = doc.createElement('div');
    separator.className = `separator ${SEPARATOR_CLASS}`;
    const button = doc.createElement('button');
    button.className = `option ${ENTRY_CLASS}`;
    button.textContent = 'Export with Beaver\u2026';
    // The dropdown closes itself on any click in its popup.
    button.addEventListener('click', () => {
        const anchor = dropdown.querySelector(':scope > .toolbar-button') ?? dropdown;
        openFormatMenu(doc, anchor);
    });
    placeLast(popup, separator, button);

    // Observes this popup only; the popup and its observer go away when the
    // dropdown closes.
    const observer = new (doc.defaultView as any).MutationObserver(() => {
        if (!windowListener) {
            observer.disconnect();
            return;
        }
        placeLast(popup, separator, button);
    });
    observer.observe(popup, { childList: true });
}

// ---------------------------------------------------------------------------
// Format menu
// ---------------------------------------------------------------------------

/** Open the export formats under the More button, right-aligned like the dropdown. */
function openFormatMenu(doc: Document, anchor: Element): void {
    const editor = noteEditorOf(doc);
    const frame = (doc.defaultView as any)?.browsingContext?.embedderElement as Element | null;
    const win = editor?.ownerDocument?.defaultView as Window | null;
    if (!editor || !frame || !win || win.closed) return;

    const xulDoc = win.document;
    const popup = xulDoc.createXULElement('menupopup') as any;
    // On the root: a popup cannot open inside a hidden element.
    xulDoc.documentElement.appendChild(popup);
    popup.addEventListener('popuphidden', (event: Event) => {
        if (event.target === popup) popup.remove();
    });
    for (const { format, name } of FORMATS) {
        const menuitem = xulDoc.createXULElement('menuitem');
        menuitem.setAttribute('label', `${name}\u2026`);
        menuitem.addEventListener('command', () => {
            // The note as this editor shows it when the format is chosen; other
            // editors of the same note may not have caught up yet.
            const note = noteOf(editor);
            if (note) void exportNote(note, getEditorNoteHtml(note, doc.defaultView), format, name, win);
        });
        popup.appendChild(menuitem);
    }

    const anchorRect = anchor.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const rect = (win as any).windowUtils.toScreenRectInCSSUnits(
        frameRect.x + anchorRect.left,
        frameRect.y + anchorRect.top,
        anchorRect.width,
        anchorRect.height,
    );
    // Opened after the click that closes the dropdown has finished.
    win.setTimeout(() => {
        if (typeof popup.openPopupAtScreenRect === 'function') {
            popup.openPopupAtScreenRect('after_end', rect.x, rect.y, rect.width, rect.height, false, false);
        } else {
            popup.openPopupAtScreen(rect.x, rect.y + rect.height, false);
        }
    }, 0);
}

/** Export the note, asking where to save, and say how it went. */
async function exportNote(note: Zotero.Item, html: string | null, format: ExportFormat, name: string, win: Window): Promise<void> {
    try {
        const result = await addon.exporter.exportNote(
            { note: { key: note.key, libraryID: note.libraryID }, html: html ?? undefined, format },
            { window: win },
        );
        if (result.status !== 'saved') return;
        const progress = new Zotero.ProgressWindow({ window: win.closed ? undefined : win, closeOnClick: true });
        progress.changeHeadline(`Exported to ${name}`);
        // The document, a LaTeX export's .bib file, and the folder of images
        // that Markdown and LaTeX exports write beside the document. Icons are
        // Zotero's item type icons.
        const [documentPath, ...others] = result.files;
        const bibliographies = others.filter(path => /\.bib$/i.test(path));
        const images = others.filter(path => !/\.bib$/i.test(path));
        for (const path of [documentPath, ...bibliographies]) {
            const line = new progress.ItemProgress(path === documentPath && format === 'pdf' ? 'attachmentPDF' : 'document', PathUtils.filename(path));
            line.setProgress(100);
        }
        if (images.length > 0) {
            const folder = PathUtils.filename(PathUtils.parent(images[0]) ?? '');
            const line = new progress.ItemProgress('attachmentImage', `${images.length} image${images.length === 1 ? '' : 's'} in ${folder}`);
            line.setProgress(100);
        }
        for (const warning of result.warnings) {
            progress.addDescription(warning.message);
        }
        progress.show();
        progress.startCloseTimer(result.warnings.length > 0 ? 10000 : 5000);
    } catch (error: any) {
        Zotero.logError(error);
        Services.prompt.alert((win.closed ? null : win) as any, 'Could not export', exportErrorMessage(error));
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function attachWindow(win: Window): void {
    if (attachedWindows.has(win)) return;
    attachedWindows.add(win);
    for (const type of OPENING_EVENTS) win.addEventListener(type, onInteraction, true);
}

function detachWindow(win: Window): void {
    if (!attachedWindows.delete(win)) return;
    try {
        for (const type of OPENING_EVENTS) win.removeEventListener(type, onInteraction, true);
    } catch {
        // The window is already gone.
    }
}

/** Attach to a window once its document has loaded (a new window starts on about:blank). */
function attachWhenLoaded(win: Window): void {
    if (win.document?.readyState === 'complete') {
        attachWindow(win);
        return;
    }
    win.addEventListener('load', () => {
        if (windowListener) attachWindow(win);
    }, { once: true });
}

/** Remove entries left in open dropdowns, whose handlers belong to this plugin instance. */
function removeEntries(win: Window): void {
    try {
        win.document.querySelectorAll('note-editor #editor-view').forEach((frame: Element) => {
            (frame as HTMLIFrameElement).contentDocument
                ?.querySelectorAll(`.${ENTRY_CLASS}, .${SEPARATOR_CLASS}`)
                .forEach((element: Element) => element.remove());
        });
    } catch {
        // Best-effort: the window may be closing.
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initNoteEditorExportMenu(): void {
    cleanupNoteEditorExportMenu();
    windowListener = {
        onOpenWindow(xulWindow: any) {
            const win = xulWindow?.docShell?.domWindow as Window | undefined;
            if (win) attachWhenLoaded(win);
        },
        onCloseWindow(xulWindow: any) {
            const win = xulWindow?.docShell?.domWindow as Window | undefined;
            if (win) detachWindow(win);
        },
    };
    Services.wm.addListener(windowListener as any);
    for (const win of Services.wm.getEnumerator(null as any)) {
        attachWhenLoaded(win as unknown as Window);
    }
}

export function cleanupNoteEditorExportMenu(): void {
    if (windowListener) {
        Services.wm.removeListener(windowListener as any);
        windowListener = null;
    }
    for (const win of [...attachedWindows]) {
        removeEntries(win);
        detachWindow(win);
    }
}
