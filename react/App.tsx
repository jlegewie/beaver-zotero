import React, { useEffect } from 'react';
import { useAtom } from "jotai";
import AiSidebar from "./AiSidebar";
import { isAiSidebarVisibleAtom } from "./atoms/ui";

const App = () => {
    const [isVisible, setIsVisible] = useAtom(isAiSidebarVisibleAtom);

    // Subscribe to events from Zotero
    useEffect(() => {
        // Get the event bus from the window
        const eventBus = Zotero.getMainWindow().__beaverEventBus;
        if (!eventBus) return;

        const handleToggle = async (e: CustomEvent) => {
            const { visible } = e.detail;
            setIsVisible(visible);
        };

        eventBus.addEventListener('toggleChat', handleToggle);

        // Clean up the event listeners when the component unmounts.
        return () => {
            eventBus.removeEventListener('toggleChat', handleToggle);
        };
    }, [setIsVisible]);

    return (
        <>
            {isVisible && <AiSidebar />}
        </>
    );
}

export default App;
