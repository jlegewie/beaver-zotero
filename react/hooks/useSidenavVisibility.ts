// @ts-ignore useEffect is defined in React
import { useEffect } from 'react';

/**
* Watch the item pane for changes to the sidenav and hide it when Zotero unhides it.
*/
export function useSidenavVisibility() {
    
    useEffect(() => {
        const win = Zotero.getMainWindow();
        const itemPane = win.document.querySelector("item-pane#zotero-item-pane");
        if (!itemPane) return;
        
        const sidenav = itemPane.querySelector("#zotero-view-item-sidenav");
        if (!sidenav) return;
        // @ts-ignore zotero item-pane is not typed
        sidenav.hidden = true;
        
        // Observe status changes of the sidenav and hide it when Zotero unhides it
        const observer = new win.MutationObserver((mutations: MutationRecord[]) => {
            for (const m of mutations) {
                if (m.type === "attributes" && m.attributeName === "hidden") {
                    // @ts-ignore zotero item-pane is not typed
                    if (sidenav.hidden === false) {
                        // @ts-ignore zotero item-pane is not typed
                        sidenav.hidden = true;
                    }
                }
            }
        });
        
        observer.observe(sidenav, { attributes: true });
        
        return () => {
            observer.disconnect();
            // Ensure sidenav is visible when the component unmounts
            // @ts-ignore zotero item-pane is not typed
            sidenav.hidden = false;
        };
    }, []);
} 