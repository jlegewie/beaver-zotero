import React from 'react';
import { useAtomValue } from "jotai";
import Sidebar from "./Sidebar";
import { isSidebarVisibleAtom } from "../atoms/ui";
import { isLibraryTabAtom } from "../atoms/ui";
import { useObservePaneCollapse } from '../hooks/useObservePaneCollapse';

// ReaderSidebarContent handles library-specific features
const ReaderSidebarContent = () => {
    useObservePaneCollapse("reader");
    return <Sidebar location="reader" />;
}

const ReaderSidebar = () => {
    const isVisible = useAtomValue(isSidebarVisibleAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);

    return (isVisible && !isLibraryTab) ? <ReaderSidebarContent /> : null;
}

export default ReaderSidebar; 