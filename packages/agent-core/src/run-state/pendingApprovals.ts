/**
 * Writes the backend has deferred for the user's approval.
 *
 * An entry means a run is waiting on that decision. What a client does when
 * the set changes (previews, notifications) is its own; this module holds only
 * the state.
 */

import { atom } from 'jotai/vanilla';
import type { AgentActionType, WSDeferredApprovalRequest } from '../protocol/agentProtocol';

/**
 * A write the backend has deferred for user approval, as carried by the
 * `deferred_approval_request` wire event. Client-neutral by construction: the
 * shape is that event's payload, and `actionData` stays opaque — only the client
 * that renders and applies the action interprets it.
 */
export interface PendingApproval {
    actionId: string;
    toolcallId: string;
    actionType: AgentActionType;
    actionData: Record<string, any>;
    /** Prior value of the edited object, when the backend sent one (for diffs). */
    currentValue?: any;
}

/**
 * Pending approval requests, keyed by action id. Parallel tool calls can wait
 * on several at once.
 */
export const pendingApprovalsAtom = atom<Map<string, PendingApproval>>(new Map());

/** The pending approval a `deferred_approval_request` event asks for. */
export function pendingApprovalFromRequest(event: WSDeferredApprovalRequest): PendingApproval {
    return {
        actionId: event.action_id,
        toolcallId: event.toolcall_id,
        actionType: event.action_type as AgentActionType,
        actionData: event.action_data,
        currentValue: event.current_value,
    };
}
