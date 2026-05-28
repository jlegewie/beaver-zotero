import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { activeRunAtom, threadRunsAtom } from '../../agents/atoms';
import { AgentRun } from '../../agents/types';
import { buildRunCompletionAnnouncement, extractAssistantResponseText } from '../../utils/screenReaderAnnouncements';
import { getPref } from '../../../src/utils/prefs';

interface ScreenReaderRunAnnouncerProps {
    inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

type ReaderFocusTarget =
    | { kind: 'input' }
    | { kind: 'run-error-action'; runId: string };

function isTerminalRun(run: AgentRun): boolean {
    return run.status === 'completed' || run.status === 'error' || run.status === 'canceled';
}

const announcedStartedRunIds = new Set<string>();
const announcedFinishedRunIds = new Set<string>();

/**
 * Announces run state changes and optionally moves focus to a hidden response reader.
 */
export const ScreenReaderRunAnnouncer: React.FC<ScreenReaderRunAnnouncerProps> = ({ inputRef }) => {
    const activeRun = useAtomValue(activeRunAtom);
    const threadRuns = useAtomValue(threadRunsAtom);
    const statusRef = useRef<HTMLDivElement | null>(null);
    const readerRef = useRef<HTMLDivElement | null>(null);
    const previousActiveRunIdRef = useRef<string | null>(null);
    const nextAnnouncementIdRef = useRef(0);
    const [statusAnnouncement, setStatusAnnouncement] = useState('');
    const [readerAnnouncement, setReaderAnnouncement] = useState<{ id: number; text: string; focusTarget: ReaderFocusTarget } | null>(null);

    const announceStatus = (message: string) => {
        nextAnnouncementIdRef.current += 1;
        const announcementId = nextAnnouncementIdRef.current;
        const win = statusRef.current?.ownerDocument.defaultView;
        setStatusAnnouncement('');

        const updateAnnouncement = () => {
            if (announcementId !== nextAnnouncementIdRef.current) {
                return;
            }

            setStatusAnnouncement(message);
        };

        if (win) {
            win.setTimeout(updateAnnouncement, 20);
        } else {
            updateAnnouncement();
        }
    };

    const focusReaderText = (message: string, focusTarget: ReaderFocusTarget = { kind: 'input' }) => {
        nextAnnouncementIdRef.current += 1;
        setReaderAnnouncement({
            id: nextAnnouncementIdRef.current,
            text: message,
            focusTarget,
        });

        const win = readerRef.current?.ownerDocument.defaultView;
        win?.setTimeout(() => {
            readerRef.current?.focus({ preventScroll: true });
        }, 50);
    };

    const announceGeneratingMessage = (run: AgentRun) => {
        if (!getPref('focusResponseForScreenReaders')) {
            return;
        }
        if (announcedStartedRunIds.has(run.id)) {
            return;
        }

        announcedStartedRunIds.add(run.id);
        announceStatus('Message sent. Beaver is generating a response.');
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
        focusReaderText(
            message,
            run.status === 'error' ? { kind: 'run-error-action', runId: run.id } : { kind: 'input' },
        );
    };

    useEffect(() => {
        if (!activeRun) {
            return;
        }

        previousActiveRunIdRef.current = activeRun.id;
        announceGeneratingMessage(activeRun);

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

    const focusInput = (): boolean => {
        const input = inputRef?.current;
        if (!input) {
            return false;
        }

        input.focus();
        return true;
    };

    const focusRunErrorAction = (runId: string): boolean => {
        const doc = readerRef.current?.ownerDocument;
        const panel = doc?.getElementById(`run-error-${runId}`);
        const action = panel?.querySelector<HTMLButtonElement>(
            '[data-run-error-primary-action="true"]:not([disabled]), [data-run-error-action]:not([disabled])',
        );

        if (!action) {
            return false;
        }

        action.focus({ preventScroll: true });
        return true;
    };

    const handleReaderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== 'Escape' && event.key !== 'Tab') {
            return;
        }

        const focusTarget = readerAnnouncement?.focusTarget;
        if (
            focusTarget?.kind === 'run-error-action' &&
            (event.key === 'Enter' || event.key === 'Tab') &&
            focusRunErrorAction(focusTarget.runId)
        ) {
            event.preventDefault();
            return;
        }

        if (focusInput()) {
            event.preventDefault();
        }
    };

    return (
        <>
            <div
                ref={statusRef}
                className="sr-only"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {statusAnnouncement}
            </div>
            <div
                key={readerAnnouncement?.id ?? 0}
                ref={readerRef}
                className="sr-only"
                tabIndex={-1}
                onKeyDown={handleReaderKeyDown}
            >
                {readerAnnouncement?.text ?? ''}
            </div>
        </>
    );
};

export default ScreenReaderRunAnnouncer;
