import React from 'react';
import type { PendingCreditConfirmation } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import Button from '../primitives/Button';
import Tooltip from '../primitives/Tooltip';
import DocsLink from '../primitives/DocsLink';
import { DollarCircleIcon, Icon, StopStrokeIcon } from '../icons';

/** The decision callbacks the card's buttons fire. */
export interface CreditDecisionHandlers {
    approve: () => void;
    decline: () => void;
}

/**
 * Build the one-shot approve/decline handlers for one confirmation.
 *
 * Exactly one decision may leave the client: the run correlates on the
 * confirmation id and a second response would arrive after the backend stopped
 * listening. The card is still mounted in the instant after a decision is
 * sent — the pending entry clears and React re-renders asynchronously — so a
 * second click, or an Enter keypress landing in the same tick, can still reach
 * an enabled handler. Component state settles too late to block that; this
 * closure does not.
 */
export function createCreditDecisionHandlers(
    confirmationId: string,
    send: (decision: { confirmationId: string; approved: boolean }) => void,
    onDecided: () => void,
): CreditDecisionHandlers {
    let decided = false;
    const decide = (approved: boolean) => {
        if (decided) return;
        decided = true;
        onDecided();
        send({ confirmationId, approved });
    };
    return {
        approve: () => decide(true),
        decline: () => decide(false),
    };
}

export interface CreditConfirmationCardProps {
    confirmation: PendingCreditConfirmation;
    /** Disables every control once a decision has been made */
    disabled: boolean;
    onApprove: () => void;
    onDecline: () => void;
    onStop: () => void;
}

/**
 * The confirmation card itself: backend copy plus static chrome.
 *
 * Every word the user reads here — title, message, detail lines, button
 * labels — is composed by the backend and rendered verbatim. This component
 * must not derive prose from `pendingCredits` / `projectedTotalCredits` /
 * `threshold`; those fields exist for logging, and the wording of the decision
 * belongs to whichever backend asked for it.
 *
 * Deliberately hook-free so it can be exercised as a plain function.
 *
 * Spending credits is a decision the user has to make deliberately, so the
 * card has no keyboard shortcut and never takes focus: a keypress meant for
 * the composer must not be able to answer it.
 */
export const CreditConfirmationCard: React.FC<CreditConfirmationCardProps> = ({
    confirmation,
    disabled,
    onApprove,
    onDecline,
    onStop,
}) => (
    <div
        className="user-message-display"
        style={{ minHeight: 'fit-content' }}
        role="group"
        aria-label="Credit confirmation"
        // The card takes no focus, so this is the only thing that tells a
        // screen reader the run has stopped and is waiting on a decision.
        aria-live="assertive"
    >
        <div className="display-flex flex-col gap-4">
            {/* Header: static icon + the backend's title */}
            <div className="display-flex flex-row items-center gap-2 min-w-0">
                <Icon icon={DollarCircleIcon} className="font-color-secondary scale-12 flex-none" />
                <div
                    className="font-color-primary text-sm font-semibold uppercase truncate"
                    style={{ letterSpacing: '0.05em' }}
                >
                    {confirmation.title}
                </div>
            </div>

            {/* DocsLink resolves the backend-provided path for this client. */}
            <div className="display-flex flex-col gap-4 min-w-0">
                <div className="font-color-primary">
                    {confirmation.message}
                    {confirmation.learnMorePath && confirmation.learnMoreLabel && (
                        <>
                            {' '}
                            <DocsLink path={confirmation.learnMorePath}>
                                {confirmation.learnMoreLabel}
                            </DocsLink>
                        </>
                    )}
                </div>
                {confirmation.footer && (
                    <div className="font-color-primary min-w-0">
                        {confirmation.footer}
                    </div>
                )}
            </div>

            {/* Footer: Stop ... Decline Approve */}
            <div className="display-flex flex-row items-center pt-2 gap-2">
                <Tooltip content="Stop the agent run" showArrow singleLine>
                    <Button
                        variant="outline"
                        rightIcon={StopStrokeIcon}
                        ariaLabel="Stop generating"
                        style={{ padding: '2px 5px' }}
                        onClick={onStop}
                    >
                        Stop
                    </Button>
                </Tooltip>
                <div className="flex-1" />
                <Button
                    variant="ghost"
                    onClick={onDecline}
                    disabled={disabled}
                >
                    {confirmation.declineLabel}
                </Button>
                <Button
                    variant="solid"
                    style={{ padding: '2px 5px' }}
                    onClick={onApprove}
                    disabled={disabled}
                >
                    {confirmation.approveLabel}
                </Button>
            </div>
        </div>
    </div>
);

export default CreditConfirmationCard;
