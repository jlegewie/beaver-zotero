import React from 'react';
import Sidebar from './Sidebar';
import { useBeaverWindowContext } from '../hooks/useBeaverWindowContext';

/**
 * WindowSidebar is rendered in the separate Beaver window.
 * Unlike LibrarySidebar/ReaderSidebar, it's always visible when the window is open.
 * The isWindow flag enables window-specific UI behavior (e.g., close button closes the window).
 */
const WindowSidebar = () => {
    // Marks Beaver as visible (so shared reader/library context tracking runs)
    // and stages the current Zotero selection on open.
    useBeaverWindowContext();

    return <Sidebar location="library" isWindow={true} />;
};

export default WindowSidebar;

