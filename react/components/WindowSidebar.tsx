import React from 'react';
import { useAtomValue } from 'jotai';
import Sidebar from './Sidebar';
import TableWindowView from './tables/TableWindowView';
import { useBeaverWindowContext } from '../hooks/useBeaverWindowContext';
import { windowSurfaceAtom } from '../atoms/windowSurface';

/**
 * WindowSidebar is rendered in the separate Beaver window.
 * Unlike LibrarySidebar/ReaderSidebar, it's always visible when the window is open.
 * The isWindow flag enables window-specific UI behavior (e.g., close button closes the window).
 *
 * The window also doubles as the working surface for a table, which needs the
 * width the sidebar mounts cannot give it. `windowSurfaceAtom` decides which of
 * the two is showing; the thread is what it shows by default and what it
 * returns to.
 */
const WindowSidebar = () => {
    // Marks Beaver as visible (so shared reader/library context tracking runs)
    // and stages the current Zotero selection on open. Runs for either surface:
    // the window's context tracking is about the window, not its contents.
    useBeaverWindowContext();

    const surface = useAtomValue(windowSurfaceAtom);

    if (surface.kind === 'table') {
        return <TableWindowView surface={surface} />;
    }

    return <Sidebar location="library" isWindow={true} />;
};

export default WindowSidebar;
