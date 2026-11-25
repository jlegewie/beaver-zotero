/**
 * Development check on Zotero's menus.
 *
 * Zotero finds many of its own menu entries by id, and assigns some of those
 * ids by position each time a menu opens (the library pane's collection menu,
 * for one). An entry a plugin moves among Zotero's entries can take over the
 * id, and so the command, of the entry it displaces, while that entry takes
 * the id of the next one. Both leave traces in the menu's DOM: two elements
 * with one id, or a plugin entry carrying an id (Zotero's MenuManager never
 * gives its entries one).
 *
 * Development and staging builds run the check each time a menu opens in a
 * main window and log what they find to the error console. The
 * `/beaver/test/menu-integrity` endpoint opens Zotero's context menus the way
 * a right-click does and returns the same findings to live tests.
 *
 * Lives in the esbuild bundle; no React or Jotai imports.
 */

/** Whether this build runs the check when menus open. */
export const MENU_INTEGRITY_CHECKS_ENABLED =
    process.env.NODE_ENV === 'development' || process.env.BUILD_ENV === 'staging';

/** The class Zotero's MenuManager puts on every plugin entry. */
const PLUGIN_ENTRY_CLASS = 'zotero-custom-menu-item';

export interface MenuIntegrityProblem {
    kind: 'duplicate_id' | 'plugin_entry_with_id';
    id: string;
    /** The elements involved, as `tag.class…` (label), to tell whose they are. */
    elements: string[];
}

function describe(el: Element): string {
    const classes = Array.from(el.classList).slice(0, 4).join('.');
    const label = el.getAttribute('label') ?? el.getAttribute('data-l10n-id') ?? '';
    return `${el.localName}${classes ? `.${classes}` : ''}${label ? ` (${label})` : ''}`;
}

/**
 * The traces of a displaced entry in `popup`, the popup element itself
 * excluded: ids that more than one element carries, and plugin entries that
 * carry an id.
 */
export function findMenuIntegrityProblems(popup: Element): MenuIntegrityProblem[] {
    const byId = new Map<string, Element[]>();
    const pluginEntries: MenuIntegrityProblem[] = [];
    for (const el of Array.from(popup.querySelectorAll('[id]')) as Element[]) {
        if (!el.id) continue;
        const list = byId.get(el.id);
        if (list) list.push(el);
        else byId.set(el.id, [el]);
        if (el.classList.contains(PLUGIN_ENTRY_CLASS)) {
            pluginEntries.push({ kind: 'plugin_entry_with_id', id: el.id, elements: [describe(el)] });
        }
    }
    const duplicates: MenuIntegrityProblem[] = [];
    for (const [id, elements] of byId) {
        if (elements.length > 1) duplicates.push({ kind: 'duplicate_id', id, elements: elements.map(describe) });
    }
    return [...duplicates, ...pluginEntries];
}

function problemMessage(popup: Element, problem: MenuIntegrityProblem): string {
    const where = popup.id ? `menu #${popup.id}` : `a ${popup.localName}`;
    const what = problem.kind === 'duplicate_id'
        ? `${problem.elements.length} elements carry the id "${problem.id}"`
        : `a plugin entry carries Zotero's id "${problem.id}"`;
    return `Beaver dev check: in ${where}, ${what}: ${problem.elements.join('; ')}. `
        + 'Zotero finds these entries by id; an entry moved among Zotero\'s own takes over the id and command of the one it displaces.';
}

/**
 * Checks every menu that opens in `win` and logs each new problem once to
 * the error console. Returns the function that removes the check.
 */
export function attachMenuIntegrityCheck(win: Window): () => void {
    const reported = new Set<string>();
    const listener = (event: Event) => {
        const popup = event.target as Element | null;
        if (popup?.localName !== 'menupopup') return;
        try {
            for (const problem of findMenuIntegrityProblems(popup)) {
                const key = `${popup.id}|${problem.kind}|${problem.id}`;
                if (reported.has(key)) continue;
                reported.add(key);
                Zotero.logError(new Error(problemMessage(popup, problem)));
            }
        } catch { /* a check must never break Zotero's menu */ }
    };
    win.addEventListener('popupshown', listener, true);
    return () => {
        try {
            win.removeEventListener('popupshown', listener, true);
        } catch { /* the window is already gone */ }
    };
}

