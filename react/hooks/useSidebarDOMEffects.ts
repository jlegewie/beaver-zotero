// @ts-ignore useEffect is defined in React
import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { isSidebarVisibleAtom, isLibraryTabAtom } from '../atoms/ui';

export function useSidebarDOMEffects() {
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    
    useEffect(() => {
        const win = Zotero.getMainWindow();

        console.log("useSidebarDOMEffects", isSidebarVisible, isLibraryTab);
        
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
        const readerSplitter = win.document.querySelector("#zotero-context-splitter");

        // Handle library pane
        if (libraryPane && libraryContent && librarySidebar) {
            if (isSidebarVisible && isLibraryTab) {
                const wasCollapsed = libraryPane.getAttribute("collapsed") === "true";
                // @ts-ignore: dataset is not typed
                libraryPane.dataset.beaverWasCollapsed = wasCollapsed ? "true" : "false";
                if (wasCollapsed) libraryPane.removeAttribute("collapsed");
                
                // @ts-ignore style is not typed
                libraryContent.forEach(el => el.style.display = 'none');
                // @ts-ignore style is not typed
                librarySidebar.style.removeProperty('display');
            } else {
                // @ts-ignore style is not typed
                libraryContent.forEach(el => el.style.removeProperty('display'));
                // @ts-ignore style is not typed
                librarySidebar.style.display = 'none';
                
                // @ts-ignore: dataset is not typed
                const wasCollapsed = libraryPane.dataset.beaverWasCollapsed === "true";
                if (wasCollapsed) libraryPane.setAttribute("collapsed", "true");
            }
        }

        // Handle reader pane
        if (readerPane && readerContent && readerSidebar) {
            if (isSidebarVisible && !isLibraryTab) {
                const wasCollapsed = readerPane.getAttribute("collapsed") === "true";
                // @ts-ignore: dataset is not typed
                readerPane.dataset.beaverWasCollapsed = wasCollapsed ? "true" : "false";
                if (wasCollapsed) readerPane.removeAttribute("collapsed");
                
                // @ts-ignore style is not typed
                readerContent.forEach(el => el.style.display = 'none');
                // @ts-ignore style is not typed
                readerSidebar.style.removeProperty('display');
            } else {
                // @ts-ignore style is not typed
                readerContent.forEach(el => el.style.removeProperty('display'));
                // @ts-ignore style is not typed
                readerSidebar.style.display = 'none';
                
                // @ts-ignore: dataset is not typed
                const wasCollapsed = readerPane.dataset.beaverWasCollapsed === "true";
                if (wasCollapsed) readerPane.setAttribute("collapsed", "true");
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
                
                // @ts-ignore: dataset is not typed
                const wasCollapsed = libraryPane.dataset.beaverWasCollapsed === "true";
                if (wasCollapsed) libraryPane.setAttribute("collapsed", "true");
            }

            // Restore reader pane
            if (readerPane && readerContent && readerSidebar) {
                // @ts-ignore style is not typed
                readerContent.forEach(el => el.style.removeProperty('display'));
                // @ts-ignore style is not typed
                readerSidebar.style.display = 'none';
                
                // @ts-ignore: dataset is not typed
                const wasCollapsed = readerPane.dataset.beaverWasCollapsed === "true";
                if (wasCollapsed) readerPane.setAttribute("collapsed", "true");
            }

            // Reset toolbar button
            chatToggleBtn?.removeAttribute("selected");
        };
    }, [isSidebarVisible, isLibraryTab]);
} 