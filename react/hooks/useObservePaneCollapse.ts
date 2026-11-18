import { getContextWindow } from '../runtime/windowRuntime';
import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { isSidebarVisibleAtom, selectedZoteroTabIdAtom } from '../atoms/ui';
import { activeItemPane, isLibraryTabSelected } from '../../src/ui/libraryPane';
import { uiManager } from '../ui/UIManager';
import { SidebarLocation } from '../ui/types';
import { dismissDiffPreview } from '../utils/noteEditorDiffPreview';

/**
 * Close the sidebar when the user collapses the Zotero pane it is shown in:
 * the item pane on a library tab, the context pane on any other.
 */
export function useObservePaneCollapse(location: SidebarLocation) {
    const setSidebarVisible = useSetAtom(isSidebarVisibleAtom);
    // Zotero 11 gives each library tab its own item pane, and the sidebar
    // moves to the selected one: observe the pane it is in now.
    const selectedTabId = useAtomValue(selectedZoteroTabIdAtom);
    const paneKey = location === 'library' ? selectedTabId : null;

    useEffect(() => {
        const win = getContextWindow();
        const itemPane = location === 'library'
            ? activeItemPane(win)
            : win.document.getElementById("zotero-context-pane");
        if (!itemPane) return;
        
        const observer = new win.MutationObserver(() => {
            const currentLocation = isLibraryTabSelected(win) ? 'library' : 'reader';
            if (currentLocation !== location) return;
            // Read Zotero's own `collapsed` getter rather than the raw
            // attribute. Zotero 10 writes `collapsed="true"`/`"false"`,
            // Zotero 11 (Firefox 153) made it a boolean XUL attribute
            // written with toggleAttribute(), so it is `collapsed=""`
            // there and any `=== "true"` comparison is dead.
            // @ts-ignore: `collapsed` is not typed on the Zotero panes
            const isCollapsed = Boolean(itemPane.collapsed);
            // The pane the sidebar is in now: leaving another library view's
            // pane collapses that pane again if the sidebar had opened it.
            if (isCollapsed && uiManager.isShownIn(itemPane)) {
                // Dismiss any active diff preview in the note editor
                dismissDiffPreview();
                // Give the pane back and update the toolbar button
                uiManager.updateUI({ isVisible: false, isLibraryTab: location === 'library' });
                uiManager.announceSidebarState(false);
                // Close the sidebar
                setSidebarVisible(false);
            }
        });

        // Only `collapsed`: the sidebar writes the pane's width on every resize.
        observer.observe(itemPane, { attributes: true, attributeFilter: ['collapsed'] });
        return () => observer.disconnect();
    }, [location, setSidebarVisible, paneKey]);
} 