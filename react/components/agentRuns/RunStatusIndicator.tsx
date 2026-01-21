import React from 'react';
import { useAtomValue } from 'jotai';
import { Icon, Spinner, RepeatIcon } from '../icons/icons';
import { AgentRunStatus } from '../../agents/types';
import { wsRetryAtom } from '../../atoms/agentRunAtoms';

interface RunStatusIndicatorProps {
    status: AgentRunStatus;
    /** The run ID to match retry state against */
    runId?: string;
    /** Whether the previous message has a tool call */
    lastMessageHasToolCall?: boolean;
}

/**
 * Displays the current status of an agent run.
 * Shows a spinner for in-progress runs, retry info when backend is retrying.
 * Note: Errors are displayed separately by RunErrorDisplay.
 */
export const RunStatusIndicator: React.FC<RunStatusIndicatorProps> = ({ status, runId, lastMessageHasToolCall }) => {
    const retryState = useAtomValue(wsRetryAtom);
    
    // Check if retry state applies to this run
    const isRetrying = retryState && runId && retryState.runId === runId;
    
    const text = isRetrying
        // ? `Retrying (${retryState.attempt}/${retryState.maxAttempts}): ${retryState.reason}`
        ? `Retrying...`
        : 'Generating';

    // Structure matches ThinkingPartView for smooth visual transition
    return (
        <div className="rounded-md flex flex-col min-w-0 border-transparent">
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
                    aria-live="polite"
                >
                    <div className="display-flex flex-row px-3 gap-2">
                        <div className="flex-1 display-flex mt-010">
                            <Icon icon={Spinner} />
                        </div>
                        <div className="display-flex shimmer-text">
                            {text}
                        </div>
                    </div>
                </button>
                <div className="flex-1"/>
            </div>
        </div>
    );
};

export default RunStatusIndicator;
