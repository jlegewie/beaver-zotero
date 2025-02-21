import React, { useEffect } from 'react';
import { useAtom } from "jotai";
import AiSidebar from "../AiSidebar";
import { isLibrarySidebarVisibleAtom } from "../atoms/ui";

const LibrarySidebar = () => {
    const [isVisible, setIsVisible] = useAtom(isLibrarySidebarVisibleAtom);

    // Keep existing event listener for now - will be refactored in later phase
    useEffect(() => {
        const eventBus = Zotero.getMainWindow().__beaverEventBus;
        if (!eventBus) return;

        const handleToggle = async (e: CustomEvent) => {
            const { visible, location } = e.detail;
            if (location === 'library' || !location) {
                setIsVisible(visible);
            }
        };

        eventBus.addEventListener('toggleChat', handleToggle);
        return () => {
            eventBus.removeEventListener('toggleChat', handleToggle);
        };
    }, [setIsVisible]);

    return isVisible ? <AiSidebar location="library" /> : null;
}

export default LibrarySidebar; 