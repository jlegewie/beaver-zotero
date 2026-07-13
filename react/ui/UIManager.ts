import { DOMElements, SidebarLocation, UIState, CollapseState } from './types';
import { applyReaderPaneVisibility, isStackedLayout } from '../utils/zoteroLayout';

/**
 * Property stashed on the Beaver-authored `Zotero.Reader.onChangeSidebarWidth`
 * wrapper, holding whatever handler was installed before it (or null — core
 * initializes the slot to null and nothing else assigns it).
 */
const ORIGINAL_HANDLER_PROP = '__beaverOriginalSidebarWidthHandler';

type ReaderWidthHandler = (...args: any[]) => void;

/**
 * Wrappers installed by plugin versions that predate ORIGINAL_HANDLER_PROP
 * carry no marker and keep their original in instance state we cannot reach.
 * They are identified by two property accesses in their source (property
 * names survive minification). Since Zotero core initializes the slot to
 * null and nothing but Beaver assigns it, a legacy chain safely resolves to
 * null — letting an update reclaim compartments pinned by older versions.
 */
function isLegacyBeaverWrapper(fn: unknown): boolean {
    if (typeof fn !== 'function') {
        return false;
    }
    try {
        const src = Function.prototype.toString.call(fn);
        return src.includes('originalOnChangeSidebarWidth')
            && src.includes('enforceConsistentWidth');
    } catch (e) {
        return false;
    }
}

/**
 * Walk a chain of Beaver-authored wrappers down to the true original handler.
 * Returns null when the chain bottoms out at null/non-function, at a legacy
 * Beaver wrapper (see isLegacyBeaverWrapper), or when a wrapper from a
 * torn-down window realm can no longer be inspected — the only handler ever
 * underneath ours is core's initial null, so null is safe.
 */
export function unwrapReaderWidthHandler(handler: unknown): ReaderWidthHandler | null {
    try {
        let current: any = handler;
        while (typeof current === 'function' && ORIGINAL_HANDLER_PROP in current) {
            current = current[ORIGINAL_HANDLER_PROP];
        }
        if (isLegacyBeaverWrapper(current)) {
            return null;
        }
        return typeof current === 'function' ? current : null;
    } catch (e) {
        return null;
    }
}

/**
 * If a Beaver wrapper (installed by any bundle copy or plugin generation) is
 * present on `Zotero.Reader.onChangeSidebarWidth`, restore the original
 * handler so the wrapper's closure — and the compartment it pins — can be
 * garbage-collected. Safe to call repeatedly and from either bundle.
 */
export function restoreReaderSidebarWidthHandler(): void {
    try {
        const reader = Zotero?.Reader as any;
        if (!reader) {
            return;
        }
        const current = reader.onChangeSidebarWidth;
        if (
            typeof current === 'function'
            && (ORIGINAL_HANDLER_PROP in current || isLegacyBeaverWrapper(current))
        ) {
            reader.onChangeSidebarWidth = unwrapReaderWidthHandler(current);
        }
    } catch (e) {
        // Best-effort — never break shutdown.
    }
}

/**
 * UIManager handles the Beaver sidebar UI state and interactions.
 *
 * IMPORTANT: This class replaces Zotero.Reader.onChangeSidebarWidth with a custom
 * handler. The cleanup() method MUST be called during shutdown to restore the
 * original handler, otherwise a SIGSEGV crash will occur when Zotero tries to
 * call the handler after this instance is destroyed.
 */
class UIManager {
    private elements: DOMElements;
    private collapseState: CollapseState;
    private sidebarWidth: number = 350;
    /** The wrapper this instance installed, or null. Compared by identity
     * against the live slot so a wrapper displaced by another window or
     * plugin generation is detected and re-installed instead of assuming a
     * one-time install is permanent. */
    private installedReaderWidthWrapper: ReaderWidthHandler | null = null;

    constructor() {
        this.collapseState = {
            library: null,
            reader: null
        };
        this.elements = this.initializeElements();
    }

    private initSidebarWidthTracking(): void {
        try {
            if (!Zotero?.Reader) {
                return;
            }

            // Skip only while our own wrapper is still current. If another
            // window or plugin generation displaced it, re-install so the
            // stale wrapper is unwound rather than left pinned forever.
            const installed = (Zotero.Reader as any).onChangeSidebarWidth;
            if (
                this.installedReaderWidthWrapper
                && installed === this.installedReaderWidthWrapper
            ) {
                return;
            }

            const readerSidebarWidth = Zotero.Reader.getSidebarWidth?.();
            if (readerSidebarWidth) {
                this.sidebarWidth = readerSidebarWidth;
            }

            // Chain from the true original handler, unwinding any stale
            // Beaver wrapper left by another bundle copy or a previous plugin
            // generation whose cleanup never ran, so the stale wrapper
            // becomes collectable instead of growing a chain on Zotero.Reader.
            const original = unwrapReaderWidthHandler(installed);

            // Override the reader's width change handler only after startup is ready.
            const wrapper = (width: number) => {
                if (original) {
                    original.call(Zotero.Reader, width);
                }
                setTimeout(() => this.enforceConsistentWidth(), 50);
            };
            (wrapper as any)[ORIGINAL_HANDLER_PROP] = original;
            Zotero.Reader.onChangeSidebarWidth = wrapper;
            this.installedReaderWidthWrapper = wrapper;
        } catch (e) {
            // Silently handle initialization errors
        }
    }

