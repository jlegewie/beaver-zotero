import React, { useEffect } from 'react';
import { useAtom } from "jotai";
import AiSidebar from "./AiSidebar";
import { isReaderSidebarVisibleAtom, isLibrarySidebarVisibleAtom } from "./atoms/ui";

const App = ({ location }: { location: 'library' | 'reader' }) => {
    const [isVisible, setIsVisible] = useAtom(
        location === 'library' 
            ? isLibrarySidebarVisibleAtom 
            : isReaderSidebarVisibleAtom
    );

    // Subscribe to events from Zotero
    useEffect(() => {
        // Get the event bus from the window
        const eventBus = Zotero.getMainWindow().__beaverEventBus;
        if (!eventBus) return;

        const handleToggle = async (e: CustomEvent) => {
            const { visible, location: eventLocation } = e.detail;
            if (eventLocation === location || !eventLocation) {
                setIsVisible(visible);
            }
        };

        eventBus.addEventListener('toggleChat', handleToggle);

        // Clean up the event listeners when the component unmounts.
        return () => {
            eventBus.removeEventListener('toggleChat', handleToggle);
        };
    }, [setIsVisible]);

    return (
        <>
            {isVisible && <AiSidebar location={location} />}
        </>
    );
}

export default App;
