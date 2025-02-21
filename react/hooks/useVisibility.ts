// @ts-ignore useEffect is defined in React
import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { isLibrarySidebarVisibleAtom, isReaderSidebarVisibleAtom } from '../atoms/ui';

export function useVisibility(location: 'library' | 'reader') {
    const setLibraryVisible = useSetAtom(isLibrarySidebarVisibleAtom);
    const setReaderVisible = useSetAtom(isReaderSidebarVisibleAtom);

    useEffect(() => {
        const eventBus = Zotero.getMainWindow().__beaverEventBus;
        if (!eventBus) return;

        const handleToggle = async (e: CustomEvent) => {
            const { visible, location: eventLocation } = e.detail;
            if (location === eventLocation && location === 'library') {
                setLibraryVisible(visible);
            } else if (location === eventLocation && location === 'reader') {
                setReaderVisible(visible);
            }
        };

        eventBus.addEventListener('toggleChat', handleToggle);
        return () => {
            eventBus.removeEventListener('toggleChat', handleToggle);
        };
    }, [location, setLibraryVisible, setReaderVisible]);
} 