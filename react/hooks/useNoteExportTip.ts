/**
 * Asks for the export tip once Beaver has created a note and the run is over:
 * the note's card, with its export button, is then the last thing in the chat.
 *
 * "Created" means just now, in this window: an applied note from a run that
 * was live here, or one the user applied here. A note that arrives with a
 * thread's history is old news. The moment passes when the chat changes, and
 * a note created while the chat is out of sight waits for it to show.
 * Whether now is a good moment is `showFeatureTipAtom`'s call.
 *
 * Mounted by every renderer that shows a chat — the main windows and the
 * separate window — since each watches the runs in its own store. In a main
 * window the chat is the sidebar; in the separate window it is the window
 * while it shows a chat rather than a table.
 */
import React, { useEffect, useRef, useState } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { activeRunAtom, currentThreadIdAtom, isStreamingAtom } from '@beaver/agent-core/run-state/atoms';
import { threadAgentActionsAtom } from '../agents/agentActions';
import { isBeaverWindowOpenAtom, isSidebarVisibleAtom } from '../atoms/ui';
import { showFeatureTipAtom } from '../atoms/featureTips';

/** Long enough for the finished run to settle on screen. */
const TIP_DELAY_MS = 1500;

/** The active run's id alone: the run itself changes with every streamed chunk. */
const activeRunIdAtom = atom((get) => get(activeRunAtom)?.id ?? null);

export function useNoteExportTip(): void {
    const activeRunId = useAtomValue(activeRunIdAtom);
    const isStreaming = useAtomValue(isStreamingAtom);
    const actions = useAtomValue(threadAgentActionsAtom);
    const threadId = useAtomValue(currentThreadIdAtom);
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const isBeaverWindowOpen = useAtomValue(isBeaverWindowOpenAtom);
    const isChatVisible = isSidebarVisible || isBeaverWindowOpen;
    const showFeatureTip = useSetAtom(showFeatureTipAtom);

    const liveRunIdsRef = useRef(new Set<string>());
    const appliedNoteIdsRef = useRef(new Set<string>());
    const unappliedNoteIdsRef = useRef(new Set<string>());
    const shownThisSessionRef = useRef(false);
    const [noteCreated, setNoteCreated] = useState(false);

    // Declared before the action effect so a run's id is recorded before the
    // notes it creates are looked at, when both arrive in one render.
    useEffect(() => {
        if (isStreaming && activeRunId) liveRunIdsRef.current.add(activeRunId);
    }, [isStreaming, activeRunId]);

    useEffect(() => {
        let created = false;
        for (const action of actions) {
            if (action.action_type !== 'create_note') continue;
            if (action.status !== 'applied') {
                // Undone or not yet applied: applying it here later is new.
                unappliedNoteIdsRef.current.add(action.id);
                appliedNoteIdsRef.current.delete(action.id);
                continue;
            }
            if (appliedNoteIdsRef.current.has(action.id)) continue;
            appliedNoteIdsRef.current.add(action.id);
            if (liveRunIdsRef.current.has(action.run_id) || unappliedNoteIdsRef.current.has(action.id)) {
                created = true;
            }
        }
        if (created) setNoteCreated(true);
    }, [actions]);

    useEffect(() => {
        setNoteCreated(false);
    }, [threadId]);

    useEffect(() => {
        if (!noteCreated || shownThisSessionRef.current) return;
        if (isStreaming || !isChatVisible) return;
        const timer = setTimeout(() => {
            setNoteCreated(false);
            if (showFeatureTip('note-export')) shownThisSessionRef.current = true;
        }, TIP_DELAY_MS);
        return () => clearTimeout(timer);
    }, [noteCreated, isStreaming, isChatVisible, showFeatureTip]);
}

/**
 * The trigger as a component that draws nothing, for a renderer whose own
 * root should not re-render whenever the thread's actions change.
 */
export const NoteExportTipTrigger: React.FC = () => {
    useNoteExportTip();
    return null;
};
