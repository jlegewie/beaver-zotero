import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Icon, Spinner, RepeatIcon } from '../icons/icons';
import { AgentRunStatus } from '@beaver/agent-core/agents/types';
import { wsReconnectingAtom, wsRetryAtom } from '@beaver/agent-core/run-state/atoms';
import { runStatusText } from '@beaver/agent-core/run-state/runStatusCopy';

/**
 * How long a wait runs before the indicator starts counting it out loud.
 *
 * Short gaps are the common case and need no number — a spinner is enough, and
 * digits ticking under every response would be noise. The counter is for the
 * wait that has gone on long enough that a still spinner starts to look stuck.
 */
const COUNT_AFTER_MS = 8000;

interface RunStatusIndicatorProps {
    status: AgentRunStatus;
    /** The run ID to match retry state against */
    runId?: string;
    /** Whether the previous message has a tool call */
    lastMessageHasToolCall?: boolean;
    /**
     * Whether the wait sits under a text part. Text has no trailing margin, so
     * the indicator needs the same extra top gap a tool-call block uses.
     */
    followsText?: boolean;
    /**
     * When the wait began, in epoch ms. Null when the run has produced no event
     * to date it from — at the start of a run — where this component's own mount
     * is the better estimate anyway, since that is when the wait became visible.
     */
    waitingSince?: number | null;
    /**
     * What the line says when neither a reconnect nor a backend retry is
     * speaking for it. Defaults to the ordinary wait for a model's next token;
     * a caller waiting on something else names that instead.
     */
    idleLabel?: string;
}

/**
 * How many whole seconds the wait has lasted, re-rendering once a second.
 *
 * The tick lives here rather than anywhere further up the tree: it fires while
 * nothing else in the pane is changing, and every component it passed through on
 * the way down would re-render with it.
 */
function useElapsedSeconds(since: number | null | undefined): number {
    const mountedAt = useRef(Date.now());
    const start = since ?? mountedAt.current;
    const [elapsedMs, setElapsedMs] = useState(() => Date.now() - start);

    useEffect(() => {
        setElapsedMs(Date.now() - start);
        const timer = setInterval(() => setElapsedMs(Date.now() - start), 1000);
        return () => clearInterval(timer);
    }, [start]);

    return Math.floor(elapsedMs / 1000);
}

/**
 * Displays the current status of an agent run.
 * Shows a spinner for in-progress runs, retry info when backend is retrying,
 * and reconnect progress while the client transparently recovers a dropped
 * connection.
 * Note: Errors are displayed separately by RunErrorDisplay.
 */
export const RunStatusIndicator: React.FC<RunStatusIndicatorProps> = ({ status, runId, lastMessageHasToolCall, followsText, waitingSince, idleLabel = 'Generating' }) => {
    const retryState = useAtomValue(wsRetryAtom);
    const reconnectState = useAtomValue(wsReconnectingAtom);
    const elapsedSeconds = useElapsedSeconds(waitingSince);

    // Check if retry state applies to this run
    const isRetrying = retryState && runId && retryState.runId === runId;

    // Reconnect state is connection-scoped (one active connection at a time),
    // so it applies to whichever run the indicator is spinning for.
    const state = {
        reconnect: reconnectState,
        backendRetry: isRetrying ? retryState : null,
        idleLabel,
    };
    const text = runStatusText({
        ...state,
        elapsedSeconds: elapsedSeconds >= COUNT_AFTER_MS / 1000 ? elapsedSeconds : null,
    });
    // The announced copy leaves the counter out. It changes once a second, and a
    // live region reading "Generating · 4s… Generating · 5s…" over a forty-second
    // wait is worse than the silence it was added to break.
    const announcedText = runStatusText(state);

    // Structure matches ThinkingPartView for smooth visual transition
    return (
        <div className={`rounded-md flex flex-col min-w-0 border-transparent ${followsText ? 'mt-2' : ''}`}>
            <div className="display-flex flex-row py-15">
                <button
                    type="button"
                    className={`
                        variant-ghost-secondary display-flex flex-row py-15 gap-2 w-full text-left disabled-but-styled
                        ${lastMessageHasToolCall ? '-mt-1' : ''}
                    `}
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0, cursor: 'default' }}
                    disabled={true}
                    aria-busy="true"
                >
                    <div className="display-flex flex-row px-3 gap-2">
                        <div className="flex-1 display-flex mt-010">
                            <Icon icon={Spinner} />
                        </div>
                        <div className="display-flex shimmer-text" aria-hidden="true">
                            {text}
                        </div>
                        <span className="sr-only" aria-live="polite">
                            {announcedText}
                        </span>
                    </div>
                </button>
                <div className="flex-1"/>
            </div>
        </div>
    );
};

export default RunStatusIndicator;
