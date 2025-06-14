import { useSetAtom } from 'jotai';
import { isSidebarVisibleAtom } from '../atoms/ui';
import { useEventSubscription } from './useEventSubscription';
import { uiManager } from '../ui/UIManager';

export function useToggleSidebar() {
    const setSidebarVisible = useSetAtom(isSidebarVisibleAtom);
    
    useEventSubscription('toggleChat', (detail) => {
        // Update atoms
        setSidebarVisible((prev) => {
            const newIsVisible = !prev;
            const isLibraryTab = Zotero.getMainWindow().Zotero_Tabs.selectedType === 'library';
            
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