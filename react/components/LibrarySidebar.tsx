import React from 'react';
import { useAtom } from "jotai";
import AiSidebar from "../AiSidebar";
import { isLibrarySidebarVisibleAtom } from "../atoms/ui";
import { useVisibility } from '../hooks/useVisibility';
import { useZoteroSelection } from '../hooks/useZoteroSelection';
import { useWatchItemPaneCollapse } from '../hooks/useWatchItemPaneCollapse';

// LibrarySidebarContent handles library-specific features
const LibrarySidebarContent = () => {
    useZoteroSelection();
    useWatchItemPaneCollapse();
    return <AiSidebar location="library" />;
}

// LibrarySidebar handles visibility
const LibrarySidebar = () => {
    const [isVisible] = useAtom(isLibrarySidebarVisibleAtom);
    useVisibility('library');
    return isVisible ? <LibrarySidebarContent /> : null;
}

export default LibrarySidebar; 