import React from 'react';
import { useAtomValue, useSetAtom } from "jotai";
import Sidebar from "./Sidebar";
import { isSidebarVisibleAtom, isLibraryTabAtom } from "../atoms/ui";
import { useZoteroSelection } from '../hooks/useZoteroSelection';
import { useObservePaneCollapse } from '../hooks/useObservePaneCollapse';
import { resetCurrentSourcesAtom, updateSourcesFromZoteroSelectionAtom } from '../atoms/input';
import { getPref } from '../../src/utils/prefs';

// LibrarySidebarContent handles library-specific features
const LibrarySidebarContent = () => {

    useZoteroSelection();
    const resetCurrentSources = useSetAtom(resetCurrentSourcesAtom);
    const updateSourcesFromZoteroSelection = useSetAtom(updateSourcesFromZoteroSelectionAtom);
    resetCurrentSources();
    const addSelectedItemsOnOpen = getPref('addSelectedItemsOnOpen');
    if (addSelectedItemsOnOpen) {
        updateSourcesFromZoteroSelection(true);
    }

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