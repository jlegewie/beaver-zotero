import { uiManager } from './UIManager';
import { isLibraryTabSelected } from '../../src/ui/libraryPane';

export function initializeReactUI(win: Window) {
    // Set initial UI state
    const isLibraryTab = isLibraryTabSelected(win);
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