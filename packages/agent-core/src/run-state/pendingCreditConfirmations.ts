/**
 * Pending run-level credit confirmation state.
 *
 * Deliberately separate from the host's agent-action state: a credit
 * confirmation is NOT an agent action — it has no apply/undo/validate
 * lifecycle, no AgentActionType, and no tool call to anchor to. It is a
 * run-blocking request covering the whole run, answered through a dedicated WS
 * event pair (`credit_confirmation_request` / `credit_confirmation_response`)
 * correlated by `confirmation_id`.
 */

import { atom } from 'jotai/vanilla';
import type { WSCreditConfirmationRequest } from '../protocol/agentProtocol';

/**
 * Pending credit confirmation from the backend.
 *
 * The copy fields are composed by the backend and are rendered verbatim. The
 * numeric fields are carried for logging and telemetry only — the client must
 * not compose its own wording from them.
 */
export interface PendingCreditConfirmation {
    /** Correlation id for the wire response (the map key) */
    confirmationId: string;
    /** The agent run awaiting confirmation */
    runId: string;
    /** Thread the run belongs to, when the backend reports it */
    threadId?: string | null;
    /** Card title, rendered verbatim */
    title: string;
    /** Card body text, rendered verbatim */
    message: string;
    /** Supporting lines rendered as-is under the message */
    details: string[];
    /** Approve button label, rendered verbatim */
    approveLabel: string;
    /** Decline button label, rendered verbatim */
    declineLabel: string;
    /** Extra credits this decision authorizes (logging only) */
    pendingCredits: number;
    /** Projected total credits for the run if it continues (logging only) */
    projectedTotalCredits: number;
    /** Credit threshold that triggered this confirmation (logging only) */
    threshold: number;
    /** How long the backend will wait for a response, in seconds */
    timeoutSeconds: number;
    /**
     * When the backend stops waiting, as a local timestamp.
     *
     * Stamped on arrival rather than measured from when a panel renders: the
     * card only renders in thread view, so a user who navigates away and comes
     * back would otherwise be shown a fresh countdown for a decision the run
     * has already given up on.
     */
    expiresAt: number;
}

/**
 * Atom storing pending credit confirmations, keyed by confirmationId.
 * At most one is live per run; the Map keeps the shape symmetric with the
 * neighbouring pending-request maps and makes a late duplicate harmless.
 */
export const pendingCreditConfirmationsAtom = atom<Map<string, PendingCreditConfirmation>>(new Map());

/** Add a pending credit confirmation from a WS event. */
export const addPendingCreditConfirmationAtom = atom(
    null,
    (_get, set, event: WSCreditConfirmationRequest) => {
        // The backend started its clock before it sent this, so the deadline is
        // stamped now — the earliest the client can know about the request.
        const expiresAt = Date.now() + (event.timeout_seconds ?? 0) * 1000;
        set(pendingCreditConfirmationsAtom, (prev) => {
            const next = new Map(prev);
            next.set(event.confirmation_id, {
                confirmationId: event.confirmation_id,
                runId: event.run_id,
                threadId: event.thread_id,
                title: event.title,
                message: event.message,
                details: event.details ?? [],
                approveLabel: event.approve_label,
                declineLabel: event.decline_label,
                pendingCredits: event.pending_credits,
                projectedTotalCredits: event.projected_total_credits,
                threshold: event.threshold,
                timeoutSeconds: event.timeout_seconds,
                expiresAt,
            });
            return next;
        });
    }
);

/** Remove a pending credit confirmation (after the user responds or it goes stale). */
export const removePendingCreditConfirmationAtom = atom(
    null,
    (_get, set, confirmationId: string) => {
        set(pendingCreditConfirmationsAtom, (prev) => {
            if (!prev.has(confirmationId)) return prev;
            const next = new Map(prev);
            next.delete(confirmationId);
            return next;
        });
    }
);

/** Clear all pending credit confirmations (thread switch, run end, disconnect, ...). */
export const clearAllPendingCreditConfirmationsAtom = atom(
    null,
    (_get, set) => {
        set(pendingCreditConfirmationsAtom, new Map());
    }
);
