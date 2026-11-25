/**
 * Adding and removing a session's pending approvals.
 *
 * The approvals are session state. What the window does when they change (the
 * note diff preview, the OS notification for a new request) goes through the
 * session's host.
 */

import { atom } from 'jotai/vanilla';
import type { WSDeferredApprovalRequest } from '@beaver/agent-core/protocol/agentProtocol';
import {
    pendingApprovalFromRequest,
    pendingApprovalsAtom,
    type PendingApproval,
} from '@beaver/agent-core/run-state/pendingApprovals';
import { sessionOf } from './runSession';

export { pendingApprovalsAtom, type PendingApproval };

/**
 * Add a pending approval from a WS event, or from the stored card of a parked
 * run. `silent` skips the OS notification: a parked card restored on load is
 * not news to the user.
 */
export const addPendingApprovalAtom = atom(
    null,
    (get, set, event: WSDeferredApprovalRequest, options?: { silent?: boolean }) => {
        set(pendingApprovalsAtom, (prev) => new Map(prev).set(event.action_id, pendingApprovalFromRequest(event)));
        sessionOf(get).host.approvalRequested(event, { silent: options?.silent ?? false });
    },
);

/**
 * Remove pending approvals in one map update, so the window refreshes what
 * depended on them once, from the final state.
 */
export const removePendingApprovalsAtom = atom(
    null,
    (get, set, actionIds: Iterable<string>) => {
        const ids = new Set(actionIds);
        if (ids.size === 0) return;
        const previous = get(pendingApprovalsAtom);
        const removed = [...ids].flatMap((id) => previous.get(id) ?? []);
        set(pendingApprovalsAtom, (p) => {
            const next = new Map(p);
            for (const actionId of ids) next.delete(actionId);
            return next;
        });
        sessionOf(get).host.approvalsRemoved(removed);
    },
);

/** Remove a specific pending approval by actionId (after user responds). */
export const removePendingApprovalAtom = atom(
    null,
    (_get, set, actionId: string) => {
        set(removePendingApprovalsAtom, [actionId]);
    },
);

/** Clear all pending approvals (e.g., when switching threads or on run complete). */
export const clearAllPendingApprovalsAtom = atom(
    null,
    (get, set) => {
        sessionOf(get).host.approvalsCleared();
        set(pendingApprovalsAtom, new Map());
    },
);
