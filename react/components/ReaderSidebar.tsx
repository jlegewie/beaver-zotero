import React from 'react';
import { useAtomValue } from "jotai";
import Sidebar from "./Sidebar";
import { isSidebarVisibleAtom, isLibraryTabAtom } from "../atoms/ui";
import { useObservePaneCollapse } from '../hooks/useObservePaneCollapse';
import { useRecentThreads } from '../hooks/useRecentThreads';

// ReaderSidebarContent handles library-specific features
// Reader context tracking (attachment + text selection) is NOT mounted here:
// it runs globally in GlobalContextInitializer so the separate Beaver window
// gets the same context when the sidebar is closed.
const ReaderSidebarContent = () => {

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