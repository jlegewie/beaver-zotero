import { DOMElements, SidebarLocation, UIState, CollapseState } from './types';

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
            Zotero.Reader.onChangeSidebarWidth = () => {
                if (this.originalOnChangeSidebarWidth) {
                    this.originalOnChangeSidebarWidth.call(Zotero.Reader);
                }
                setTimeout(() => this.enforceConsistentWidth(), 50);
            };
            this.isReaderWidthHandlerOverridden = true;
        } catch (e) {
            // Silently handle initialization errors
        }
    }

    private enforceConsistentWidth(): void {
        try {
            if (this.elements.librarySidebar) {
                (this.elements.librarySidebar as HTMLElement).style.width = `${this.sidebarWidth}px`;
            }
            if (this.elements.readerSidebar) {
                (this.elements.readerSidebar as HTMLElement).style.width = `${this.sidebarWidth}px`;
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
        this.elements.readerContent?.forEach(el => (el as HTMLElement).style.removeProperty('display'));
        if (this.elements.readerSidebar) {
            (this.elements.readerSidebar as HTMLElement).style.display = 'none';
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
                    (this.elements.librarySidebar as HTMLElement).style.width = `${this.sidebarWidth}px`;
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
                this.elements.readerContent?.forEach(el => (el as HTMLElement).style.display = 'none');
                if (this.elements.readerSidebar) {
                    (this.elements.readerSidebar as HTMLElement).style.removeProperty('display');
                    (this.elements.readerSidebar as HTMLElement).style.width = `${this.sidebarWidth}px`;
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
