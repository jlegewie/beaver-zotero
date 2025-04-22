import React from 'react';
import { useEffect } from 'react';
import { useAtom, useAtomValue } from "jotai";
import Sidebar from "./Sidebar";
import { isSidebarVisibleAtom } from "../atoms/ui";
import { useToggleSidebar } from '../hooks/useToggleSidebar';
import { useZoteroSelection } from '../hooks/useZoteroSelection';
import { useObservePaneCollapse } from '../hooks/useObservePaneCollapse';
import { useZoteroTabSelection } from '../hooks/useZoteroTabSelection';
import { isLibraryTabAtom } from "../atoms/ui";
import { initializeSessionAtom } from '../atoms/auth';
import { useRecentThreads } from '../hooks/useRecentThreads';
import { useZoteroSync } from '../hooks/useZoteroSync';
import { useProfileSync } from '../hooks/useProfileSync';

// LibrarySidebarContent handles library-specific features
const LibrarySidebarContent = () => {
    useZoteroSelection();
    useObservePaneCollapse("library");
    // Recent threads subscription
    // useRecentThreads();
    // Render the sidebar
    return <Sidebar location="library" />;
}

// LibrarySidebar handles visibility
const LibrarySidebar = () => {
    const isVisible = useAtomValue(isSidebarVisibleAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const [, initializeSession] = useAtom(initializeSessionAtom);

    // Initialize session on app start
    useEffect(() => {
        initializeSession();
    }, [initializeSession]);

    // Control visibility of the sidebar across app
    useToggleSidebar();
    useZoteroTabSelection();

    // Profile sync
    useProfileSync();

    // Zotero sync
    useZoteroSync();

    // Return the sidebar if it is visible and the currently selected tab is a library tab
    return isVisible && isLibraryTab ? <LibrarySidebarContent /> : null;
}

export default LibrarySidebar; 