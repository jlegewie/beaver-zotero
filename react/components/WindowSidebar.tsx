import React from 'react';
import Sidebar from './Sidebar';

/**
 * WindowSidebar is rendered in the separate Beaver window.
 * Unlike LibrarySidebar/ReaderSidebar, it's always visible when the window is open.
 */
const WindowSidebar = () => {
    return <Sidebar location="library" />;
};

export default WindowSidebar;

