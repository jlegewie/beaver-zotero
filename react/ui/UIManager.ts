import { DOMElements, SidebarLocation, UIState, CollapseState } from './types';
import { applyReaderPaneVisibility, isStackedLayout } from '../utils/zoteroLayout';
import { getPref, setPref } from '../../src/utils/prefs';

const MIN_CUSTOM_WIDTH = 200;
const MAX_CUSTOM_WIDTH = 2000;
const DEFAULT_CUSTOM_WIDTH = 500;

function clampCustomWidth(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_CUSTOM_WIDTH;
    return Math.max(MIN_CUSTOM_WIDTH, Math.min(MAX_CUSTOM_WIDTH, Math.round(value)));
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
    private originalOnChangeSidebarWidth: ((...args: any[]) => void) | null = null;
    private isReaderWidthHandlerOverridden = false;

    // Custom Beaver pane width state. When `useCustomBeaverSidebarWidth` is set,
    // the Zotero right pane is forced to `customBeaverSidebarWidth` while Beaver
    // is open and restored to the previous Zotero width on close.
    private savedZoteroWidth: { library: number | null; reader: number | null } = {
        library: null,
        reader: null
    };
    private customWidthApplied: { library: boolean; reader: boolean } = {
        library: false,
        reader: false
    };
    private paneWidthObservers: { library: any | null; reader: any | null } = {
        library: null,
        reader: null
    };
    // Suppresses the resize observer while we apply our own width changes so
    // we don't echo programmatic widths back into the user pref. Using a
    // timestamp instead of a counter avoids leak/imbalance bugs when multiple
    // programmatic writes overlap.
    private suppressObserverUntil = 0;
    private static readonly SUPPRESS_WINDOW_MS = 250;

    constructor() {
        this.collapseState = {
            library: null,
            reader: null
        };
        this.elements = this.initializeElements();
    }

    private initSidebarWidthTracking(): void {
        try {
            if (this.isReaderWidthHandlerOverridden || !Zotero?.Reader) {
                return;
            }

            const readerSidebarWidth = Zotero.Reader.getSidebarWidth?.();
            if (readerSidebarWidth) {
                this.sidebarWidth = readerSidebarWidth;
            }

            const originalHandler = (Zotero.Reader as any).onChangeSidebarWidth;
            this.originalOnChangeSidebarWidth = typeof originalHandler === "function"
                ? originalHandler
                : null;

            // Override the reader's width change handler only after startup is ready.
            Zotero.Reader.onChangeSidebarWidth = (width: number) => {
                if (this.originalOnChangeSidebarWidth) {
                    this.originalOnChangeSidebarWidth.call(Zotero.Reader, width);
                }
                setTimeout(() => this.enforceConsistentWidth(), 50);
            };
            this.isReaderWidthHandlerOverridden = true;
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

    private getZoteroPaneElement(location: SidebarLocation): HTMLElement | null {
        try {
            const win = Zotero?.getMainWindow?.();
            if (!win || win.closed || !win.document) return null;
            const id = location === 'library' ? 'zotero-item-pane' : 'zotero-context-pane';
            return win.document.getElementById(id) as HTMLElement | null;
        } catch (e) {
            return null;
        }
    }

    private setZoteroPaneWidth(paneEl: HTMLElement, width: number): void {
        // Suppress the resize observer while our programmatic write settles.
        // ResizeObserver callbacks fire on the next paint, so we suppress for
        // a short window after each write.
        this.suppressObserverUntil = Date.now() + UIManager.SUPPRESS_WINDOW_MS;
        paneEl.setAttribute('width', String(width));
        paneEl.style.width = `${width}px`;
    }

    private startObservingPaneWidth(location: SidebarLocation, paneEl: HTMLElement): void {
        try {
            this.stopObservingPaneWidth(location);
            const win = Zotero.getMainWindow();
            const ResizeObserverCtor = (win as any)?.ResizeObserver;
            if (!ResizeObserverCtor) return;

            // Debounce so a splitter drag persists once at the end rather than
            // 60+ times per second.
            let debounceTimer: number | null = null;
            let lastObservedWidth = 0;

            const observer = new ResizeObserverCtor((entries: any[]) => {
                if (Date.now() < this.suppressObserverUntil) return;
                const entry = entries[0];
                const width = Math.round(entry?.contentRect?.width || paneEl.offsetWidth || 0);
                if (width <= 0) return;
                lastObservedWidth = width;

                if (debounceTimer !== null) {
                    try { win.clearTimeout(debounceTimer); } catch (e) { /* ignore */ }
                }
                debounceTimer = win.setTimeout(() => {
                    debounceTimer = null;
                    if (!getPref('useCustomBeaverSidebarWidth')) return;
                    if (Date.now() < this.suppressObserverUntil) return;
                    const currentPref = clampCustomWidth(Number(getPref('customBeaverSidebarWidth')));
                    if (Math.abs(lastObservedWidth - currentPref) > 2) {
                        setPref('customBeaverSidebarWidth', clampCustomWidth(lastObservedWidth));
                    }
                }, 150);
            });
            observer.observe(paneEl);
            this.paneWidthObservers[location] = {
                observer,
                disconnect: () => {
                    if (debounceTimer !== null) {
                        try { win.clearTimeout(debounceTimer); } catch (e) { /* ignore */ }
                        debounceTimer = null;
                    }
                    try { observer.disconnect(); } catch (e) { /* ignore */ }
                }
            };
        } catch (e) {
            // Silently handle errors
        }
    }

    private stopObservingPaneWidth(location: SidebarLocation): void {
        const wrapper = this.paneWidthObservers[location];
        if (wrapper) {
            try { wrapper.disconnect(); } catch (e) { /* ignore */ }
            this.paneWidthObservers[location] = null;
        }
    }

    /**
     * Force the Zotero right pane to the user-configured Beaver width while
     * Beaver is open, and restore the original Zotero width when it closes.
     *
     * Skipped in stacked layout where the pane has height rather than width.
     */
    private applyCustomBeaverWidth(location: SidebarLocation, show: boolean): void {
        try {
            // Stacked layout: the right pane uses height, not width
            if (isStackedLayout()) {
                this.stopObservingPaneWidth(location);
                this.savedZoteroWidth[location] = null;
                this.customWidthApplied[location] = false;
                return;
            }

            const useCustom = !!getPref('useCustomBeaverSidebarWidth');
            const paneEl = this.getZoteroPaneElement(location);
            if (!paneEl) return;

            if (show) {
                if (!useCustom) {
                    // Pref disabled: ensure no override is active
                    if (this.customWidthApplied[location]) {
                        this.stopObservingPaneWidth(location);
                        const saved = this.savedZoteroWidth[location];
                        if (saved && saved > 0) {
                            this.setZoteroPaneWidth(paneEl, saved);
                        }
                        this.savedZoteroWidth[location] = null;
                        this.customWidthApplied[location] = false;
                    }
                    return;
                }

                // Save the original Zotero width on first activation only
                if (this.savedZoteroWidth[location] == null) {
                    const attrWidth = parseInt(paneEl.getAttribute('width') || '0', 10);
                    const measured = paneEl.getBoundingClientRect().width || paneEl.offsetWidth || 0;
                    const original = attrWidth > 0 ? attrWidth : Math.round(measured);
                    if (original > 0) {
                        this.savedZoteroWidth[location] = original;
                    }
                }

                const customWidth = clampCustomWidth(Number(getPref('customBeaverSidebarWidth')));
                this.setZoteroPaneWidth(paneEl, customWidth);
                this.customWidthApplied[location] = true;
                this.startObservingPaneWidth(location, paneEl);
            } else {
                this.stopObservingPaneWidth(location);
                if (this.customWidthApplied[location]) {
                    const saved = this.savedZoteroWidth[location];
                    if (saved && saved > 0) {
                        this.setZoteroPaneWidth(paneEl, saved);
                    }
                }
                this.savedZoteroWidth[location] = null;
                this.customWidthApplied[location] = false;
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
                // Apply custom Beaver pane width AFTER un-collapsing so we
                // measure the un-collapsed Zotero width when saving the
                // original value.
                this.applyCustomBeaverWidth('library', true);
            } else {
                // Restore the original Zotero pane width BEFORE collapsing so
                // the persisted Zotero width reflects the user's Zotero size,
                // not the Beaver-forced width.
                this.applyCustomBeaverWidth('library', false);
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
                this.applyCustomBeaverWidth('reader', true);
            } else {
                this.applyCustomBeaverWidth('reader', false);
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
     * Re-evaluate the custom Beaver width preferences against the currently
     * active pane. Call this after the user changes
     * `useCustomBeaverSidebarWidth` or `customBeaverSidebarWidth` so the
     * change takes effect immediately if Beaver is open.
     */
    public refreshCustomWidth(): void {
        try {
            const win = Zotero?.getMainWindow?.();
            if (!win || win.closed) return;
            const isLibraryTab = win.Zotero_Tabs?.selectedType === 'library';
            const activeLocation: SidebarLocation = isLibraryTab ? 'library' : 'reader';

            // Only the active pane is currently shown; the other pane has
            // already been restored to its Zotero width by handleLibraryPane /
            // handleReaderPane(false).
            const sidebar = activeLocation === 'library'
                ? this.elements.librarySidebar
                : this.elements.readerSidebar;
            const isVisible = !!(sidebar && (sidebar as HTMLElement).style.display !== 'none');
            if (!isVisible) return;

            this.applyCustomBeaverWidth(activeLocation, true);
        } catch (e) {
            // Silently handle errors
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
        // CRITICAL: Restore Zotero.Reader.onChangeSidebarWidth FIRST
        try {
            if (this.isReaderWidthHandlerOverridden && Zotero?.Reader) {
                (Zotero.Reader as any).onChangeSidebarWidth = this.originalOnChangeSidebarWidth;
            }
        } catch (e) {
            // Ignore errors during cleanup
        } finally {
            this.originalOnChangeSidebarWidth = null;
            this.isReaderWidthHandlerOverridden = false;
        }

        // Disconnect any active pane width observers before tearing down so
        // they can't fire against a torn-down UIManager.
        this.stopObservingPaneWidth('library');
        this.stopObservingPaneWidth('reader');

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
            } catch (e) {
                // Ignore UI cleanup errors during shutdown
            }
        }

        // Clear width override state
        this.savedZoteroWidth = { library: null, reader: null };
        this.customWidthApplied = { library: false, reader: false };
        this.suppressObserverUntil = 0;

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
