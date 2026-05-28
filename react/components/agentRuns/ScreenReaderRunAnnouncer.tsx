import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { activeRunAtom, threadRunsAtom } from '../../agents/atoms';
import { AgentRun } from '../../agents/types';
import { buildRunCompletionAnnouncement, extractAssistantResponseText } from '../../utils/screenReaderAnnouncements';
import { getPref } from '../../../src/utils/prefs';

interface ScreenReaderRunAnnouncerProps {
    inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

function isTerminalRun(run: AgentRun): boolean {
    return run.status === 'completed' || run.status === 'error' || run.status === 'canceled';
}

const announcedStartedRunIds = new Set<string>();
const announcedFinishedRunIds = new Set<string>();

/**
 * Optionally moves focus to a screen-reader-only response reader when a run completes.
 */
export const ScreenReaderRunAnnouncer: React.FC<ScreenReaderRunAnnouncerProps> = ({ inputRef }) => {
    const activeRun = useAtomValue(activeRunAtom);
    const threadRuns = useAtomValue(threadRunsAtom);
    const readerRef = useRef<HTMLDivElement | null>(null);
    const previousActiveRunIdRef = useRef<string | null>(null);
    const nextAnnouncementIdRef = useRef(0);
    const [readerAnnouncement, setReaderAnnouncement] = useState<{ id: number; text: string } | null>(null);

    const focusReaderText = (message: string) => {
        nextAnnouncementIdRef.current += 1;
        setReaderAnnouncement({
            id: nextAnnouncementIdRef.current,
            text: message,
        });

        const win = readerRef.current?.ownerDocument.defaultView;
        win?.setTimeout(() => {
            readerRef.current?.focus({ preventScroll: true });
        }, 50);
    };

    const focusGeneratingMessage = (run: AgentRun) => {
        if (!getPref('focusResponseForScreenReaders')) {
            return;
        }
        if (announcedStartedRunIds.has(run.id)) {
            return;
        }

        announcedStartedRunIds.add(run.id);
        focusReaderText('Message sent. Beaver is generating a response.');
    };

    const focusResponseReader = (run: AgentRun) => {
        if (!getPref('focusResponseForScreenReaders')) {
            return;
        }
        if (announcedFinishedRunIds.has(run.id)) {
            return;
        }

        const responseText = run.status === 'completed' ? extractAssistantResponseText(run) : '';
        const message = responseText
            ? `Beaver response: ${responseText} End of response. Press Enter to message Beaver.`
            : buildRunCompletionAnnouncement(run);
        if (!message) {
            return;
        }

        announcedFinishedRunIds.add(run.id);
        focusReaderText(message);
    };

    useEffect(() => {
        if (!activeRun) {
            return;
        }

        previousActiveRunIdRef.current = activeRun.id;
        focusGeneratingMessage(activeRun);

        if (isTerminalRun(activeRun)) {
            focusResponseReader(activeRun);
        }
    }, [activeRun]);

    useEffect(() => {
        if (activeRun) {
            return;
        }

        const previousRunId = previousActiveRunIdRef.current;
        if (!previousRunId || announcedFinishedRunIds.has(previousRunId)) {
            previousActiveRunIdRef.current = null;
            return;
        }

        const completedRun = threadRuns.find((run) => run.id === previousRunId);
        if (completedRun && isTerminalRun(completedRun)) {
            focusResponseReader(completedRun);
            previousActiveRunIdRef.current = null;
        }
    }, [activeRun, threadRuns]);

    const handleReaderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== 'Escape' && event.key !== 'Tab') {
            return;
        }

        const input = inputRef?.current;
        if (!input) {
            return;
        }

        event.preventDefault();
        input.focus();
    };

    return (
        <div
            key={readerAnnouncement?.id ?? 0}
            ref={readerRef}
            className="sr-only"
            tabIndex={-1}
            onKeyDown={handleReaderKeyDown}
        >
            {readerAnnouncement?.text ?? ''}
        </div>
    );
};

export default ScreenReaderRunAnnouncer;
