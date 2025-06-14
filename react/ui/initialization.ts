import { uiManager } from './UIManager';

export function initializeReactUI(win: Window) {
    // Set initial UI state
    const isLibraryTab = win.Zotero_Tabs.selectedType === 'library';
    uiManager.updateUI({
        isVisible: false,
        isLibraryTab,
        collapseState: {
            library: null,
            reader: null
        }
    });
}

export function cleanupReactUI() {
    uiManager.cleanup();
} 