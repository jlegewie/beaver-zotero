import React from 'react';
import { useAtomValue } from "jotai";
import Sidebar from "./Sidebar";
import { isSidebarVisibleAtom, isLibraryTabAtom } from "../atoms/ui";
import { useObservePaneCollapse } from '../hooks/useObservePaneCollapse';
import { useRecentThreads } from '../hooks/useRecentThreads';
import { useReaderTabSelection } from '../hooks/useReaderTabSelection';

// ReaderSidebarContent handles library-specific features
const ReaderSidebarContent = () => {

    useReaderTabSelection();

    useObservePaneCollapse("reader");
    // Recent threads subscription
    // useRecentThreads();
    // Render the sidebar
    return <Sidebar location="reader" />;
}

const ReaderSidebar = () => {
    const isVisible = useAtomValue(isSidebarVisibleAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);

    return (isVisible && !isLibraryTab) ? <ReaderSidebarContent /> : null;
}

export default ReaderSidebar; 