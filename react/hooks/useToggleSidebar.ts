import { useSetAtom } from 'jotai';
import { store } from '../store';
import { isSidebarVisibleAtom } from '../atoms/ui';
import { useEventSubscription } from './useEventSubscription';
import { uiManager } from '../ui/UIManager';
import { getPref } from '../../src/utils/prefs';
import { removePopupMessagesByTypeAtom } from '../atoms/ui';
import { currentMessageItemsAtom, updateMessageItemsFromZoteroSelectionAtom } from '../atoms/messageComposition';
import { syncLibraryIdsAtom } from '../atoms/profile';

export function useToggleSidebar() {
    const setSidebarVisible = useSetAtom(isSidebarVisibleAtom);
    const removePopupMessagesByType = useSetAtom(removePopupMessagesByTypeAtom);
    const updateMessageItemsFromZoteroSelection = useSetAtom(updateMessageItemsFromZoteroSelectionAtom);
    const setCurrentMessageItems = useSetAtom(currentMessageItemsAtom);
    
    useEventSubscription('toggleChat', (detail) => {
        // Update atoms
        setSidebarVisible((prev) => {
            const currentlyOpen = prev;
            const newIsVisible = !currentlyOpen;
            const isLibraryTab = Zotero.getMainWindow().Zotero_Tabs.selectedType === 'library';

            // If just opened, initialize
            if (!currentlyOpen) {
                setCurrentMessageItems([]);
                removePopupMessagesByType(['items_summary']);
                const libraryIds = store.get(syncLibraryIdsAtom);   // Checking for empty array ensures that profile is loaded
                const addSelectedItemsOnOpen = getPref('addSelectedItemsOnOpen');
                if (addSelectedItemsOnOpen && isLibraryTab && libraryIds.length > 0) {
                    const maxAddAttachmentToMessage = getPref('maxAddAttachmentToMessage');
                    updateMessageItemsFromZoteroSelection(maxAddAttachmentToMessage);
                }
            }
            
            // Update UI through UIManager
            uiManager.updateUI({
                isVisible: newIsVisible,
                isLibraryTab,
                collapseState: {
                    library: null,
                    reader: null
                }
            });

            return newIsVisible;
        });
    });
} 