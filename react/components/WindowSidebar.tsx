import React from 'react';
import Sidebar from './Sidebar';

/**
 * WindowSidebar is rendered in the separate Beaver window.
 * Unlike LibrarySidebar/ReaderSidebar, it's always visible when the window is open.
 * The isWindow flag enables window-specific UI behavior (e.g., close button closes the window).
 */
const WindowSidebar = () => {
    return <Sidebar location="library" isWindow={true} />;
};

export default WindowSidebar;

