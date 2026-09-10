import { getHostWindow, getWindowRuntime, tryGetWindowRuntime } from '../runtime/windowRuntime';
import { DOMElements, SidebarLocation, UIState, CollapseState } from './types';
import { applyReaderPaneVisibility, isStackedLayout } from '../utils/zoteroLayout';

class UIManager {
    private elements: DOMElements;
    private collapseState: CollapseState;
    private sidebarWidth: number = 350;
    private unsubscribeWidth?: () => void;
    private timers = new Set<number>();
    private hostWindow?: Window;
    private restoreContextPaneTabHandler?: () => void;

    constructor() {
        this.collapseState = { library: null, reader: null };
        this.elements = this.emptyElements();
    }

    private getWindow(): Window {
        return this.hostWindow ??= getHostWindow();
    }

    private scheduleWidth(): void {
        const win = this.getWindow();
        const timer = win.setTimeout(() => {
            this.timers.delete(timer);
            if (win.__beaverRuntime?.status !== 'closing') this.enforceConsistentWidth();
        }, 50);
        this.timers.add(timer);
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

    private initSidebarWidthTracking(): void {
        this.sidebarWidth = Zotero.Reader.getSidebarWidth?.() || this.sidebarWidth;
        this.unsubscribeWidth ??= Zotero.Beaver.runtime.subscribeReaderWidth(
            getWindowRuntime(), () => this.scheduleWidth(),
        );
    }

    private emptyElements(): DOMElements {
        return { chatToggleButton: null, libraryPane: null, libraryContent: null,
            librarySidebar: null, readerPane: null, readerContent: null, readerSidebar: null };
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
            const win = this.getWindow();
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
        // `selected` is a boolean XUL attribute as of Zotero 11 (Firefox 153):
        // presence alone selects, so toggle it rather than writing "true".
        this.elements.chatToggleButton?.toggleAttribute("selected", isVisible);
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
            const win = this.getWindow();
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
        const win = this.getWindow();
        if (win && !win.closed) {
            applyReaderPaneVisibility(win, false);
        }
    }

    private handleLibraryPane(show: boolean): void {
        try {
            const win = this.getWindow() as unknown as CustomZoteroWindow;
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
            const win = this.getWindow();
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
        if (!tryGetWindowRuntime()) return;
        this.scopeContextPaneTabEvents();
        this.elements = this.initializeElements();
        this.updateToolbarButton(state.isVisible);
        
        if (state.isVisible) {
            this.initSidebarWidthTracking();
            this.scheduleWidth();
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

    /** Remove this renderer's subscription, timers and DOM references. */
    public cleanup(): void {
        this.restoreContextPaneTabHandler?.();
        this.restoreContextPaneTabHandler = undefined;
        this.unsubscribeWidth?.();
        this.unsubscribeWidth = undefined;
        for (const timer of this.timers) this.hostWindow?.clearTimeout(timer);
        this.timers.clear();
        if (!this.hostWindow) return;

        // Only do UI cleanup if window is still valid
        const win = this.getWindow();
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
