import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { isSidebarVisibleAtom, isLibraryTabAtom } from '../atoms/ui';

export function useSidebarDOMEffects() {
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    
    // Store collapse states in refs to persist between renders
    const libraryWasCollapsed = useRef<boolean | null>(null);
    const readerWasCollapsed = useRef<boolean | null>(null);

    useEffect(() => {
        const win = Zotero.getMainWindow() as unknown as CustomZoteroWindow;
        
        // Get chat toggle button
        const chatToggleBtn = win.document.querySelector("#zotero-beaver-tb-chat-toggle");
        // Get library pane
        const libraryPane = win.document.querySelector("#zotero-item-pane");
        const libraryContent = libraryPane?.querySelectorAll(":scope > *:not(#beaver-pane-library)");
        const librarySidebar = libraryPane?.querySelector("#beaver-pane-library");        
        // Get reader pane
        const readerPane = win.document.querySelector("#zotero-context-pane");
        const readerContent = readerPane?.querySelectorAll(":scope > *:not(#beaver-pane-reader)");
        const readerSidebar = readerPane?.querySelector("#beaver-pane-reader");

        // Handle library pane
        if (libraryPane && libraryContent && librarySidebar) {
            const itemPane = win.ZoteroPane.itemPane;
            if (isSidebarVisible && isLibraryTab) {
                // Manage collapsed state
                const isCollapsed = itemPane && itemPane.collapsed;
                libraryWasCollapsed.current = isCollapsed;
                if (isCollapsed && itemPane) {
                    // @ts-ignore: collapsed is not typed
                    itemPane.collapsed = false;
                }
                
                // @ts-ignore style is not typed
                libraryContent.forEach(el => el.style.display = 'none');
                // @ts-ignore style is not typed
                librarySidebar.style.removeProperty('display');
            } else {
                // @ts-ignore style is not typed
                libraryContent.forEach(el => el.style.removeProperty('display'));
                // @ts-ignore style is not typed
                librarySidebar.style.display = 'none';
                
                // @ts-ignore: collapsed is not typed
                if (libraryWasCollapsed.current && itemPane) {
                    // @ts-ignore: collapsed is not typed
                    itemPane.collapsed = true;
                }
            }
        }

        // Handle reader pane
        if (readerPane && readerContent && readerSidebar) {
            const contextPane = win.ZoteroContextPane;
            if (isSidebarVisible && !isLibraryTab) {
                // Manage collapsed state
                // @ts-ignore: collapsed is not typed
                const isCollapsed = contextPane.collapsed;
                readerWasCollapsed.current = isCollapsed;
                if (isCollapsed) {
                    // @ts-ignore: collapsed is not typed
                    contextPane.togglePane();
                }
                
                // @ts-ignore style is not typed
                readerContent.forEach(el => el.style.display = 'none');
                // @ts-ignore style is not typed
                readerSidebar.style.removeProperty('display');
            } else {
                // @ts-ignore style is not typed
                readerContent.forEach(el => el.style.removeProperty('display'));
                // @ts-ignore style is not typed
                readerSidebar.style.display = 'none';
                
                // @ts-ignore: collapsed is not typed
                const isCollapsed = contextPane.collapsed;
                if (readerWasCollapsed.current && !isCollapsed) {
                    contextPane.togglePane();
                }
            }
        }

        // Update toolbar button
        if (isSidebarVisible) {
            chatToggleBtn?.setAttribute("selected", "true");
        } else {
            chatToggleBtn?.removeAttribute("selected");
        }

        // Cleanup function
        return () => {
            // Restore library pane
            if (libraryPane && libraryContent && librarySidebar) {
                // @ts-ignore style is not typed
                libraryContent.forEach(el => el.style.removeProperty('display'));
                // @ts-ignore style is not typed
                librarySidebar.style.display = 'none';
                
                // if (libraryWasCollapsed.current && win.ZoteroPane.itemPane) {
                //     win.ZoteroPane.itemPane.collapsed = true;
                // }
            }

            // Restore reader pane
            if (readerPane && readerContent && readerSidebar) {
                // @ts-ignore style is not typed
                readerContent.forEach(el => el.style.removeProperty('display'));
                // @ts-ignore style is not typed
                readerSidebar.style.display = 'none';
                
                // const isCollapsed = win.ZoteroContextPane.collapsed;
                // if (readerWasCollapsed.current && !isCollapsed) {
                //     win.ZoteroContextPane.togglePane();
                // }
            }

            // Reset toolbar button
            chatToggleBtn?.removeAttribute("selected");
        };
    }, [isSidebarVisible, isLibraryTab]);
}