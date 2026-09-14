import React from 'react';
import { useAtomValue } from 'jotai';
import Sidebar from './Sidebar';
import TableWindowView from './tables/TableWindowView';
import WindowNav from './window/WindowNav';
import WindowHeader from './window/WindowHeader';
import { useBeaverWindowContext } from '../hooks/useBeaverWindowContext';
import { windowSurfaceAtom } from '../atoms/windowSurface';
import { windowNavCollapsedAtom } from '../atoms/windowLayout';
import { chatAccessGateAtom } from '../atoms/chatAccess';
import { isFirstRunVisibleAtom } from '../atoms/firstRun';
import { whereToStartVisibleAtom } from '../atoms/whereToStart';

/**
 * WindowSidebar is rendered in the separate Beaver window.
 *
 * Unlike the library and reader sidebars it is a full application surface: a
 * collapsible chat history sidebar on the left, a header with the open chat's
 * title and actions, and the chat itself in a width-limited column. The chat
 * is the same `Sidebar` the panes render; only the chrome around it differs.
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
    const collapsed = useAtomValue(windowNavCollapsedAtom);
    const chatAccessGate = useAtomValue(chatAccessGateAtom);
    const isFirstRunVisible = useAtomValue(isFirstRunVisibleAtom);
    const isWhereToStartVisible = useAtomValue(whereToStartVisibleAtom);

    if (surface.kind === 'table') {
        return <TableWindowView surface={surface} />;
    }

    // The history sidebar only exists once there is a chat to stand beside:
    // not on the sign-in, onboarding and first-run pages. A chat being opened
    // from the sidebar reports `loading`, so that gate keeps it — collapsing
    // and re-expanding on every click would be the alternative.
    const hasHistory = (chatAccessGate === null || chatAccessGate === 'loading')
        && !isFirstRunVisible && !isWhereToStartVisible;
    const navCollapsed = collapsed || !hasHistory;

    return (
        <div className={`beaver-window-app ${navCollapsed ? 'beaver-window-app-nav-collapsed' : ''}`}>
            <aside className="beaver-window-nav" aria-label="Chat history sidebar">
                {hasHistory && <WindowNav collapsed={navCollapsed} />}
            </aside>
            <div className="beaver-window-main">
                <Sidebar
                    location="library"
                    isWindow={true}
                    header={<WindowHeader showNavToggle={hasHistory} />}
                />
            </div>
        </div>
    );
};

export default WindowSidebar;
