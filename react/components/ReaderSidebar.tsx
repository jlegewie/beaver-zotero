import React from 'react';
import { useAtomValue } from "jotai";
import AiSidebar from "../AiSidebar";
import { isSidebarVisibleAtom } from "../atoms/ui";
import { isLibraryTabAtom } from "../atoms/ui";
import { useWatchItemPaneCollapse } from '../hooks/useWatchItemPaneCollapse';

// ReaderSidebarContent handles library-specific features
const ReaderSidebarContent = () => {
    // useWatchItemPaneCollapse("reader");
    return <AiSidebar location="reader" />;
}

const ReaderSidebar = () => {
    const isVisible = useAtomValue(isSidebarVisibleAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);

    return (isVisible && !isLibraryTab) ? <ReaderSidebarContent /> : null;
}

export default ReaderSidebar; 