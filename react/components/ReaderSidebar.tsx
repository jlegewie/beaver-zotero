import React from 'react';
import { useAtom } from "jotai";
import AiSidebar from "../AiSidebar";
import { isReaderSidebarVisibleAtom } from "../atoms/ui";
import { useVisibility } from '../hooks/useVisibility';
import { useWatchItemPaneCollapse } from '../hooks/useWatchItemPaneCollapse';
import { useZoteroTabSelection } from '../hooks/useZoteroTabSelection';

// ReaderSidebarContent handles library-specific features
const ReaderSidebarContent = () => {
    // useWatchItemPaneCollapse("reader");
    useZoteroTabSelection();
    return <AiSidebar location="reader" />;
}

const ReaderSidebar = () => {
    const [isVisible] = useAtom(isReaderSidebarVisibleAtom);
    useVisibility('reader');
    return isVisible ? <ReaderSidebarContent /> : null;
}

export default ReaderSidebar; 