import { getHostWindow, tryGetWindowRuntime } from '../runtime/windowRuntime';
import { collapseTableTabContextPane, isTableTabSelected, openTableTabContextPane } from '../../src/ui/tableTabContextPane';
import { SidebarLocation, UIState } from './types';
import { isStackedLayout, readerMountParent, restoreReaderSiblings } from '../utils/zoteroLayout';
import { activeItemPane } from '../../src/ui/libraryPane';
import { getPref, setPref } from '../../src/utils/prefs';
import { store } from '../store';
import { preferencesRevisionAtom } from '../atoms/preferences';

/** How long a resize settles before the sidebar width is saved. */
const WIDTH_SAVE_DELAY_MS = 250;

/**
 * The occupied pane's flex-shrink. When the window is too narrow for the pane
 * and its neighbour together, the browser shrinks both in proportion to their
 * base size, so a wide neighbour would squeeze the sidebar below its width.
 * Near zero, the neighbour gives way first, down to its minimum, and the
 * sidebar only narrows once nothing else can.
 */
const PANE_FLEX_SHRINK = '0.001';

/** The Zotero pane the sidebar occupies while it is shown. */
interface Host {
    location: SidebarLocation;
    /** The pane the sidebar sizes: the item pane, or `#zotero-context-pane`. */
    pane: HTMLElement;
    /** The sidebar opened the pane from collapsed, so hiding it collapses the pane again. */
    openedCollapsed: boolean;
    /**
     * The pane's inline width before the sidebar set its own, or null while the
     * sidebar is not sizing the pane.
     */
    nativeStyleWidth: string | null;
    /** The pane's `width` attribute, which Zotero persists as the pane's own width. */
    nativeWidthAttr: string | null;
    /** The pane's inline flex-shrink before the sidebar set its own. */
    nativeFlexShrink: string;
    /**
     * The element on the other side of the pane's splitter, with its inline
     * width and `width` attribute from before the sidebar sized the pane.
     */
    neighbour: { element: HTMLElement; styleWidth: string; widthAttr: string | null } | null;
    /** The user dragged the pane's splitter while the sidebar was in the pane. */
    dragged: boolean;
    widthObserver: MutationObserver | null;
}

/** Scroll offsets of the scrolled elements in a subtree. */
type ScrollSnapshot = Array<[HTMLElement, number, number]>;

/**
 * Moving an element to another parent resets the scroll offset of everything
 * inside it, so the offsets are read before a move and written back after.
 */
function captureScroll(root: HTMLElement): ScrollSnapshot {
    const snapshot: ScrollSnapshot = [];
    for (const element of Array.from(root.querySelectorAll('*')) as HTMLElement[]) {
        if (element.scrollTop || element.scrollLeft) {
            snapshot.push([element, element.scrollTop, element.scrollLeft]);
        }
    }
    return snapshot;
}

function restoreScroll(snapshot: ScrollSnapshot): void {
    for (const [element, top, left] of snapshot) {
        // The same offsets as before the move, so a scroll handler reading
        // them finds the reader where they were.
        element.scrollTop = top;
        element.scrollLeft = left;
    }
}

