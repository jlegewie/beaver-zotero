import React from 'react';
import { useAtomValue } from 'jotai';
import Button from '../ui/Button';
import { Icon, Spinner, RepeatIcon } from '../icons/icons';
import { AgentRunStatus } from '../../agents/types';
import { wsRetryAtom } from '../../atoms/agentRunAtoms';

interface RunStatusIndicatorProps {
    status: AgentRunStatus;
    /** The run ID to match retry state against */
    runId?: string;
}

/**
 * Displays the current status of an agent run.
 * Shows a spinner for in-progress runs, retry info when backend is retrying.
 * Note: Errors are displayed separately by RunErrorDisplay.
 */
export const RunStatusIndicator: React.FC<RunStatusIndicatorProps> = ({ status, runId }) => {
    const retryState = useAtomValue(wsRetryAtom);
    
    // Check if retry state applies to this run
    const isRetrying = retryState && runId && retryState.runId === runId;

    // Only show for in-progress or awaiting_deferred statuses
    if (status !== 'in_progress' && status !== 'awaiting_deferred') {
        return null;
    }
    
    const text = isRetrying
        // ? `Retrying (${retryState.attempt}/${retryState.maxAttempts}): ${retryState.reason}`
        ? `Retrying...`
        : status === 'awaiting_deferred'
            ? 'Processing'
            : 'Generating';

    // Structure matches ThinkingPartView for smooth visual transition
    return (
        <div className="rounded-md flex flex-col min-w-0 border-transparent">
            <div className="display-flex flex-row py-15">
                <div className="display-flex flex-row flex-1">
                    <Button
                        variant="ghost-secondary"
                        className="text-base scale-105 w-full min-w-0 align-start text-left disabled-but-styled"
                        style={{ padding: '2px 6px', maxHeight: 'none' }}
                        disabled={true}
                    >
                        <div className="display-flex flex-row px-3 gap-2">
                            <div className="flex-1 display-flex mt-010">
                                <Icon icon={Spinner} />
                            </div>
                            <div className="display-flex shimmer-text">
                                {text}
                            </div>
                        </div>
                    </Button>
                    <div className="flex-1"/>
                </div>
            </div>
        </div>
    );
};

export default RunStatusIndicator;
