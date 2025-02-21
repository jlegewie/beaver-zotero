import React, { useEffect } from 'react';
import { useAtom } from "jotai";
import AiSidebar from "../AiSidebar";
import { isReaderSidebarVisibleAtom } from "../atoms/ui";

const ReaderSidebar = () => {
    const [isVisible, setIsVisible] = useAtom(isReaderSidebarVisibleAtom);

    // Keep existing event listener for now - will be refactored in later phase
    useEffect(() => {
        const eventBus = Zotero.getMainWindow().__beaverEventBus;
        if (!eventBus) return;

        const handleToggle = async (e: CustomEvent) => {
            const { visible, location } = e.detail;
            if (location === 'reader' || !location) {
                setIsVisible(visible);
            }
        };

        eventBus.addEventListener('toggleChat', handleToggle);
        return () => {
            eventBus.removeEventListener('toggleChat', handleToggle);
        };
    }, [setIsVisible]);

    return isVisible ? <AiSidebar location="reader" /> : null;
}

export default ReaderSidebar; 