import React from 'react';
import Button from '../ui/Button';
import { Icon, Spinner, AlertIcon } from '../icons/icons';
import { AgentRunStatus } from '../../agents/types';

interface RunStatusIndicatorProps {
    status: AgentRunStatus;
}

/**
 * Displays the current status of an agent run.
 * Shows a spinner for in-progress runs, error icon for errors.
 */
export const RunStatusIndicator: React.FC<RunStatusIndicatorProps> = ({ status }) => {
    if (status === 'completed' || status === 'canceled') {
        return null;
    }

    const getIcon = () => {
        if (status === 'in_progress' || status === 'awaiting_deferred') return Spinner;
        if (status === 'error') return AlertIcon;
        return Spinner;
    };

    const getText = () => {
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
                            <div className={`flex-1 display-flex mt-010 ${isError ? 'text-red-600' : ''}`}>
                                <Icon icon={getIcon()} />
                            </div>
                            
                            <div className={`display-flex ${isError ? 'text-red-600' : 'shimmer-text'}`}>
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

