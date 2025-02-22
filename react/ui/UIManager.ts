import { DOMElements, SidebarLocation, UIState, CollapseState } from './types';

class UIManager {
    private elements: DOMElements;
    private collapseState: CollapseState;

    constructor() {
        this.collapseState = {
            library: null,
            reader: null
        };
        this.elements = this.initializeElements();
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

    private updateToolbarButton(isVisible: boolean): void {
        if (isVisible) {
            this.elements.chatToggleButton?.setAttribute("selected", "true");
        } else {
            this.elements.chatToggleButton?.removeAttribute("selected");
        }
    }

    private handleLibraryPane(show: boolean): void {
        const itemPane = Zotero.getMainWindow().ZoteroPane.itemPane;
        
        if (show && itemPane) {
            // Store current collapse state
            this.collapseState.library = itemPane?.collapsed || null;
            
            // Uncollapse if needed
            if (this.collapseState.library && itemPane) {
                itemPane.collapsed = false;
            }
            
            // Update visibility
            this.elements.libraryContent?.forEach(el => (el as HTMLElement).style.display = 'none');
            if (this.elements.librarySidebar) {
                (this.elements.librarySidebar as HTMLElement).style.removeProperty('display');
            }
        } else {
            // Restore visibility
            this.elements.libraryContent?.forEach(el => (el as HTMLElement).style.removeProperty('display'));
            if (this.elements.librarySidebar) {
                (this.elements.librarySidebar as HTMLElement).style.display = 'none';
            }
            
            // Restore collapse state
            if (this.collapseState.library && itemPane) {
                itemPane.collapsed = true;
            }
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
            }
        } else {
            // Restore visibility
            this.elements.readerContent?.forEach(el => (el as HTMLElement).style.removeProperty('display'));
            if (this.elements.readerSidebar) {
                (this.elements.readerSidebar as HTMLElement).style.display = 'none';
            }
            
            // Restore collapse state
            // @ts-ignore: collapsed is not typed
            if (this.collapseState.reader && !readerPane.collapsed) {
                readerPane.togglePane();
            }
        }
    }

    public updateUI(state: UIState): void {
        this.updateToolbarButton(state.isVisible);
        
        if (state.isVisible) {
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
        // Restore all UI elements to their original state
        this.handleLibraryPane(false);
        this.handleReaderPane(false);
        this.updateToolbarButton(false);
    }
}

// Export a singleton instance
export const uiManager = new UIManager(); 