import { getContextWindow } from '../runtime/windowRuntime';
import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { isSidebarVisibleAtom, selectedZoteroTabIdAtom } from '../atoms/ui';
import { activeItemPane, isLibraryTabSelected } from '../../src/ui/libraryPane';
import { uiManager } from '../ui/UIManager';
import { SidebarLocation } from '../ui/types';
import { dismissDiffPreview } from '../utils/noteEditorDiffPreview';

/**
* Watch the item pane for changes to the collapsed attribute and close the chat if the item pane is collapsed.
* 
* @param win - The window to watch.
*/
export function useObservePaneCollapse(location: SidebarLocation) {
    const setSidebarVisible = useSetAtom(isSidebarVisibleAtom);
    // Zotero 11 gives each library tab its own item pane, and the library
    // sidebar moves to the selected one: observe the pane it is in now.
    const selectedTabId = useAtomValue(selectedZoteroTabIdAtom);
    const paneKey = location === 'library' ? selectedTabId : null;

    useEffect(() => {
        const win = getContextWindow();
        const itemPane = location === 'library'
            ? activeItemPane(win)
            : win.document.getElementById("zotero-context-pane");
        const sidebar = itemPane?.querySelector(`#beaver-pane-${location}`) as HTMLElement;
        
        if (!itemPane || !sidebar) return;
        
        const observer = new win.MutationObserver((mutations: MutationRecord[]) => {
            for (const m of mutations) {
                if (m.type === "attributes" && m.attributeName === "collapsed") {
                    const currentLocation = isLibraryTabSelected(win) ? 'library' : 'reader';
                    if(currentLocation !== location) return;
                    // Read Zotero's own `collapsed` getter rather than the raw
                    // attribute. Zotero 10 writes `collapsed="true"`/`"false"`,
                    // Zotero 11 (Firefox 153) made it a boolean XUL attribute
                    // written with toggleAttribute(), so it is `collapsed=""`
                    // there and any `=== "true"` comparison is dead.
                    // @ts-ignore: `collapsed` is not typed on the Zotero panes
                    const isCollapsed = Boolean(itemPane.collapsed);
                    if (isCollapsed && sidebar.style.display !== 'none') {
                        // Dismiss any active diff preview in the note editor
                        dismissDiffPreview();
                        // Cleanup the pane and update the toolbar button
                        uiManager.handleCleanup(location);
                        uiManager.updateToolbarButton(false);
                        uiManager.announceSidebarState(false);
                        // Close the sidebar
                        setSidebarVisible(false);
                    }
                }
            }
        });
        
        observer.observe(itemPane, { attributes: true });
        return () => observer.disconnect();
    }, [location, setSidebarVisible, paneKey]);
} 