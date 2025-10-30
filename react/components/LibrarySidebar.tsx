import React, { useEffect } from 'react';
import { useAtomValue, useSetAtom } from "jotai";
import Sidebar from "./Sidebar";
import { isSidebarVisibleAtom, isLibraryTabAtom } from "../atoms/ui";
import { useObservePaneCollapse } from '../hooks/useObservePaneCollapse';
import { getPref } from '../../src/utils/prefs';
import { removePopupMessagesByTypeAtom } from '../atoms/ui';
import { currentMessageItemsAtom, updateMessageItemsFromZoteroSelectionAtom } from '../atoms/messageComposition';

// LibrarySidebarContent handles library-specific features
const LibrarySidebarContent = () => {

    // Watch for pane collapse
    useObservePaneCollapse("library");

    // Render the sidebar
    return <Sidebar location="library" />;
}

// LibrarySidebar handles visibility
const LibrarySidebar = () => {
    const isVisible = useAtomValue(isSidebarVisibleAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);

    // Return the sidebar if it is visible and the currently selected tab is a library tab
    return isVisible && isLibraryTab ? <LibrarySidebarContent /> : null;
}

export default LibrarySidebar; 