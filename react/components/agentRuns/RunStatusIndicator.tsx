import React from 'react';
import { useAtomValue } from 'jotai';
import Button from '../ui/Button';
import { Icon, Spinner, AlertIcon, RepeatIcon } from '../icons/icons';
import { AgentRunStatus } from '../../agents/types';
import { wsRetryAtom, RetryState } from '../../atoms/generateMessagesWS';

interface RunStatusIndicatorProps {
    status: AgentRunStatus;
    /** The run ID to match retry state against */
    runId?: string;
}

/**
 * Displays the current status of an agent run.
 * Shows a spinner for in-progress runs, retry info when retrying, error icon for errors.
 */
export const RunStatusIndicator: React.FC<RunStatusIndicatorProps> = ({ status, runId }) => {
    const retryState = useAtomValue(wsRetryAtom);
    
    // Check if retry state applies to this run
    const isRetrying = retryState && runId && retryState.runId === runId;

    if (status === 'completed' || status === 'canceled') {
        return null;
    }

    const getIcon = () => {
        if (isRetrying) return RepeatIcon;
        if (status === 'in_progress' || status === 'awaiting_deferred') return Spinner;
        if (status === 'error') return AlertIcon;
        return Spinner;
    };

    const getText = () => {
        if (isRetrying) {
            const { attempt, maxAttempts, reason } = retryState as RetryState;
            return `Retrying (${attempt}/${maxAttempts}): ${reason}`;
        }
        if (status === 'in_progress') return 'Generating';
        if (status === 'awaiting_deferred') return 'Processing';
        if (status === 'error') return 'Error';
        return 'Processing';
    };

    const isError = status === 'error';

    // Structure matches ThinkingPartView for smooth visual transition
    return (
        <div className="rounded-md flex flex-col min-w-0 border-transparent">
            <div className="display-flex flex-row py-15">
                <div className="display-flex flex-row flex-1">
                    <Button
                        variant="ghost-secondary"
                        className={`
                            text-base scale-105 w-full min-w-0 align-start text-left
                            disabled-but-styled
                        `}
                        style={{ padding: '2px 6px', maxHeight: 'none' }}
                        disabled={true}
                    >
                        <div className="display-flex flex-row px-3 gap-2">
                            <div className={`flex-1 display-flex mt-010 ${isError ? 'text-red-600' : ''} ${isRetrying ? 'text-amber-600' : ''}`}>
                                <Icon icon={getIcon()} />
                            </div>
                            
                            <div className={`display-flex ${isError ? 'text-red-600' : ''} ${isRetrying ? 'text-amber-600' : 'shimmer-text'}`}>
                                {getText()}
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
