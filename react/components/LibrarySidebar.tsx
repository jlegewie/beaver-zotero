import React from 'react';
import { useAtomValue } from "jotai";
import AiSidebar from "../AiSidebar";
import { isSidebarVisibleAtom } from "../atoms/ui";
import { useToggleSidebar } from '../hooks/useToggleSidebar';
import { useZoteroSelection } from '../hooks/useZoteroSelection';
import { useWatchItemPaneCollapse } from '../hooks/useWatchItemPaneCollapse';
import { useZoteroTabSelection } from '../hooks/useZoteroTabSelection';
import { isLibraryTabAtom } from "../atoms/ui";
import { useSidebarDOMEffects } from '../hooks/useSidebarDOMEffects';

// LibrarySidebarContent handles library-specific features
const LibrarySidebarContent = () => {
    useZoteroSelection();
    // useWatchItemPaneCollapse("library");
    return <AiSidebar location="library" />;
}

// LibrarySidebar handles visibility
const LibrarySidebar = () => {
    const isVisible = useAtomValue(isSidebarVisibleAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);

    // Control visibility of the sidebar across app
    useToggleSidebar();
    useZoteroTabSelection();

    // Return the sidebar if it is visible and the currently selected tab is a library tab
    return isVisible && isLibraryTab ? <LibrarySidebarContent /> : null;
}

export default LibrarySidebar; 