    private applyLibrarySidebarWidth(sidebar: HTMLElement): void {
        // In stacked layout, #zotero-item-pane is flex-direction:column, so an
        // explicit pixel width clamps the cross-axis instead of being overridden
        // by flex-grow as it is in the standard (row) layout.
        if (isStackedLayout()) {
            sidebar.style.removeProperty('width');
        } else {
            sidebar.style.width = `${this.sidebarWidth}px`;
        }
    }

    private applyReaderSidebarWidth(sidebar: HTMLElement): void {
        // In stacked layout the reader mount is parented inside the inner
        // vbox (column flex), so an explicit pixel width clamps it. In
        // standard layout flex-grow makes the pixel value harmless but
        // keeps width-tracking from the reader sidebar slider working.
        if (isStackedLayout()) {
            sidebar.style.removeProperty('width');
        } else {
            sidebar.style.width = `${this.sidebarWidth}px`;
        }
    }

    private enforceConsistentWidth(): void {
        try {
            if (this.elements.librarySidebar) {
                this.applyLibrarySidebarWidth(this.elements.librarySidebar as HTMLElement);
            }
            if (this.elements.readerSidebar) {
                this.applyReaderSidebarWidth(this.elements.readerSidebar as HTMLElement);
            }
        } catch (e) {
            // Silently handle errors
        }
    }

    private initializeElements(): DOMElements {
        const emptyElements: DOMElements = {
            chatToggleButton: null,
            libraryPane: null,
            libraryContent: null,
            librarySidebar: null,
            readerPane: null,
            readerContent: null,
            readerSidebar: null
        };

        try {
            const win = Zotero?.getMainWindow?.();
            if (!win || win.closed || !win.document) {
                return emptyElements;
            }

            const itemPane = win.document.querySelector("#zotero-item-pane") as HTMLElement | null;
            const readerPane = win.document.querySelector("#zotero-context-pane") as HTMLElement | null;

            return {
                chatToggleButton: win.document.querySelector("#zotero-beaver-tb-chat-toggle"),
                libraryPane: itemPane,
                libraryContent: itemPane ? itemPane.querySelectorAll(":scope > *:not(#beaver-pane-library)") : null,
                librarySidebar: itemPane ? itemPane.querySelector("#beaver-pane-library") as HTMLElement | null : null,
                readerPane: readerPane,
                readerContent: readerPane ? readerPane.querySelectorAll(":scope > *:not(#beaver-pane-reader)") : null,
                readerSidebar: readerPane ? readerPane.querySelector("#beaver-pane-reader") as HTMLElement | null : null
            };
        } catch (e) {
            return emptyElements;
        }
    }

    public updateToolbarButton(isVisible: boolean): void {
        if (isVisible) {
            this.elements.chatToggleButton?.setAttribute("selected", "true");
        } else {
            this.elements.chatToggleButton?.removeAttribute("selected");
        }
        // Expose the open/closed state to screen readers as a toggle button.
        this.elements.chatToggleButton?.setAttribute("aria-pressed", isVisible ? "true" : "false");
    }

