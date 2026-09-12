import { threadReadOnlyAtom } from '../../runtime/threadProjection';
import React, { useState } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import type { ContinuationOffer } from '@beaver/agent-core/protocol/agentProtocol';
import { Icon, AlertCircleIcon, ArrowRightIcon, LayersIcon } from '../icons/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import InstructionsDisclosure from '@beaver/agent-ui/primitives/InstructionsDisclosure';
import { resumeFromRunAtom } from '../../atoms/agentRunAtoms';
import { parseTextWithLinksAndNewlines } from '../../utils/parseTextWithLinksAndNewlines';

/** The only copy this component owns; everything else comes from the offer. */
const INSTRUCTIONS_HEADING = 'Your instructions';
const ADD_INSTRUCTIONS_LABEL = 'Add instructions';

/**
 * Icon per offer kind, with a fallback for every kind this build has never
 * heard of. Chrome only: the offer's prose is still rendered verbatim, so a
 * new kind ships without a client release and simply wears the fallback.
 */
const KIND_ICONS: Record<string, typeof AlertCircleIcon> = {
    // Every batch kind wears the same layers mark the rest of the batch
    // surfaces carry: the approval nobody answered in time, and the offer to
    // run the job's next segment.
    batch_approval: LayersIcon,
    batch_next_tranche: LayersIcon,
};
const FALLBACK_ICON = AlertCircleIcon;

interface RunContinueDisplayProps {
    runId: string;
    /** What the backend offers to carry on from, rendered verbatim. */
    offer: ContinuationOffer;
    /**
     * Whether the run is still receiving its terminal frames — the citation
     * lookup and the agent actions derived from it. Continuing opens a new
     * connection, which closes the current one, so acting here would discard
     * frames the run has not sent yet. The bar is shown regardless; only the
     * button waits, and the wait is the gap between `run_complete` and the
     * frames that follow it.
     */
    isPostProcessing?: boolean;
}

/**
 * Renders a backend-composed offer to resume a response or request more work.
 *
 * Docked to the composer's top edge rather than left in the transcript: the
 * offer is what the thread is waiting on, so it belongs where the user acts
 * next and stays in view however far the transcript is scrolled. The composer
 * is right below it, so the user can also just send an unrelated message —
 * doing so starts a new run, which retires the offer.
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
    const threadReadOnly = useAtomValue(threadReadOnlyAtom);
    const isBlocked = threadReadOnly || isResuming || isPostProcessing;
    const icon = KIND_ICONS[offer.kind] ?? FALLBACK_ICON;

    const handleResume = async () => {
        setIsResuming(true);
        try {
            await resumeFromRun({ runId, userMessage: instructions });
        } finally {
            setIsResuming(false);
        }
    };

    return (
        <div className="composer-docked-bar run-continue-panel px-3 py-2 user-select-text">
            {/* Everything beside the icon shares one column, so the
                instructions field and the button line up with the copy
                rather than hanging under the icon. */}
            <div className="display-flex flex-row gap-2">
                <div className="display-flex mt-010 font-color-secondary flex-none">
                    <Icon icon={icon} size={15} />
                </div>
                <div className="display-flex flex-col gap-25 min-w-0 flex-1">
                    <div className="display-flex flex-col gap-05 min-w-0">
                        <div className="text-base font-color-primary font-medium">
                            {offer.title}
                        </div>
                        <div className="text-sm font-color-secondary">
                            {parseTextWithLinksAndNewlines(offer.message)}
                        </div>
                    </div>

                    {/* Offered only where the kind says instructions mean
                        something. The composer is right there for everything
                        else, and a box the run would ignore is worse than
                        none. */}
                    {offer.allow_message && (
                        <div className="mt-1">
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
                                textareaStyle={{ fontSize: '0.9rem' }}
                            />
                        </div>
                    )}

                    <div className="display-flex flex-row items-center justify-end">
                        <Button
                            variant="outline"
                            rightIcon={ArrowRightIcon}
                            onClick={handleResume}
                            disabled={isBlocked}
                            loading={isResuming}
                            style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                            data-run-continue-action="continue"
                        >
                            {offer.continue_label}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default RunContinueDisplay;
