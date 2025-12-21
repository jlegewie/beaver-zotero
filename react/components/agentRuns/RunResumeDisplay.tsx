import React from 'react';

interface RunResumeDisplayProps {
    runId: string;
}

/**
 * Displays a message for a resumed failed agent run.
 */
export const RunResumeDisplay: React.FC<RunResumeDisplayProps> = ({ runId }) => {
    return (
        <div className="px-4">
            <div className="display-flex flex-col gap-3">
                <div className="text-base font-color-tertiary">
                    Resuming failed request...
                </div>
            </div>
        </div>
    );
};

export default RunResumeDisplay;
