import React from 'react';
import { useAtomValue } from 'jotai';
import Sidebar from './Sidebar';
import WindowNav from './window/WindowNav';
import WindowHeader from './window/WindowHeader';
import { useBeaverWindowContext } from '../hooks/useBeaverWindowContext';
import { windowNavCollapsedAtom } from '../atoms/windowLayout';
import { chatAccessGateAtom } from '../atoms/chatAccess';
import { isFirstRunVisibleAtom } from '../atoms/firstRun';
import { whereToStartVisibleAtom } from '../atoms/whereToStart';
import { useReportBeaverUIVisibility } from '../hooks/useProfileSync';
import { NoteExportTipTrigger } from '../hooks/useNoteExportTip';

/**
 * WindowSidebar is rendered in the separate Beaver window.
 *
 * Unlike the library and reader sidebars it is a full application surface: a
 * collapsible chat history sidebar on the left, a header with the open chat's
 * title and actions, and the chat itself in a width-limited column. The chat
 * is the same `Sidebar` the panes render; only the chrome around it differs.
 */
const WindowSidebar = () => {
    // Marks Beaver as visible (so shared reader/library context tracking runs)
    // and stages the current Zotero selection on open.
    useBeaverWindowContext();
    // The standalone has no GlobalContextInitializer; report its visibility so the
    // account keeps the in-use profile refresh cadence while it is open.
    useReportBeaverUIVisibility();

    const collapsed = useAtomValue(windowNavCollapsedAtom);
    const chatAccessGate = useAtomValue(chatAccessGateAtom);
    const isFirstRunVisible = useAtomValue(isFirstRunVisibleAtom);
    const isWhereToStartVisible = useAtomValue(whereToStartVisibleAtom);

    // The history sidebar only exists once there is a chat to stand beside:
    // not on the sign-in, onboarding and first-run pages. A chat being opened
    // from the sidebar reports `loading`, so that gate keeps it — collapsing
    // and re-expanding on every click would be the alternative.
    const hasHistory = (chatAccessGate === null || chatAccessGate === 'loading')
        && !isFirstRunVisible && !isWhereToStartVisible;
    const navCollapsed = collapsed || !hasHistory;

    // The main windows' tip triggers live in GlobalContextInitializer; this
    // renderer's runs are its own, so it asks for the export tip itself.
    return (
        <>
            <NoteExportTipTrigger />
            <div className={`beaver-window-app ${navCollapsed ? 'beaver-window-app-nav-collapsed' : ''}`}>
                <aside className="beaver-window-nav" aria-label="Chat history sidebar">
                    {hasHistory && <WindowNav collapsed={navCollapsed} />}
                </aside>
                <div className="beaver-window-main">
                    <Sidebar
                        location="library"
                        isWindow={true}
                        header={<WindowHeader showChat={hasHistory} />}
                    />
                </div>
            </div>
        </>
    );
};

export default WindowSidebar;