// ---------------------------------------------------------------------------
// Probe: open Zotero's context menus as a right-click does
// ---------------------------------------------------------------------------

/** Zotero context menus the probe can open, with the handler a right-click runs. */
const PROBED_MENUS = {
    collection: { popupId: 'zotero-collectionmenu', handler: 'onCollectionsContextMenuOpen' },
    item: { popupId: 'zotero-itemmenu', handler: 'onItemsContextMenuOpen' },
} as const;

export type ProbedMenu = keyof typeof PROBED_MENUS;

export function isProbedMenu(value: unknown): value is ProbedMenu {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROBED_MENUS, value);
}

export interface MenuProbeOpening {
    menu: ProbedMenu;
    opening: number;
    /** False when the menu did not open, e.g. nothing was selected for it to act on. */
    shown: boolean;
    /** Beaver's MenuManager entries in the menu (by their `beaver-` l10n id), nested ones included. */
    beaverEntries: number;
    /**
     * Whether MenuManager grouped plugin entries into its overflow submenu
     * (Zotero 9+, when the menu would not fit the screen), whose entries it
     * builds only when that submenu opens.
     */
    overflow: boolean;
    problems: MenuIntegrityProblem[];
    /** Set when the menu could not be probed at all. */
    error?: string;
}

/** Resolves true on the popup's next `type` event, false after `timeoutMs`. */
function nextPopupEvent(popup: Element, type: string, timeoutMs: number): Promise<boolean> {
    const win = popup.ownerDocument.defaultView as Window;
    return new Promise((resolve) => {
        const onEvent = (event: Event) => {
            if (event.target !== popup) return;
            popup.removeEventListener(type, onEvent);
            win.clearTimeout(timer);
            resolve(true);
        };
        const timer = win.setTimeout(() => {
            popup.removeEventListener(type, onEvent);
            resolve(false);
        }, timeoutMs);
        popup.addEventListener(type, onEvent);
    });
}

/**
 * Opens each menu `openings` times through Zotero's own right-click handler
 * (which builds the menu, then opens it), checks it while it is open, and
 * closes it. Menus act on the current selection of `win`.
 */
export async function probeMenuIntegrity(
    win: Window,
    menus: readonly ProbedMenu[],
    openings: number,
): Promise<MenuProbeOpening[]> {
    const pane = (win as any).ZoteroPane;
    const results: MenuProbeOpening[] = [];
    for (const menu of menus) {
        const { popupId, handler } = PROBED_MENUS[menu];
        const popup = win.document.getElementById(popupId) as (Element & { hidePopup(): void; state: string }) | null;
        if (!popup || typeof pane?.[handler] !== 'function') {
            results.push({ menu, opening: 0, shown: false, beaverEntries: 0, overflow: false, problems: [], error: `${popupId} or ZoteroPane.${handler} not found` });
            continue;
        }
        for (let opening = 1; opening <= openings; opening++) {
            if (popup.state === 'open' || popup.state === 'showing') {
                const hidden = nextPopupEvent(popup, 'popuphidden', 3000);
                popup.hidePopup();
                await hidden;
            }
            const x = win.screenX + 200;
            const y = win.screenY + 200;
            // The handler resolves once it has built the menu and asked it to
            // open; the menu shows later, so the wait starts only then.
            await pane[handler]({ target: null, screenX: x, screenY: y }, x, y);
            const wasShown = popup.state === 'open' || await nextPopupEvent(popup, 'popupshown', 5000);
            const problems = findMenuIntegrityProblems(popup);
            const beaverEntries = popup.querySelectorAll(`.${PLUGIN_ENTRY_CLASS}[data-l10n-id^="beaver-"]`).length;
            const overflow = popup.querySelector('.zotero-custom-menu-group-submenu') !== null;
            if (wasShown) {
                const hidden = nextPopupEvent(popup, 'popuphidden', 3000);
                popup.hidePopup();
                await hidden;
            }
            results.push({ menu, opening, shown: wasShown, beaverEntries, overflow, problems });
        }
    }
    return results;
}
