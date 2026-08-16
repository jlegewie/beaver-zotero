import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import type { PendingCreditConfirmation } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
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
    containerRef: React.RefObject<HTMLDivElement>;
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
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
 */
export const CreditConfirmationCard: React.FC<CreditConfirmationCardProps> = ({
    confirmation,
    disabled,
    containerRef,
    onKeyDown,
    onApprove,
    onDecline,
    onStop,
}) => (
    <div
        ref={containerRef}
        className="user-message-display"
        style={{ minHeight: 'fit-content' }}
        role="group"
        aria-label="Credit confirmation"
        tabIndex={-1}
        onKeyDown={onKeyDown}
    >
        <div className="display-flex flex-col gap-15">
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

            {/* Body: the backend's message, then its detail lines */}
            <div className="display-flex flex-col gap-1 min-w-0">
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
                    <span>
                        {confirmation.approveLabel} <span className="opacity-50">⏎</span>
                    </span>
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
 * The panel takes focus on mount so Enter (approve, the default action) and
 * Escape (decline) work without the user first clicking into the card.
 */
export const CreditConfirmationPanel: React.FC<CreditConfirmationPanelProps> = ({ confirmation }) => {
    const sendResponse = useSetAtom(sendCreditConfirmationResponseAtom);
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);

    // Drives the disabled styling in the instant before the panel unmounts.
    // The one-shot guard lives in the handlers, not here.
    const [isSubmitted, setIsSubmitted] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

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

    useEffect(() => {
        containerRef.current?.focus();
    }, []);

    const handleStop = useCallback(() => {
        logger('CreditConfirmationPanel: Stopping run while credit confirmation pending');
        closeWSConnection(); // Also clears pending confirmations -> panel unmounts
    }, [closeWSConnection]);

    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'Enter' && !event.shiftKey) {
            // preventDefault so a focused button is not activated a second
            // time by the same keypress.
            event.preventDefault();
            handlers.approve();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            handlers.decline();
        }
    }, [handlers]);

    return (
        <CreditConfirmationCard
            confirmation={confirmation}
            disabled={isSubmitted}
            containerRef={containerRef}
            onKeyDown={handleKeyDown}
            onApprove={handlers.approve}
            onDecline={handlers.decline}
            onStop={handleStop}
        />
    );
};

export default CreditConfirmationPanel;
