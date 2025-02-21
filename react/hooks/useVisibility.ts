// @ts-ignore useEffect is defined in React
import { useEffect } from 'react';
import { useAtom } from 'jotai';
import { isLibrarySidebarVisibleAtom, isReaderSidebarVisibleAtom } from '../atoms/ui';
import { useEventSubscription } from './useEventSubscription';

export function useVisibility(location: 'library' | 'reader') {
    const [isLibraryVisible, setLibraryVisible] = useAtom(isLibrarySidebarVisibleAtom);
    const [isReaderVisible, setReaderVisible] = useAtom(isReaderSidebarVisibleAtom);
    
    useEventSubscription('toggleChat', (detail) => {
        const { location: eventLocation } = detail;
        if (location !== eventLocation) return;

        // Use the latest state values from the dependency array
        const isCurrentlyVisible = location === 'library' ? isLibraryVisible : isReaderVisible;
        const setVisible = location === 'library' ? setLibraryVisible : setReaderVisible;
        
        // Determine elements based on the location
        const win = Zotero.getMainWindow();
        const chatSelector = `#zotero-beaver-chat${location === 'reader' ? '-context' : ''}`;
        const pane = location === 'library'
            ? win.document.querySelector("#zotero-item-pane")
            : win.document.querySelector("#zotero-context-pane");
        const content = pane?.querySelectorAll(`:scope > *:not(${chatSelector})`);
        const chat = pane?.querySelector(chatSelector);
        
        if (!pane || !content || !chat) return;
        
        // Toggle the visibility state
        const newVisibility = !isCurrentlyVisible;
        
        if (newVisibility) {
            // Save the current collapsed state
            const wasCollapsed = pane.getAttribute("collapsed") === "true";
            // @ts-ignore: dataset is not typed
            pane.dataset.beaverWasCollapsed = wasCollapsed ? "true" : "false";
            
            // Expand the pane if needed
            if (wasCollapsed) {
                pane.removeAttribute("collapsed");
            }
            
            // Hide the content and show the chat area
            // @ts-ignore style is not typed
            content.forEach(el => el.style.display = 'none');
            // @ts-ignore style is not typed
            chat.style.removeProperty('display');

            // Update the toolbar button to reflect the change
            const chatToggleBtn = win.document.querySelector("#zotero-beaver-tb-chat-toggle");
            chatToggleBtn?.setAttribute("selected", "true");
        } else {
            // Hide the chat area and show the content
            // @ts-ignore style is not typed
            content.forEach(el => el.style.removeProperty('display'));
            // @ts-ignore style is not typed
            chat.style.display = 'none';
            
            // Restore the collapsed state if it was previously set
            // @ts-ignore: dataset is not typed
            const wasCollapsed = pane.dataset.beaverWasCollapsed === "true";
            if (wasCollapsed) {
                pane.setAttribute("collapsed", "true");
            }
            
            // Update the toolbar button to reflect the change
            const chatToggleBtn = win.document.querySelector("#zotero-beaver-tb-chat-toggle");
            chatToggleBtn?.removeAttribute("selected");
        }
        
        // Update the appropriate atom state
        setVisible(newVisibility);

    }, [location, isLibraryVisible, isReaderVisible]);
}
