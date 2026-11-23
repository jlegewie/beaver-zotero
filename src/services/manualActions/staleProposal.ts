/**
 * Drift checks for applying a stored action after its run.
 *
 * A proposal can be hours old by the time the user applies it. The executors
 * for changes that overwrite library state compare the baseline stored with
 * the proposal against the library now, and refuse to write when it moved:
 * the action fails with `stale_proposal`, and the user can apply it anyway
 * (`skipStaleCheck`) or reject it. A proposal stored without a baseline is
 * applied without a check.
 */

import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

export const STALE_PROPOSAL_CODE = 'stale_proposal';

/** Options for applying a stored action from the UI. */
export interface ManualApplyOptions {
    /** Write even if the library changed since the proposal (the user's "Apply anyway"). */
    skipStaleCheck?: boolean;
}

/** The error an executor throws when the library changed since the proposal. */
export function staleProposalError(message: string): Error {
    return Object.assign(new Error(message), { name: 'StaleProposalError', code: STALE_PROPOSAL_CODE });
}

/**
 * True when an apply was refused because the library changed since the
 * proposal. Retrying fails the same way; the surfaces offer "Apply anyway"
 * and Reject instead.
 */
export function isStaleProposal(action: AgentAction): boolean {
    return action.status === 'error'
        && action.result_data == null
        && action.error_details?.error_code === STALE_PROPOSAL_CODE;
}

/** "a", "a and b", "a, b and c". */
export function joinList(parts: string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "1 item", "3 items". */
export function itemCountPhrase(count: number): string {
    return `${count} item${count === 1 ? '' : 's'}`;
}
