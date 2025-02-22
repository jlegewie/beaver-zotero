// @ts-ignore useEffect is defined in React
import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { isSidebarVisibleAtom } from '../atoms/ui';
import { uiManager } from '../ui/UIManager';
import { SidebarLocation } from '../ui/types';

/**
* Watch the item pane for changes to the collapsed attribute and close the chat if the item pane is collapsed.
* 
* @param win - The window to watch.
*/
export function useObservePaneCollapse(location: SidebarLocation) {
    const setSidebarVisible = useSetAtom(isSidebarVisibleAtom);

    useEffect(() => {
        const win = Zotero.getMainWindow();
        const paneId = location === 'library' ? "zotero-item-pane" : "zotero-context-pane";
        const itemPane = win.document.getElementById(paneId);
        const sidebar = itemPane?.querySelector(`#beaver-pane-${location}`) as HTMLElement;
        
        if (!itemPane || !sidebar) return;
        
        const observer = new win.MutationObserver((mutations: MutationRecord[]) => {
            for (const m of mutations) {
                if (m.type === "attributes" && m.attributeName === "collapsed") {
                    const selectedType = win.Zotero_Tabs.selectedType;
                    const currentLocation = selectedType === 'library' ? 'library' : 'reader';
                    if(currentLocation !== location) return;
                    const isCollapsed = itemPane.getAttribute("collapsed") === "true";
                    if (isCollapsed && sidebar.style.display !== 'none') {
                        // Let UIManager handle the DOM changes
                        uiManager.handleCollapseCleanup(location);
                        uiManager.updateToolbarButton(false);
                        setSidebarVisible(false);
                    }
                }
            }
        });
        
        observer.observe(itemPane, { attributes: true });
        return () => observer.disconnect();
    }, [location, setSidebarVisible]);
} 