/** Whether `element` is laid out at a size. A collapsed XUL pane keeps zero-size boxes. */
function hasSize(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

/**
 * An element's `width` attribute, or null when it has none. Zotero 7's Gecko
 * returns "" from `getAttribute` for a missing XUL attribute, and putting that
 * "" back would create an attribute Zotero then persists.
 */
function widthAttribute(element: Element): string | null {
    return element.hasAttribute('width') ? element.getAttribute('width') : null;
}

/**
 * Let the other side of the occupied pane's splitter take whatever width the
 * sidebar leaves. It fills the row on its own (flex-grow), so an inline width
 * there is only the size Zotero gave it beside the pane's own width. Kept, that
 * size plus the sidebar width can exceed the window: Zotero's pane row cannot
 * shrink below the sum of its panes' inline widths, so the row overflows and
 * the window cuts the sidebar off.
 */
function clearNeighbourWidth(host: Host): void {
    const element = host.neighbour?.element;
    if (element?.style.width) element.style.removeProperty('width');
}

function readStoredWidth(): number {
    const width = Number(getPref('sidebarWidth'));
    return Number.isFinite(width) && width > 0 ? Math.round(width) : 0;
}

/**
 * Shows and hides a main window's sidebar and keeps it in the pane of the
 * selected tab: the active library view's item pane on a library tab, the
 * context pane on any other.
 *
 * The window has one sidebar element, rendered once. A tab switch moves it to
 * the other pane rather than rendering a second copy, so nothing re-renders and
 * component state survives the switch.
 *
 * In the standard layout the sidebar also has one width wherever it is shown:
 * the pane it occupies takes the `sidebarWidth` preference, and dragging that
 * pane's splitter changes the preference. Zotero's own widths for its panes,
 * which it persists from their `width` attribute, are left as they were and
 * come back when the sidebar leaves the pane. The stacked layout sizes the
 * panes by height, and Zotero keeps sizing them there.
 */
class UIManager {
    private mount: HTMLElement | null = null;
    private host: Host | null = null;
    private state: UIState | null = null;
    /** The sidebar width in CSS pixels; 0 until it is known. */
    private width = 0;
    private saveTimer: number | null = null;
    private timers = new Set<number>();
    private hostWindow?: Window;
    private restoreContextPaneTabHandler?: () => void;
    private layoutObserver?: symbol | number;
    /** Scroll offsets waiting for the sidebar to be laid out in its new pane. */
    private pendingScroll: ScrollSnapshot = [];
    private scrollObserver: ResizeObserver | null = null;
    private unsubscribePreferences?: () => void;
    /** Between a mousedown on a splitter and the end of its mouseup. */
    private splitterDrag = false;
    private removeSplitterListeners?: () => void;

    private getWindow(): Window {
        return this.hostWindow ??= getHostWindow();
    }

    /** The window's sidebar element. The UI manager places it from now on. */
    public setSidebarMount(mount: HTMLElement): void {
        this.mount = mount;
    }

    /** Native context panes also receive tab events from other main windows. */
    private scopeContextPaneTabEvents(): void {
        if (this.restoreContextPaneTabHandler) return;
        const win = this.getWindow();
        const pane = win.document.getElementById('zotero-context-pane-inner') as
            (HTMLElement & { _handleTabSelect?: (...args: any[]) => unknown }) | null;
        const original = pane?._handleTabSelect;
        if (!pane || typeof original !== 'function') return;
        const scoped = function(this: HTMLElement, ...args: any[]) {
            const [event, type, ids] = args;
            if (type === 'tab' && (event === 'select' || event === 'load')
                && ids?.[0] !== win.Zotero_Tabs.selectedID) return;
            return original.apply(this, args);
        };
        pane._handleTabSelect = scoped;
        this.restoreContextPaneTabHandler = () => {
            if (pane._handleTabSelect === scoped) pane._handleTabSelect = original;
        };
    }

    /**
     * Follow the layout preference and the stored sidebar width, which another
     * window may change.
     */
    private watchSettings(win: Window): void {
        if (this.layoutObserver === undefined) {
            this.layoutObserver = Zotero.Prefs.registerObserver?.('layout', () => {
                // After Zotero has laid its panes out for the new layout.
                const timer = win.setTimeout(() => {
                    this.timers.delete(timer);
                    if (this.state && win.__beaverRuntime?.status !== 'closing') this.updateUI(this.state);
                }, 0);
                this.timers.add(timer);
            });
        }
        if (!this.removeSplitterListeners) {
            // Only a drag the user makes on a splitter changes the sidebar
            // width; Zotero writes its panes' widths the same way when it
            // restores them. The splitter's last write lands while its mouseup
            // is still being handled, so the drag ends a task later.
            // Any other mousedown ends a drag whose mouseup never arrived.
            const onMouseDown = (event: MouseEvent) => {
                this.splitterDrag = !!(event.target as Element | null)?.closest?.('splitter');
            };
            const onMouseUp = () => {
                if (!this.splitterDrag) return;
                const timer = win.setTimeout(() => {
                    this.timers.delete(timer);
                    this.splitterDrag = false;
                }, 0);
                this.timers.add(timer);
            };
            win.addEventListener('mousedown', onMouseDown, true);
            win.addEventListener('mouseup', onMouseUp, true);
            this.removeSplitterListeners = () => {
                win.removeEventListener('mousedown', onMouseDown, true);
                win.removeEventListener('mouseup', onMouseUp, true);
            };
        }
        this.unsubscribePreferences ??= store.sub(preferencesRevisionAtom, () => {
            if (this.saveTimer !== null) return;
            const stored = readStoredWidth();
            if (stored && stored !== this.width) {
                this.width = stored;
                this.applyWidth();
            }
        });
    }

    private toggleButton(): HTMLElement | null {
        const win = this.getWindow();
        if (!win || win.closed || !win.document) return null;
        return win.document.querySelector("#zotero-beaver-tb-chat-toggle");
    }

    public updateToolbarButton(isVisible: boolean): void {
        const button = this.toggleButton();
        // `selected` is a boolean XUL attribute as of Zotero 11 (Firefox 153):
        // presence alone selects, so toggle it rather than writing "true".
        button?.toggleAttribute("selected", isVisible);
        // Expose the open/closed state to screen readers as a toggle button.
        button?.setAttribute("aria-pressed", isVisible ? "true" : "false");
    }

    /**
     * Announce the sidebar open/closed state to screen readers via a polite
     * live region in the main window. Only call this for genuine user toggles
     * (not initial render or shutdown) to avoid spurious announcements.
     */
    public announceSidebarState(isVisible: boolean): void {
        try {
            const win = this.getWindow();
            if (!win || win.closed || !win.document) {
                return;
            }
            const region = this.getLiveRegion(win);
            if (!region) {
                return;
            }
            const message = isVisible ? "Beaver panel opened" : "Beaver panel closed";
            // Clear then set so an identical, repeated message is still announced.
            region.textContent = "";
            const timer = win.setTimeout(() => {
                this.timers.delete(timer);
                if (win.__beaverRuntime?.status !== 'closing') region.textContent = message;
            }, 50);
            this.timers.add(timer);
        } catch (e) {
            // Silently handle errors
        }
    }

    /**
     * Move focus to the toolbar toggle button. Used when the panel closes so
     * keyboard/screen-reader users land on a predictable, visible control
     * instead of losing focus to the hidden sidebar content.
     */
    public focusToggleButton(): void {
        try {
            this.toggleButton()?.focus();
        } catch (e) {
            // Silently handle errors
        }
    }

    private getLiveRegion(win: Window): HTMLElement | null {
        try {
            let region = win.document.getElementById("beaver-a11y-live-region") as HTMLElement | null;
            if (!region) {
                region = win.document.createElement("div");
                region.id = "beaver-a11y-live-region";
                region.setAttribute("aria-live", "polite");
                region.setAttribute("role", "status");
                region.setAttribute("aria-atomic", "true");
                // Visually hidden, but available to assistive technology.
                region.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;";
                win.document.documentElement.appendChild(region);
            }
            return region;
        } catch (e) {
            return null;
        }
    }

    /** Whether the sidebar is shown in `pane`. */
    public isShownIn(pane: Element): boolean {
        return this.host?.pane === pane && !!this.mount && this.mount.style.display !== 'none';
    }

    /**
     * Show or hide the sidebar, in the pane of the selected tab. Safe to call
     * repeatedly: it only changes what differs from `state`.
     */
    public updateUI(state: UIState): void {
        if (!tryGetWindowRuntime()) return;
        const win = this.getWindow();
        if (!win || win.closed || !win.document) return;
        this.scopeContextPaneTabEvents();
        this.watchSettings(win);
        this.state = state;
        this.updateToolbarButton(state.isVisible);

        const location: SidebarLocation = state.isLibraryTab ? 'library' : 'reader';
        // A Zotero 11 library tab has no item pane while its view is loading.
        const parent = location === 'library' ? activeItemPane(win) : readerMountParent(win);
        const pane = location === 'library'
            ? parent
            : win.document.getElementById('zotero-context-pane');
        const mount = this.mount;
        const show = state.isVisible && !!mount && !!parent && !!pane;
        const moving = !!mount && !!parent && mount.parentElement !== parent;

        // Read the scroll offsets before anything changes the sidebar's size:
        // the browser re-anchors them as the content re-wraps. Offsets still
        // waiting from the previous move are the latest ones.
        let scroll: ScrollSnapshot = [];
        if (moving && show && mount!.style.display !== 'none') {
            scroll = this.pendingScroll.length ? this.pendingScroll : captureScroll(mount!);
        }

        if (this.host && (!show || this.host.location !== location || this.host.pane !== pane)) {
            this.releaseHost();
        }
        if (!mount) return;
        // Open the pane before moving in: a collapsed pane gives the sidebar no
        // size, which resets its scroll offsets and reads to the thread as a
        // reader who has reached the bottom.
        if (show) this.openHost(location, pane!);
        if (moving) parent!.appendChild(mount);
        if (!show) {
            this.scrollObserver?.disconnect();
            this.scrollObserver = null;
            this.pendingScroll = [];
            mount.style.display = 'none';
            return;
        }
        this.coverHost(parent!, moving);
        mount.style.removeProperty('display');
        if (scroll.length) this.restoreScrollWhenLaidOut(mount, scroll);
    }

    /**
     * Write scroll offsets back once the sidebar has a size. A pane can still
     * be collapsed when the sidebar moves in — Zotero opens the context pane
     * for a reader tab after Beaver has moved the sidebar there — and opening
     * it lays the sidebar out again, dropping any offsets given before.
     */
    private restoreScrollWhenLaidOut(mount: HTMLElement, scroll: ScrollSnapshot): void {
        this.scrollObserver?.disconnect();
        this.scrollObserver = null;
        this.pendingScroll = [];
        const win = this.getWindow();
        if (hasSize(mount) || typeof win.ResizeObserver !== 'function') {
            restoreScroll(scroll);
            return;
        }
        this.pendingScroll = scroll;
        const observer = new win.ResizeObserver(() => {
            if (!hasSize(mount)) return;
            observer.disconnect();
            if (this.scrollObserver === observer) this.scrollObserver = null;
            restoreScroll(this.pendingScroll);
            this.pendingScroll = [];
        });
        this.scrollObserver = observer;
        observer.observe(mount);
    }

    /** Take over `pane` for the sidebar, and open it if it is collapsed. */
    private openHost(location: SidebarLocation, pane: HTMLElement): void {
        const win = this.getWindow();
        const host = this.host ??= {
            location, pane, openedCollapsed: false,
            nativeStyleWidth: null, nativeWidthAttr: null, nativeFlexShrink: '',
            neighbour: null, dragged: false, widthObserver: null,
        };
        if (location === 'library') {
            const itemPane = pane as HTMLElement & { collapsed?: boolean };
            if (itemPane.collapsed) {
                itemPane.collapsed = false;
                host.openedCollapsed = true;
            }
            return;
        }
        const contextPane = win.ZoteroContextPane;
        // @ts-ignore: collapsed is not typed
        if (contextPane?.collapsed) {
            contextPane.togglePane();
            host.openedCollapsed = true;
        }
        if (isTableTabSelected(win)) {
            // On a Beaver table tab the context pane holds only Beaver's chat.
            openTableTabContextPane(win);
        } else {
            // A library tab collapses the pane, and Zotero opens it for the
            // selected tab only after Beaver has seen the selection.
            pane.removeAttribute('collapsed');
            win.document.getElementById('zotero-context-pane-inner')?.removeAttribute('collapsed');
        }
    }

    /** Hide the occupied pane's own content behind the sidebar, and size the pane. */
    private coverHost(parent: HTMLElement, moved: boolean): void {
        if (moved && this.host?.location === 'reader') {
            // A layout change moves the sidebar to the other reader parent:
            // show the content it hid in the one it left.
            restoreReaderSiblings(this.getWindow());
        }
        for (const child of Array.from(parent.children)) {
            if (child !== this.mount) (child as HTMLElement).style.display = 'none';
        }
        this.applyWidth();
    }

    /** Give the pane back to Zotero: its own content, width and collapsed state. */
    private releaseHost(): void {
        const host = this.host;
        if (!host) return;
        this.restorePaneWidth(host);
        this.host = null;
        const win = this.getWindow();
        if (host.location === 'library') {
            for (const child of Array.from(host.pane.children)) {
                if (child !== this.mount) (child as HTMLElement).style.removeProperty('display');
            }
            if (host.openedCollapsed) (host.pane as HTMLElement & { collapsed?: boolean }).collapsed = true;
            return;
        }
        restoreReaderSiblings(win);
        const contextPane = win.ZoteroContextPane;
        // @ts-ignore: collapsed is not typed
        if (host.openedCollapsed && contextPane && !contextPane.collapsed) contextPane.togglePane();
        // Closing the chat must not uncover the last reader's item.
        if (isTableTabSelected(win)) collapseTableTabContextPane(win);
    }

    /** Give the occupied pane the sidebar width, in the standard layout. */
    private applyWidth(): void {
        const host = this.host;
        if (!host) return;
        if (isStackedLayout()) {
            this.restorePaneWidth(host);
            return;
        }
        this.width ||= readStoredWidth();
        if (!this.width) {
            // The first time the sidebar is shown it keeps the width it opens at.
            const measured = Math.round(host.pane.getBoundingClientRect().width);
            if (measured <= 0) return;
            this.width = measured;
            this.scheduleWidthSave();
        }
        if (host.nativeStyleWidth === null) {
            host.nativeStyleWidth = host.pane.style.width;
            host.nativeWidthAttr = widthAttribute(host.pane);
            host.nativeFlexShrink = host.pane.style.flexShrink;
            const splitter = host.pane.previousElementSibling;
            const neighbour = splitter?.localName === 'splitter'
                ? splitter.previousElementSibling as HTMLElement | null
                : null;
            host.neighbour = neighbour
                ? { element: neighbour, styleWidth: neighbour.style.width, widthAttr: widthAttribute(neighbour) }
                : null;
            host.dragged = false;
        }
        const css = `${this.width}px`;
        if (host.pane.style.width !== css) host.pane.style.width = css;
        if (host.pane.style.flexShrink !== PANE_FLEX_SHRINK) host.pane.style.flexShrink = PANE_FLEX_SHRINK;
        clearNeighbourWidth(host);
        if (!host.widthObserver) {
            const observer = new (this.getWindow().MutationObserver)((records: MutationRecord[]) => this.onPaneWidthChange(host, records));
            observer.observe(host.pane, { attributes: true, attributeFilter: ['width', 'style'] });
            host.widthObserver = observer;
        }
    }

    /**
     * Keep the sidebar width on the pane it occupies.
     *
     * A splitter drag writes the dragged size to the pane's `width` attribute
     * and its inline width: that is the user resizing the sidebar, and becomes
     * the sidebar width. The attribute is then put back, because Zotero
     * persists it as its own width for the pane. A width written outside a
     * drag is Zotero sizing its own pane, and is kept as the pane's width for
     * when the sidebar leaves it. Any inline width other than the sidebar's is
     * then replaced by the sidebar width.
     */
    private onPaneWidthChange(host: Host, records: MutationRecord[]): void {
        if (this.host !== host || host.nativeStyleWidth === null || isStackedLayout()) return;
        const pane = host.pane;
        const attr = widthAttribute(pane);
        // A drag can end on Zotero's own width, so a write is looked for even
        // when the value is unchanged.
        const attrWritten = attr !== host.nativeWidthAttr
            || records.some(record => record.attributeName === 'width');
        // A splitter marks itself as dragging while it writes sizes, which also
        // covers a drag that began without a mousedown this code saw.
        const dragging = this.splitterDrag
            || pane.previousElementSibling?.getAttribute('state') === 'dragging';
        if (attrWritten && dragging) {
            // A splitter writes the inline width too; the attribute this code
            // puts back does not, and is no new size.
            const dragged = pane.style.width === `${attr}px` ? Number(attr) : 0;
            if (dragged > 0) {
                this.width = Math.round(dragged);
                this.scheduleWidthSave();
                host.dragged = true;
            }
            if (attr !== host.nativeWidthAttr) {
                if (host.nativeWidthAttr === null) pane.removeAttribute('width');
                else pane.setAttribute('width', host.nativeWidthAttr);
            }
        } else if (attrWritten) {
            // Zotero sizing its own pane: restoring the width it saved, or
            // raising it to its minimum. That is the pane's width from now on.
            host.nativeWidthAttr = attr;
            if (pane.style.width !== `${this.width}px`) host.nativeStyleWidth = pane.style.width;
        }
        const css = `${this.width}px`;
        if (this.width && pane.style.width !== css) pane.style.width = css;
        if (pane.style.flexShrink !== PANE_FLEX_SHRINK) pane.style.flexShrink = PANE_FLEX_SHRINK;
        // A drag writes the other side of the splitter too.
        clearNeighbourWidth(host);
    }

    /** Put back the pane's own width, unless Zotero has since set another. */
    private restorePaneWidth(host: Host): void {
        const observer = host.widthObserver;
        if (observer) {
            // A splitter's last write may not have been seen yet.
            const records = observer.takeRecords();
            if (records.length) this.onPaneWidthChange(host, records);
            observer.disconnect();
            host.widthObserver = null;
        }
        if (host.nativeStyleWidth === null) return;
        if (host.pane.style.width === `${this.width}px`) {
            if (host.nativeStyleWidth) host.pane.style.width = host.nativeStyleWidth;
            else host.pane.style.removeProperty('width');
        }
        if (host.pane.style.flexShrink === PANE_FLEX_SHRINK) {
            if (host.nativeFlexShrink) host.pane.style.flexShrink = host.nativeFlexShrink;
            else host.pane.style.removeProperty('flex-shrink');
        }
        // The other side of the splitter gets back the width it had beside the
        // pane's own; a drag also wrote its `width` attribute, which Zotero persists.
        const neighbour = host.neighbour;
        if (neighbour) {
            if (neighbour.styleWidth) neighbour.element.style.width = neighbour.styleWidth;
            else neighbour.element.style.removeProperty('width');
            if (host.dragged) {
                if (neighbour.widthAttr === null) neighbour.element.removeAttribute('width');
                else neighbour.element.setAttribute('width', neighbour.widthAttr);
            }
        }
        host.nativeStyleWidth = null;
        host.nativeWidthAttr = null;
        host.neighbour = null;
        host.dragged = false;
    }

    private scheduleWidthSave(): void {
        const win = this.getWindow();
        if (this.saveTimer !== null) win.clearTimeout(this.saveTimer);
        this.saveTimer = win.setTimeout(() => this.saveWidth(), WIDTH_SAVE_DELAY_MS);
    }

    private saveWidth(): void {
        this.saveTimer = null;
        if (this.width && this.width !== readStoredWidth()) setPref('sidebarWidth', this.width);
    }

    /** Remove this renderer's subscriptions, timers and DOM references. */
    public cleanup(): void {
        this.restoreContextPaneTabHandler?.();
        this.restoreContextPaneTabHandler = undefined;
        if (this.layoutObserver !== undefined) {
            Zotero.Prefs.unregisterObserver?.(this.layoutObserver as any);
            this.layoutObserver = undefined;
        }
        this.unsubscribePreferences?.();
        this.unsubscribePreferences = undefined;
        this.removeSplitterListeners?.();
        this.removeSplitterListeners = undefined;
        this.splitterDrag = false;
        for (const timer of this.timers) this.hostWindow?.clearTimeout(timer);
        this.timers.clear();
        this.scrollObserver?.disconnect();
        this.scrollObserver = null;
        this.pendingScroll = [];
        if (this.saveTimer !== null) {
            this.hostWindow?.clearTimeout(this.saveTimer);
            this.saveWidth();
        }
        if (!this.hostWindow) return;

        // Only do UI cleanup if window is still valid
        const win = this.getWindow();
        if (win && !win.closed) {
            try {
                this.releaseHost();
                if (this.mount) this.mount.style.display = 'none';
                this.toggleButton()?.remove();
                win.document.getElementById("beaver-a11y-live-region")?.remove();
            } catch (e) {
                // Ignore UI cleanup errors during shutdown
            }
        }
        this.host = null;
        this.mount = null;
        this.state = null;
    }
}

// Export a singleton instance
export const uiManager = new UIManager();
