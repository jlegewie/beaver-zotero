import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import type { PendingCreditConfirmation } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { removePendingCreditConfirmationAtom } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import {
    closeWSConnectionAtom,
    sendCreditConfirmationResponseAtom,
} from '../../atoms/agentRunAtoms';
import CreditConfirmationCard, {
    createCreditDecisionHandlers,
    type CreditDecisionHandlers,
} from '@beaver/agent-ui/chat/CreditConfirmationCard';
import { logger } from '@beaver/agent-core/platform/logger';

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
