import React, { useState } from 'react';
import { useSetAtom } from 'jotai';
import { Icon, AlertCircleIcon, LinkForwardIcon } from '../icons/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import { resumeFromRunAtom } from '../../atoms/agentRunAtoms';

interface RunInterruptedDisplayProps {
    runId: string;
    /** `error.reason_code` from the run the backend stopped. */
    reasonCode?: string;
}

/**
 * Offers to continue a run that was cut off rather than finished — Beaver
 * closed, the connection dropped, or the server restarted mid-response.
 *
 * Deliberately not an error card: nothing failed, and the run was not billed.
 * It is derived from run state rather than stored, so it never becomes part of
 * the message history and disappears once the run has been resumed.
 */
export const RunInterruptedDisplay: React.FC<RunInterruptedDisplayProps> = ({ runId, reasonCode }) => {
    const resumeFromRun = useSetAtom(resumeFromRunAtom);
    const [isResuming, setIsResuming] = useState(false);

    const handleResume = async () => {
        setIsResuming(true);
        try {
            await resumeFromRun(runId);
        } finally {
            setIsResuming(false);
        }
    };

    return (
        <div className="px-4 user-select-text">
            <div
                className="rounded-md display-flex flex-col min-w-0 p-3 gap-3"
                style={{
                    background: 'var(--fill-senary)',
                    border: '1px solid var(--fill-quinary)',
                }}
            >
                <div className="display-flex flex-row gap-2">
                    <div className="display-flex mt-010 font-color-secondary">
                        <Icon icon={AlertCircleIcon} size={15}/>
                    </div>
                    <div className="display-flex flex-col gap-1">
                        <div className="text-base font-color-primary font-medium">
                            Response interrupted
                        </div>
                        <div className="text-base font-color-secondary">
                            {interruptionText(reasonCode)}
                        </div>
                    </div>
                </div>

                <div className="display-flex flex-row items-center justify-end">
                    <Button
                        variant="outline"
                        rightIcon={LinkForwardIcon}
                        onClick={handleResume}
                        disabled={isResuming}
                        loading={isResuming}
                        data-run-interrupted-action="resume"
                    >
                        Continue response
                    </Button>
                </div>
            </div>
        </div>
    );
};

/** What cut the run off, in the user's terms. */
function interruptionText(reasonCode?: string): string {
    switch (reasonCode) {
        case 'connection_lost':
            return 'The connection dropped before this response finished. Continuing picks up where it left off.';
        case 'server_shutdown':
            return 'The server restarted before this response finished. Continuing picks up where it left off.';
        case 'client_closed':
        default:
            return 'Beaver closed before this response finished. Continuing picks up where it left off.';
    }
}

export default RunInterruptedDisplay;
