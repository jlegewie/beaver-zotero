import React, { useState } from 'react';
import { useSetAtom } from 'jotai';
import type { ContinuationOffer } from '@beaver/agent-core/protocol/agentProtocol';
import { Icon, AlertCircleIcon, ArrowRightIcon } from '../icons/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import InstructionsDisclosure from '@beaver/agent-ui/primitives/InstructionsDisclosure';
import { resumeFromRunAtom } from '../../atoms/agentRunAtoms';

/** The only copy this component owns; everything else comes from the offer. */
const INSTRUCTIONS_HEADING = 'Your instructions';
const ADD_INSTRUCTIONS_LABEL = 'Add instructions';

interface RunContinueDisplayProps {
    runId: string;
    /** What the backend offers to carry on from, rendered verbatim. */
    offer: ContinuationOffer;
    /**
     * Whether the run is still receiving its terminal frames — the citation
     * lookup and the agent actions derived from it. Continuing opens a new
     * connection, which closes the current one, so acting here would discard
     * frames the run has not sent yet. The card is shown regardless; only the
     * button waits, and the wait is the gap between `run_complete` and the
     * frames that follow it.
     */
    isPostProcessing?: boolean;
}

/**
 * Offers to carry on from a run that ended without being finished — Beaver
 * closed, the connection dropped, the server restarted, or a decision the run
 * was waiting on never came.
 *
 * Deliberately not an error card: nothing failed, and the run was not billed.
 * It renders below the response rather than over the composer, so the user can
 * always ignore it and type something else instead.
 *
 * Every word about the run comes from the offer and is rendered verbatim, which
 * is what lets the backend add a case without a client release. Nothing here
 * may switch on `offer.kind` to compose prose of its own.
 */
export const RunContinueDisplay: React.FC<RunContinueDisplayProps> = ({
    runId,
    offer,
    isPostProcessing = false,
}) => {
    const resumeFromRun = useSetAtom(resumeFromRunAtom);
    const [isResuming, setIsResuming] = useState(false);
    const [wantsInstructions, setWantsInstructions] = useState(false);
    const [instructions, setInstructions] = useState('');
    const isBlocked = isResuming || isPostProcessing;

    const handleResume = async () => {
        setIsResuming(true);
        try {
            await resumeFromRun({ runId, userMessage: instructions });
        } finally {
            setIsResuming(false);
        }
    };

    return (
        <div className="px-4 user-select-text">
            <div
                className="rounded-md display-flex flex-col min-w-0 p-3 gap-5"
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
                            {offer.title}
                        </div>
                        <div className="text-base font-color-secondary">
                            {offer.message}
                        </div>
                    </div>
                </div>

                {/* Offered only where the kind says instructions mean
                    something. The composer is right there for everything
                    else, and a box the run would ignore is worse than none. */}
                {offer.allow_message && (
                    <InstructionsDisclosure
                        open={wantsInstructions}
                        onOpen={() => setWantsInstructions(true)}
                        value={instructions}
                        onChange={setInstructions}
                        revealLabel={ADD_INSTRUCTIONS_LABEL}
                        heading={INSTRUCTIONS_HEADING}
                        placeholder={
                            offer.instructions_placeholder
                            || 'Anything to change before continuing'
                        }
                        ariaLabel="Instructions for continuing (optional)"
                        // Typing opens no connection, so the field stays
                        // live while the run finishes sending.
                        disabled={isResuming}
                        textareaStyle={{ marginLeft: '-3px', fontSize: '0.98rem' }}
                    />
                )}

                <div className="display-flex flex-row items-center justify-end">
                    <Button
                        variant="outline"
                        rightIcon={ArrowRightIcon}
                        onClick={handleResume}
                        disabled={isBlocked}
                        loading={isResuming}
                        data-run-continue-action="continue"
                    >
                        {offer.continue_label}
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default RunContinueDisplay;
