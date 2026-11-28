import React from 'react';
import { useAtomValue } from "jotai";
import Sidebar from "./Sidebar";
import SidebarErrorBoundary from "./SidebarErrorBoundary";
import { isSidebarVisibleAtom, isLibraryTabAtom } from "../atoms/ui";
import { useObservePaneCollapse } from '../hooks/useObservePaneCollapse';

/**
 * The sidebar of a Zotero main window, on library and reader tabs alike.
 *
 * One tree serves both: switching tabs moves its element between the item pane
 * and the context pane (see `react/ui/UIManager.ts`) and re-renders nothing.
 *
 * Reader context tracking (attachment + text selection) is NOT mounted here:
 * it runs globally in GlobalContextInitializer so the separate Beaver window
 * gets the same context when the sidebar is closed.
 */
const MainSidebarContent = () => {
    const location = useAtomValue(isLibraryTabAtom) ? 'library' : 'reader';
    useObservePaneCollapse(location);
    return <Sidebar location={location} />;
};

const MainSidebar = () => {
    const isVisible = useAtomValue(isSidebarVisibleAtom);
    return isVisible ? (
        <SidebarErrorBoundary>
            <MainSidebarContent />
        </SidebarErrorBoundary>
    ) : null;
};

export default MainSidebar;
