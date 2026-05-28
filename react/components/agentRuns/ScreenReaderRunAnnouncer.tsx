import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { activeRunAtom, threadRunsAtom } from '../../agents/atoms';
import { AgentRun } from '../../agents/types';
import { buildRunCompletionAnnouncement, extractAssistantResponseText } from '../../utils/screenReaderAnnouncements';
import { getPref } from '../../../src/utils/prefs';

interface ScreenReaderRunAnnouncerProps {
    inputRef?: React.RefObject<HTMLTextAreaElement | null>;
    surface: ScreenReaderSurface;
}

type ScreenReaderSurface = 'sidebar' | 'window';

type ReaderFocusTarget =
    | { kind: 'input' }
    | { kind: 'run-error-action'; runId: string };

function isTerminalRun(run: AgentRun): boolean {
    return run.status === 'completed' || run.status === 'error' || run.status === 'canceled';
}

const announcingSurfaceByRunId = new Map<string, ScreenReaderSurface>();
const announcedFinishedRunIds = new Set<string>();
const STATUS_ANNOUNCEMENT_CLEAR_MS = 5000;

/**
 * Return true when the announcer is mounted in a visible Beaver surface.
 */
function isElementExposed(element: HTMLElement | null): boolean {
    if (!element) {
        return false;
    }

    const win = element.ownerDocument.defaultView;
    if (!win) {
        return false;
    }

    let current: Element | null = element;
    while (current) {
        if (
            current.hasAttribute('hidden') ||
            current.getAttribute('aria-hidden') === 'true' ||
            current.hasAttribute('inert')
        ) {
            return false;
        }

        const style = win.getComputedStyle(current);
        if (
            !style ||
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse'
        ) {
            return false;
        }

        current = current.parentElement;
    }

    return true;
}

/**
 * Return true when this Beaver surface owns the current user interaction.
 */
function isActiveSurface(element: HTMLElement | null): boolean {
    const win = element?.ownerDocument.defaultView;
    return Boolean(win?.document?.hasFocus?.());
}

/**
 * Announces run state changes and optionally moves focus to a hidden response reader.
 */
export const ScreenReaderRunAnnouncer: React.FC<ScreenReaderRunAnnouncerProps> = ({ inputRef, surface }) => {
    const activeRun = useAtomValue(activeRunAtom);
    const threadRuns = useAtomValue(threadRunsAtom);
    const statusRef = useRef<HTMLDivElement | null>(null);
    const readerRef = useRef<HTMLDivElement | null>(null);
    const isInitialRenderRef = useRef(true);
    const previousActiveRunIdRef = useRef<string | null>(null);
    const nextAnnouncementIdRef = useRef(0);
    const clearStatusTimerRef = useRef<{ win: Window; id: number } | null>(null);
    const [statusAnnouncement, setStatusAnnouncement] = useState('');
    const [readerAnnouncement, setReaderAnnouncement] = useState<{ id: number; text: string; focusTarget: ReaderFocusTarget } | null>(null);

    const announceStatus = (message: string) => {
        nextAnnouncementIdRef.current += 1;
        const announcementId = nextAnnouncementIdRef.current;
        const win = statusRef.current?.ownerDocument.defaultView;
        if (clearStatusTimerRef.current) {
            clearStatusTimerRef.current.win.clearTimeout(clearStatusTimerRef.current.id);
            clearStatusTimerRef.current = null;
        }
        setStatusAnnouncement('');

        const updateAnnouncement = () => {
            if (announcementId !== nextAnnouncementIdRef.current) {
                return;
            }

            setStatusAnnouncement(message);
            win?.setTimeout(() => {
                if (announcementId === nextAnnouncementIdRef.current) {
                    statusRef.current?.focus({ preventScroll: true });
                }
            }, 0);

            if (win) {
                const id = win.setTimeout(() => {
                    if (announcementId === nextAnnouncementIdRef.current) {
                        setStatusAnnouncement('');
                    }
                    clearStatusTimerRef.current = null;
                }, STATUS_ANNOUNCEMENT_CLEAR_MS);
                clearStatusTimerRef.current = { win, id };
            }
        };

        if (win) {
            win.setTimeout(updateAnnouncement, 20);
        } else {
            updateAnnouncement();
        }
    };

    useEffect(() => {
        return () => {
            if (clearStatusTimerRef.current) {
                clearStatusTimerRef.current.win.clearTimeout(clearStatusTimerRef.current.id);
                clearStatusTimerRef.current = null;
            }
            if (statusRef.current) {
                statusRef.current.textContent = '';
            }
        };
    }, []);

    const focusReaderText = (message: string, focusTarget: ReaderFocusTarget = { kind: 'input' }) => {
        if (!isElementExposed(readerRef.current)) {
            return;
        }

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
        if (announcingSurfaceByRunId.has(run.id)) {
            return;
        }
        if (!isActiveSurface(statusRef.current)) {
            return;
        }

        announcingSurfaceByRunId.set(run.id, surface);
        announceStatus('Message sent. Beaver is generating a response.');
    };

    const focusResponseReader = (run: AgentRun) => {
        if (!getPref('focusResponseForScreenReaders')) {
            return;
        }
        if (announcingSurfaceByRunId.get(run.id) !== surface) {
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
        if (isInitialRenderRef.current) {
            isInitialRenderRef.current = false;
            previousActiveRunIdRef.current = activeRun?.id ?? null;
            return;
        }

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
                tabIndex={-1}
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
