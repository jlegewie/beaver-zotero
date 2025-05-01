import React from 'react';
import { useAtomValue, useSetAtom } from "jotai";
import Sidebar from "./Sidebar";
import { isSidebarVisibleAtom, isLibraryTabAtom } from "../atoms/ui";
import { useObservePaneCollapse } from '../hooks/useObservePaneCollapse';
import { useRecentThreads } from '../hooks/useRecentThreads';
import { updateSourcesFromReaderAtom } from "../atoms/input";
import { useReaderTabSelection } from '../hooks/useReaderTabSelection';

// ReaderSidebarContent handles library-specific features
const ReaderSidebarContent = () => {
    const updateSourcesFromReader = useSetAtom(updateSourcesFromReaderAtom);

    useReaderTabSelection();

    useObservePaneCollapse("reader");
    // Recent threads subscription
    // useRecentThreads();
    // Update sources from reader item
    updateSourcesFromReader();
    // Render the sidebar
    return <Sidebar location="reader" />;
}

const ReaderSidebar = () => {
    const isVisible = useAtomValue(isSidebarVisibleAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);

    return (isVisible && !isLibraryTab) ? <ReaderSidebarContent /> : null;
}

export default ReaderSidebar; 