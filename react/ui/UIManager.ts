import { DOMElements, SidebarLocation, UIState, CollapseState } from './types';

class UIManager {
    private elements: DOMElements;
    private collapseState: CollapseState;
    private sidebarWidth: number = 350;
    private activeTimeouts: Set<NodeJS.Timeout> = new Set();

    constructor() {
        this.collapseState = {
            library: null,
            reader: null
        };
        this.elements = this.initializeElements();

        // Initialize sidebar width tracking
        this.initSidebarWidthTracking();
    }

    private initSidebarWidthTracking(): void {
        // Observe width changes and maintain consistency
        const win = Zotero.getMainWindow();
        if (win) {
            // Store initial width from reader sidebar if available
            const readerSidebarWidth = Zotero.Reader.getSidebarWidth();
            if (readerSidebarWidth) {
                this.sidebarWidth = readerSidebarWidth;
            }
            
            // Override the reader's width change handler to maintain fixed width
            const originalOnChangeSidebarWidth = Zotero.Reader.onChangeSidebarWidth;
            Zotero.Reader.onChangeSidebarWidth = (width) => {
                // Only call the original handler with our fixed width
                if (originalOnChangeSidebarWidth) {
                    originalOnChangeSidebarWidth(this.sidebarWidth);
                }
                
                // Force our desired width after a short delay
                const timeout = setTimeout(() => {
                    this.enforceConsistentWidth();
                    this.activeTimeouts.delete(timeout);
                }, 50);
                this.activeTimeouts.add(timeout);
            };
        }
    }

    private enforceConsistentWidth(): void {
        // Apply consistent width to both sidebars
        if (this.elements.librarySidebar) {
            (this.elements.librarySidebar as HTMLElement).style.width = `${this.sidebarWidth}px`;
        }
        
        if (this.elements.readerSidebar) {
            (this.elements.readerSidebar as HTMLElement).style.width = `${this.sidebarWidth}px`;
            
            // Force reader to use our width
            // Zotero.Reader.setSidebarWidth(this.sidebarWidth);
        }
    }

    private initializeElements(): DOMElements {
        const win = Zotero.getMainWindow();
        const itemPane = win.document.querySelector("#zotero-item-pane") as HTMLElement | null;
        const readerPane = win.document.querySelector("#zotero-context-pane") as HTMLElement | null;
        return {
            chatToggleButton: win.document.querySelector("#zotero-beaver-tb-chat-toggle"),
            libraryPane: itemPane,
            libraryContent: itemPane ? itemPane.querySelectorAll(":scope > *:not(#beaver-pane-library)") : null,
            librarySidebar: itemPane ? itemPane.querySelector("#beaver-pane-library") : null,
            readerPane: readerPane,
            readerContent: readerPane ? readerPane.querySelectorAll(":scope > *:not(#beaver-pane-reader)") : null,
            readerSidebar: readerPane ? readerPane.querySelector("#beaver-pane-reader") : null
        };
    }

    public updateToolbarButton(isVisible: boolean): void {
        if (isVisible) {
            this.elements.chatToggleButton?.setAttribute("selected", "true");
        } else {
            this.elements.chatToggleButton?.removeAttribute("selected");
        }
    }

    public handleCleanup(location: SidebarLocation): void {
        // Handle DOM cleanup after collapse
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
        const win = Zotero.getMainWindow() as unknown as CustomZoteroWindow;
        const itemPane = win.ZoteroPane.itemPane;
        
        if (show && itemPane) {
            // Store current collapse state
            this.collapseState.library = itemPane?.collapsed || null;
            
            // Uncollapse if needed
            if (this.collapseState.library) {
                itemPane.collapsed = false;
            }
            
            // Update visibility
            this.elements.libraryContent?.forEach(el => (el as HTMLElement).style.display = 'none');
            if (this.elements.librarySidebar) {
                (this.elements.librarySidebar as HTMLElement).style.removeProperty('display');
                (this.elements.librarySidebar as HTMLElement).style.width = `${this.sidebarWidth}px`;
            }
        } else {
            // Restore collapse state
            if (this.collapseState.library && itemPane) {
                // collapse triggers a mutation observer that updates the UI
                itemPane.collapsed = true;
                return;
            }

            // Cleanup the library pane
            this.handleLibraryCleanup();
        }
    }

    private handleReaderPane(show: boolean): void {
        const readerPane = Zotero.getMainWindow().ZoteroContextPane;
        
        if (show) {
            // Store current collapse state
            // @ts-ignore: collapsed is not typed
            this.collapseState.reader = readerPane.collapsed || null;
            
            // Uncollapse if needed
            if (this.collapseState.reader) {
                readerPane.togglePane();
            }
            
            // Update visibility
            this.elements.readerContent?.forEach(el => (el as HTMLElement).style.display = 'none');
            if (this.elements.readerSidebar) {
                (this.elements.readerSidebar as HTMLElement).style.removeProperty('display');
                (this.elements.readerSidebar as HTMLElement).style.width = `${this.sidebarWidth}px`;
                // Force Zotero to use our fixed width
                // Zotero.Reader.setSidebarWidth(this.sidebarWidth);
            }
        } else {
            // Restore collapse state
            // @ts-ignore: collapsed is not typed
            if (this.collapseState.reader && !readerPane.collapsed) {
                // collapse triggers a mutation observer that updates the UI
                readerPane.togglePane();
                return;
            }

            // Cleanup the reader pane
            this.handleReaderCleanup();
        }
    }

    public updateUI(state: UIState): void {
        this.updateToolbarButton(state.isVisible);
        
        if (state.isVisible) {
            const timeout = setTimeout(() => {
                this.enforceConsistentWidth();
                this.activeTimeouts.delete(timeout);
            }, 50);
            this.activeTimeouts.add(timeout);
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

    public cleanup(): void {
        // Clear all active timeouts
        for (const timeout of this.activeTimeouts) {
            clearTimeout(timeout);
        }
        this.activeTimeouts.clear();

        // Restore all UI elements to their original state
        this.handleLibraryPane(false);
        this.handleReaderPane(false);
        this.updateToolbarButton(false);

        // Restore original onChangeSidebarWidth if needed
        const win = Zotero.getMainWindow();
        if (win && this.originalOnChangeSidebarWidth) {
            Zotero.Reader.onChangeSidebarWidth = this.originalOnChangeSidebarWidth;
        }
        if (win) {
            const chatToggleButton = win.document.querySelector("#zotero-beaver-tb-chat-toggle") as HTMLElement | null;
            if (chatToggleButton) {
                chatToggleButton.remove();
            }
        }
    }

    // Store the original handler
    private originalOnChangeSidebarWidth = Zotero.Reader.onChangeSidebarWidth;
}

// Export a singleton instance
export const uiManager = new UIManager(); 