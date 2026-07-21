import React, { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import Sidebar from './Sidebar';
import { isBeaverWindowOpenAtom } from '../atoms/ui';

/**
 * WindowSidebar is rendered in the separate Beaver window.
 * Unlike LibrarySidebar/ReaderSidebar, it's always visible when the window is open.
 * The isWindow flag enables window-specific UI behavior (e.g., close button closes the window).
 */
const WindowSidebar = () => {
    const setIsBeaverWindowOpen = useSetAtom(isBeaverWindowOpenAtom);

    // Publish the window's presence to the shared store so window-independent
    // hooks in the main window (e.g. reader tab/selection tracking) keep running
    // while Beaver is only visible here.
    useEffect(() => {
        setIsBeaverWindowOpen(true);
        return () => setIsBeaverWindowOpen(false);
    }, [setIsBeaverWindowOpen]);

    return <Sidebar location="library" isWindow={true} />;
};

export default WindowSidebar;

