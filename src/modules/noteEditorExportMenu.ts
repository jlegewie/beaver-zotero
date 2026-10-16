/**
 * "Export with Beaver" in the More menu of Zotero's note editor.
 *
 * The note editor's toolbar is a React app inside an iframe and has no plugin
 * API, so the entry is added to the More dropdown's DOM each time it opens.
 * Every window gets capture listeners; an interaction with a note editor's
 * More dropdown is followed, once React has rendered the popup, by adding the
 * entry. Choosing it opens a native popup of export formats beside the entry,
 * as a submenu, while the dropdown stays open. Nothing in Zotero is patched:
 * if the dropdown's markup changes, the entry is simply absent.
 *
 * Lives in the esbuild bundle — must NOT import from react/store or Jotai.
 */

import { exportNoteWithProgress, NOTE_EXPORT_FORMATS } from './noteExportCommand';
import { getEditorNoteHtml } from '../utils/noteEditorIO';

const NOTE_EDITOR_URL = 'resource://zotero/note-editor/editor.html';
const ENTRY_CLASS = 'beaver-note-export';
const SEPARATOR_CLASS = 'beaver-note-export-separator';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Padding of the dropdown and of a native menu: the submenu's first item lines up with the entry. */
const MENU_PADDING = 5;

/**
 * Events that can open the More dropdown: a mouse press, a key press on the
 * button (Arrow Down, Enter), and a key release (Space).
 */
const OPENING_EVENTS = ['mousedown', 'click', 'keydown', 'keyup'];

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

/** A chevron at the end of the entry, as on a submenu item. */
function createChevron(doc: Document): Element {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('style', 'margin-inline-start: auto; padding-inline-start: 12px; box-sizing: content-box;');
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M6.2 3.5 10.7 8l-4.5 4.5-.7-.7L9.3 8 5.5 4.2z');
    svg.append(path);
    return svg;
}

/** Add "Export with Beaver" to an open More dropdown that lacks it. */
function addEntry(dropdown: Element): void {
    const popup = dropdown.querySelector(':scope > .popup');
    if (!popup || popup.querySelector(`.${ENTRY_CLASS}`)) return;
    const doc = dropdown.ownerDocument;
    if (!noteOf(noteEditorOf(doc))) return;

    const separator = doc.createElement('div');
    separator.className = `separator ${SEPARATOR_CLASS}`;
    const button = doc.createElement('button');
    button.className = `option ${ENTRY_CLASS}`;
    button.setAttribute('aria-haspopup', 'menu');
    const label = doc.createElement('span');
    label.textContent = 'Export with Beaver';
    button.append(label, createChevron(doc));
    button.addEventListener('click', (event: Event) => {
        // The dropdown closes on any click in its popup, which React handles
        // at its root; a submenu keeps it open.
        event.stopPropagation();
        openFormatMenu(dropdown, popup as HTMLElement, button);
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

/** Close the More dropdown if it is still open, as its own button does. */
function closeDropdown(dropdown: Element): void {
    const toggle = dropdown.querySelector(':scope > .toolbar-button');
    const view = dropdown.ownerDocument.defaultView;
    if (!toggle || !view || !dropdown.querySelector(':scope > .popup')) return;
    toggle.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, button: 0 }));
}

/**
 * Open the export formats beside the entry, like a submenu (on the other side
 * when there is no room). The entry stays highlighted while they are open;
 * closing them closes the dropdown too.
 */
function openFormatMenu(dropdown: Element, dropdownPopup: HTMLElement, entry: HTMLElement): void {
    const doc = dropdown.ownerDocument;
    const editor = noteEditorOf(doc);
    const frame = (doc.defaultView as any)?.browsingContext?.embedderElement as Element | null;
    const win = editor?.ownerDocument?.defaultView as Window | null;
    if (!editor || !frame || !win || win.closed) return;

    const xulDoc = win.document;
    const popup = xulDoc.createXULElement('menupopup') as any;
    // On the root: a popup cannot open inside a hidden element.
    xulDoc.documentElement.appendChild(popup);
    popup.addEventListener('popuphidden', (event: Event) => {
        if (event.target !== popup) return;
        popup.remove();
        entry.style.removeProperty('background-color');
        closeDropdown(dropdown);
    });
    for (const { format, name } of NOTE_EXPORT_FORMATS) {
        const menuitem = xulDoc.createXULElement('menuitem');
        menuitem.setAttribute('label', `${name}\u2026`);
        menuitem.addEventListener('command', () => {
            // The note as this editor shows it when the format is chosen; other
            // editors of the same note may not have caught up yet.
            const note = noteOf(editor);
            if (note) void exportNoteWithProgress(note, getEditorNoteHtml(note, doc.defaultView), format, name, win, 'note_editor');
        });
        popup.appendChild(menuitem);
    }

    // The dropdown's hover color, kept while the submenu is open.
    entry.style.setProperty('background-color', 'var(--fill-quinary)');

    // Horizontally the dropdown's edges, vertically the entry, raised by the
    // menu's padding so the first format lines up with it.
    const popupRect = dropdownPopup.getBoundingClientRect();
    const entryRect = entry.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const rect = (win as any).windowUtils.toScreenRectInCSSUnits(
        frameRect.x + popupRect.left,
        frameRect.y + entryRect.top - MENU_PADDING,
        popupRect.width,
        entryRect.height,
    );
    if (typeof popup.openPopupAtScreenRect === 'function') {
        popup.openPopupAtScreenRect('end_before', rect.x, rect.y, rect.width, rect.height, false, false);
    } else {
        popup.openPopupAtScreen(rect.x + rect.width, rect.y, false);
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
