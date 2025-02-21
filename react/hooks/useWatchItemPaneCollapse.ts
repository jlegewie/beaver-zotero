// @ts-ignore useEffect is defined in React
import { useEffect } from 'react';
import { triggerToggleChat } from '../../src/ui/toggleChat';

/**
* Watch the item pane for changes to the collapsed attribute and close the chat if the item pane is collapsed.
* 
* @param win - The window to watch.
*/
export function useWatchItemPaneCollapse(location: 'library' | 'reader') {
    useEffect(() => {
        const win = Zotero.getMainWindow();
        const paneId = location === 'library' ? "zotero-item-pane" : "zotero-context-pane";
        const itemPane = win.document.getElementById(paneId);
        const chat = itemPane?.querySelector(`#beaver-pane-${location}`);
        if (!itemPane || !chat) return;
        
        const observer = new win.MutationObserver((mutations: MutationRecord[]) => {
            for (const m of mutations) {
                if (m.type === "attributes" && m.attributeName === "collapsed") {
                    const isCollapsed = itemPane.getAttribute("collapsed") === "true";
                    if (isCollapsed) {
                        // Close chat sidebar when item pane is collapsed
                        triggerToggleChat(win);
                    }
                }
            }
        });
        
        observer.observe(itemPane, { attributes: true });
        
        return () => observer.disconnect();
    }, []);
} 