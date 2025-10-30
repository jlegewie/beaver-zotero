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

    // Update sources from Zotero selection when opening the library sidebar
    const setCurrentMessageItems = useSetAtom(currentMessageItemsAtom);
    const updateMessageItemsFromZoteroSelection = useSetAtom(updateMessageItemsFromZoteroSelectionAtom);
    const removePopupMessagesByType = useSetAtom(removePopupMessagesByTypeAtom);
    useEffect(() => {
        if (!isVisible || !isLibraryTab) return;
        removePopupMessagesByType(['items_summary']);
        setCurrentMessageItems([]);
        const addSelectedItemsOnOpen = getPref('addSelectedItemsOnOpen');
        if (addSelectedItemsOnOpen) {
            updateMessageItemsFromZoteroSelection(true);
        }
    }, [isVisible, isLibraryTab]);

    // Return the sidebar if it is visible and the currently selected tab is a library tab
    return isVisible && isLibraryTab ? <LibrarySidebarContent /> : null;
}

export default LibrarySidebar; 