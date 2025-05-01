import React from 'react';
import { useAtomValue } from "jotai";
import Sidebar from "./Sidebar";
import { isSidebarVisibleAtom, isLibraryTabAtom } from "../atoms/ui";
import { useZoteroSelection } from '../hooks/useZoteroSelection';
import { useObservePaneCollapse } from '../hooks/useObservePaneCollapse';
import { useAttachmentStatusInfoRow } from '../hooks/useAttachmentStatusInfoRow';
import { useToggleSidebar } from '../hooks/useToggleSidebar';

// LibrarySidebarContent handles library-specific features
const LibrarySidebarContent = () => {
    // Zotero selection evnet handler
    useZoteroSelection();

    // Watch for pane collapse
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

    // Control visibility of the sidebar across app
    useToggleSidebar();

    // Handle attachment status info row
    useAttachmentStatusInfoRow();

    // Return the sidebar if it is visible and the currently selected tab is a library tab
    return isVisible && isLibraryTab ? <LibrarySidebarContent /> : null;
}

export default LibrarySidebar; 