import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import type { PendingCreditConfirmation } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { removePendingCreditConfirmationAtom } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import {
    closeWSConnectionAtom,
    sendCreditConfirmationResponseAtom,
} from '../../atoms/agentRunAtoms';
import Button from '@beaver/agent-ui/primitives/Button';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { DollarCircleIcon, Icon, StopStrokeIcon } from '../icons/icons';
import { logger } from '@beaver/agent-core/platform/logger';

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
 * listening. The panel is still mounted in the instant after a decision is
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

interface CreditConfirmationCardProps {
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

            {/* Body: the backend's message, its charge lines, then its footer.
                The charges are secondary text; the footer is not one of them —
                it says what the decision means, so it reads as body text and
                stands off from the list above it. */}
            <div className="display-flex flex-col gap-3 min-w-0">
                <div className="font-color-primary">{confirmation.message}</div>
                {confirmation.details.length > 0 && (
                    <div className="display-flex flex-col gap-05 mt-1 min-w-0" role="list">
                        {confirmation.details.map((detail, index) => (
                            <div
                                key={`${index}-${detail}`}
                                role="listitem"
                                className="font-color-secondary text-base"
                            >
                                {detail}
                            </div>
                        ))}
                    </div>
                )}
                {confirmation.footer && (
                    <div className="font-color-primary mt-2 min-w-0">
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

interface CreditConfirmationPanelProps {
    confirmation: PendingCreditConfirmation;
}

/**
 * Composer takeover for a pending run-level credit confirmation.
 *
 * Rendered by Sidebar INSTEAD of InputArea while the run blocks on the user's
 * decision, so the card sits where the user is already looking and cannot be
 * scrolled away. The user's draft message is untouched — this panel never
 * reads or writes currentMessageContentAtom, so the composer restores the
 * draft when the card goes away.
 *
 * Approving lets the run keep spending; declining lets it wrap up with what it
 * already has (both are backend-defined — see the labels it sends). Stop
 * cancels the run outright, which is a different outcome from either.
 *
 * The card is retired when the backend's own deadline passes: past it the run
 * has already moved on, and a card that still looks answerable would take a
 * decision nothing is listening for.
 */
export const CreditConfirmationPanel: React.FC<CreditConfirmationPanelProps> = ({ confirmation }) => {
    const sendResponse = useSetAtom(sendCreditConfirmationResponseAtom);
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);
    const removeConfirmation = useSetAtom(removePendingCreditConfirmationAtom);

    // Drives the disabled styling in the instant before the panel unmounts.
    // The one-shot guard lives in the handlers, not here.
    const [isSubmitted, setIsSubmitted] = useState(false);

    // Built once per panel instance. Sidebar keys the panel by confirmationId,
    // so a new confirmation mounts a new panel with fresh handlers, and
    // `sendResponse` is stable for the instance's lifetime.
    const handlersRef = useRef<CreditDecisionHandlers | null>(null);
    if (handlersRef.current === null) {
        handlersRef.current = createCreditDecisionHandlers(
            confirmation.confirmationId,
            sendResponse,
            () => setIsSubmitted(true),
        );
    }
    const handlers = handlersRef.current;

    // Retire the card when the backend's deadline passes. The deadline is
    // absolute and was stamped when the request arrived, so a card that only
    // renders now — the panel lives in the thread view, which the user can
    // navigate away from — is retired immediately if the run already gave up.
    const { confirmationId, expiresAt } = confirmation;
    useEffect(() => {
        if (!expiresAt) return;
        const expire = () => {
            logger(`CreditConfirmationPanel: Confirmation ${confirmationId} expired`, 1);
            removeConfirmation(confirmationId);
        };
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
            expire();
            return;
        }
        const timer = setTimeout(expire, remaining);
        return () => clearTimeout(timer);
    }, [confirmationId, expiresAt, removeConfirmation]);

    const handleStop = useCallback(() => {
        logger('CreditConfirmationPanel: Stopping run while credit confirmation pending');
        closeWSConnection(); // Also clears pending confirmations -> panel unmounts
    }, [closeWSConnection]);

    return (
        <CreditConfirmationCard
            confirmation={confirmation}
            disabled={isSubmitted}
            onApprove={handlers.approve}
            onDecline={handlers.decline}
            onStop={handleStop}
        />
    );
};

export default CreditConfirmationPanel;