    /**
     * Announce the sidebar open/closed state to screen readers via a polite
     * live region in the main window. Only call this for genuine user toggles
     * (not initial render or shutdown) to avoid spurious announcements.
     */
    public announceSidebarState(isVisible: boolean): void {
        try {
            const win = Zotero.getMainWindow();
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
            win.setTimeout(() => { region.textContent = message; }, 50);
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
            const win = Zotero.getMainWindow();
            if (!win || win.closed || !win.document) {
                return;
            }
            const btn = win.document.querySelector("#zotero-beaver-tb-chat-toggle") as HTMLElement | null;
            btn?.focus();
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

    public handleCleanup(location: SidebarLocation): void {
        if (location === 'library') {
            this.handleLibraryCleanup();
        } else {
            this.handleReaderCleanup();
        }
    }

    private handleLibraryCleanup(): void {
        this.elements.libraryContent?.forEach(el => (el as HTMLElement).style.removeProperty('display'));
        if (this.elements.librarySidebar) {
            (this.elements.librarySidebar as HTMLElement).style.display = 'none';
        }
    }

    private handleReaderCleanup(): void {
        const win = Zotero.getMainWindow();
        if (win && !win.closed) {
            applyReaderPaneVisibility(win, false);
        }
    }

    private handleLibraryPane(show: boolean): void {
        try {
            const win = Zotero.getMainWindow() as unknown as CustomZoteroWindow;
            if (!win || win.closed || !win.ZoteroPane) {
                return;
            }
            const itemPane = win.ZoteroPane.itemPane;
            
            if (show && itemPane) {
                this.collapseState.library = itemPane?.collapsed || null;
                if (this.collapseState.library) {
                    itemPane.collapsed = false;
                }
                this.elements.libraryContent?.forEach(el => (el as HTMLElement).style.display = 'none');
                if (this.elements.librarySidebar) {
                    (this.elements.librarySidebar as HTMLElement).style.removeProperty('display');
                    this.applyLibrarySidebarWidth(this.elements.librarySidebar as HTMLElement);
                }
            } else {
                if (this.collapseState.library && itemPane) {
                    itemPane.collapsed = true;
                    return;
                }
                this.handleLibraryCleanup();
            }
        } catch (e) {
            // Silently handle errors
        }
    }

    private handleReaderPane(show: boolean): void {
        try {
            const win = Zotero.getMainWindow();
            if (!win || win.closed || !win.ZoteroContextPane) {
                return;
            }
            const readerPane = win.ZoteroContextPane;

            if (show) {
                // @ts-ignore: collapsed is not typed
                this.collapseState.reader = readerPane.collapsed || null;
                if (this.collapseState.reader) {
                    readerPane.togglePane();
                }
                applyReaderPaneVisibility(win, true);
                // Refresh cached element ref because applyReaderPaneVisibility
                // may have moved the mount under a different parent in stacked
                // layout.
                this.elements.readerSidebar = win.document.querySelector("#beaver-pane-reader") as HTMLElement | null;
                if (this.elements.readerSidebar) {
                    this.applyReaderSidebarWidth(this.elements.readerSidebar as HTMLElement);
                }
            } else {
                // @ts-ignore: collapsed is not typed
                if (this.collapseState.reader && !readerPane.collapsed) {
                    readerPane.togglePane();
                    return;
                }
                this.handleReaderCleanup();
            }
        } catch (e) {
            // Silently handle errors
        }
    }

    public updateUI(state: UIState): void {
        this.elements = this.initializeElements();
        this.updateToolbarButton(state.isVisible);
        
        if (state.isVisible) {
            this.initSidebarWidthTracking();
            setTimeout(() => this.enforceConsistentWidth(), 50);
            if (state.isLibraryTab) {
                this.handleLibraryPane(true);
                this.handleReaderPane(false);
            } else {
                this.handleLibraryPane(false);
                this.handleReaderPane(true);
            }
        } else {
            this.handleLibraryPane(false);
            this.handleReaderPane(false);
        }
    }

    public handleCollapse(location: SidebarLocation): void {
        if (location === 'library') {
            this.handleLibraryPane(false);
        } else {
            this.handleReaderPane(false);
        }
    }

    /**
     * Clean up UIManager resources.
     * 
     * CRITICAL: This must be called during shutdown to:
     * 1. Restore the original Zotero.Reader.onChangeSidebarWidth handler
     * 2. Clear stale DOM element references
     * 
     * Failure to call this will result in SIGSEGV when Zotero tries to call
     * our custom handler after this instance is destroyed.
     */
    public cleanup(): void {
        // CRITICAL: Restore Zotero.Reader.onChangeSidebarWidth FIRST. The
        // restore is marker-based rather than instance-based because the
        // module copy running cleanup (two bundles, two singletons) may not
        // be the copy that installed the wrapper.
        restoreReaderSidebarWidthHandler();
        this.installedReaderWidthWrapper = null;

        // Only do UI cleanup if window is still valid
        const win = Zotero.getMainWindow();
        if (win && !win.closed) {
            try {
                this.elements = this.initializeElements();
                this.handleLibraryPane(false);
                this.handleReaderPane(false);
                this.updateToolbarButton(false);
                
                const chatToggleButton = win.document.querySelector("#zotero-beaver-tb-chat-toggle") as HTMLElement | null;
                if (chatToggleButton) {
                    chatToggleButton.remove();
                }

                const liveRegion = win.document.getElementById("beaver-a11y-live-region");
                if (liveRegion) {
                    liveRegion.remove();
                }
            } catch (e) {
                // Ignore UI cleanup errors during shutdown
            }
        }

        // Clear stored element references to prevent stale access
        this.elements = {
            chatToggleButton: null,
            libraryPane: null,
            libraryContent: null,
            librarySidebar: null,
            readerPane: null,
            readerContent: null,
            readerSidebar: null
        };
    }
}

// Export a singleton instance
export const uiManager = new UIManager();
