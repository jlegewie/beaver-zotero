import { useSetAtom, useAtomValue } from 'jotai';
import { loadThreadAtom } from '../atoms/threads';
import { userAtom } from '../atoms/auth';
import { useEventSubscription } from './useEventSubscription';
import { logger } from '../../src/utils/logger';
import { isSidebarVisibleAtom } from '../atoms/ui';
import { uiManager } from '../ui/UIManager';

export function useProtocolHandler() {
    const loadThread = useSetAtom(loadThreadAtom);
    const setSidebarVisible = useSetAtom(isSidebarVisibleAtom);
    const user = useAtomValue(userAtom);

    useEventSubscription('openThread', ({ threadId }) => {
        logger(`useProtocolHandler: Received openThread event for ${threadId}`, 2);
        if (user && threadId) {
            // Ensure sidebar is visible
            setSidebarVisible(true);
            
            // Update UI through UIManager to ensure pane is shown
            const isLibraryTab = Zotero.getMainWindow().Zotero_Tabs.selectedType === 'library';
            uiManager.updateUI({
                isVisible: true,
                isLibraryTab,
                collapseState: {
                    library: null,
                    reader: null
                }
            });

            // Load the thread
            loadThread({ user_id: user.id, threadId });
            
            // Focus the window if needed (though protocol handler usually brings app to front)
             const win = Zotero.getMainWindow();
             if (win) {
                 win.focus();
             }

        } else {
             logger(`useProtocolHandler: Cannot open thread. User logged in: ${!!user}, Thread ID: ${threadId}`, 1);
        }
    }, [user, loadThread, setSidebarVisible]);
}

