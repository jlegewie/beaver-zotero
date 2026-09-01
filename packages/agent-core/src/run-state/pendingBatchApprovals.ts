/**
 * Pending batch-approval state (batch_start tool).
 *
 * Deliberately separate from the host's agent-action state: a batch approval
 * is NOT an agent action — it has no apply/undo/validate lifecycle and no
 * AgentActionType. It is a run-blocking request covering a whole batch rather
 * than one tool call, answered through a dedicated WS event pair
 * (`batch_approval_request` / `batch_approval_response`) correlated by
 * `approval_id`.
 *
 * There is no expiry timestamp here and no client-side expiry timer, unlike
 * the credit confirmation next door. `batch_start` always returns — on an
 * approval, a decline, or the backend's own timeout — so the tool return
 * retires the entry the way a question is retired, and `batch_approval_stale`
 * covers a response that arrives too late. A local timer would race the tool
 * return and could hide the card while the user is still choosing.
 */

import { atom } from 'jotai/vanilla';
import type {
    BatchApprovalMode,
    WSBatchApprovalRequest,
} from '../protocol/agentProtocol';

/**
 * Pending batch approval from the backend.
 *
 * Every user-facing string is composed by the backend and is rendered
 * verbatim; the client contributes only its own chrome (the mode labels and
 * the instructions placeholder). The client must not compose prose of its own
 * from these fields.
 */
export interface PendingBatchApproval {
    /** Correlation id for the wire response (the map key) */
    approvalId: string;
    /** The agent run awaiting the decision */
    runId: string;
    /** Thread the run belongs to, when the backend reports it */
    threadId?: string | null;
    /** Tool call that declared the batch, so the card can be anchored to it */
    toolcallId: string;
    /** The batch awaiting approval */
    batchId: string;
    /** Card title, rendered verbatim */
    title: string;
    /**
     * The population's size, e.g. "184 items". Rendered verbatim as the
     * emphasised half of the scope line, and always set.
     */
    scopePrimary: string;
    /**
     * Where that population lives, e.g. "in Methods and its subcollections".
     * Empty when the backend could not state it truthfully — a batch whose ids
     * the model typed, or a collection the client never named back — and the
     * card then shows the count alone.
     */
    scopeSecondary: string;
    /** The batch goal, rendered verbatim */
    message: string;
    /**
     * What the batch removes or overwrites, rendered verbatim in its own
     * block; empty when the batch declared nothing destructive, and the block
     * is then hidden.
     */
    destructiveWarning: string;
    /**
     * What the job costs the user directly, rendered verbatim in its own
     * block; set only for a run on the user's own API key that is large enough
     * to warn about, and empty for everyone else — including every run whose
     * cost the credit chip already quotes.
     */
    costWarning: string;
    /**
     * Short line about the confirmation limit approving raises, shown beside
     * the title. Empty when the run has no credit ledger or the user switched
     * confirmations off, and the chip is then hidden.
     */
    creditChip: string;
    /**
     * The sentence the chip abbreviates, shown on hover; empty under the same
     * conditions as the chip.
     */
    creditTooltip: string;
    /** Coverage mode the card preselects */
    defaultMode: BatchApprovalMode;
    /** Approve button label, rendered verbatim */
    approveLabel: string;
    /** Decline button label, rendered verbatim */
    declineLabel: string;
    /** Decline button label once instructions have been typed */
    declineWithInstructionsLabel: string;
    /** Backend-provided docs link text */
    learnMoreLabel?: string;
    /** Docs path resolved against the client's environment-specific docs URL */
    learnMorePath?: string;
    /**
     * Initial contents of the instructions box; a non-empty value also opens it.
     * Carried forward from an earlier batch's approval. Editable default —
     * the response is what binds.
     */
    userInstructionsPrefill: string;
    /** How long the backend will wait for a response, in seconds */
    timeoutSeconds: number;
}

/**
 * Atom storing pending batch approvals, keyed by approvalId.
 * At most one is live per run; the Map keeps the shape symmetric with the
 * neighbouring pending-request maps and makes a late duplicate harmless.
 */
export const pendingBatchApprovalsAtom = atom<Map<string, PendingBatchApproval>>(new Map());

/** Add a pending batch approval from a WS event. */
export const addPendingBatchApprovalAtom = atom(
    null,
    (_get, set, event: WSBatchApprovalRequest) => {
        set(pendingBatchApprovalsAtom, (prev) => {
            const next = new Map(prev);
            next.set(event.approval_id, {
                approvalId: event.approval_id,
                runId: event.run_id,
                threadId: event.thread_id,
                toolcallId: event.toolcall_id,
                batchId: event.batch_id,
                title: event.title,
                scopePrimary: event.scope_primary,
                scopeSecondary: event.scope_secondary,
                message: event.message,
                destructiveWarning: event.destructive_warning,
                // Absent from a backend that predates the field, which is the
                // same thing as a run with nothing to warn about.
                costWarning: event.cost_warning || '',
                creditChip: event.credit_chip,
                creditTooltip: event.credit_tooltip,
                defaultMode: event.default_mode,
                approveLabel: event.approve_label,
                declineLabel: event.decline_label,
                declineWithInstructionsLabel:
                    event.decline_with_instructions_label || event.decline_label,
                learnMoreLabel: event.learn_more_label,
                learnMorePath: event.learn_more_path,
                // Absent from a backend that predates the field, which is the
                // same thing as a batch that continues nothing.
                userInstructionsPrefill: event.user_instructions_prefill || '',
                timeoutSeconds: event.timeout_seconds,
            });
            return next;
        });
    }
);

/** Remove a pending batch approval (after the user decides, the tool returns,
 * or the response goes stale). */
export const removePendingBatchApprovalAtom = atom(
    null,
    (_get, set, approvalId: string) => {
        set(pendingBatchApprovalsAtom, (prev) => {
            if (!prev.has(approvalId)) return prev;
            const next = new Map(prev);
            next.delete(approvalId);
            return next;
        });
    }
);

/** Clear all pending batch approvals (thread switch, run end, disconnect, ...). */
export const clearAllPendingBatchApprovalsAtom = atom(
    null,
    (_get, set) => {
        set(pendingBatchApprovalsAtom, new Map());
    }
);
