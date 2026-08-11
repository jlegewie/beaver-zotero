import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { getActionToolGroup } from '../../../atoms/runApprovalPolicy';

/** A tool call the review card offers for review, with all of its actions. */
export interface ReviewRow {
    /** Tool call this row represents; stable react key. */
    toolcallId: string;
    /** action_type of the row's first action (all actions in a row share it). */
    actionType: string;
    /** The row's actions, in input order. */
    actions: AgentAction[];
    /** False when the card's bulk apply must skip this row. */
    bulkApplicable: boolean;
    /** True when nothing in the row is pending any more. */
    resolved: boolean;
}

export interface BuildReviewRowsOptions {
    /** Action ids with a live approval (pendingApprovalsAtom) — those belong to the in-stream card. */
    liveApprovalActionIds?: ReadonlySet<string>;
    /** Actions resolved from this card that stay in its current session snapshot. */
    retainedActionIds?: ReadonlySet<string>;
}

/** These gate a run rather than propose a change, so they are never review material. */
const GATING_ACTION_TYPES = new Set<string>(['confirm_extraction', 'confirm_external_search']);

/** Citation imports have their own card. */
const CITATIONS_TOOLCALL_ID = 'citations';

/**
 * Types the shared executor has no apply path for: note edits and inline notes
 * apply through their own surfaces (`EditNoteGroupView`, the notes display), and
 * the per-annotation types are legacy. A row here would offer a dead ✓.
 */
const UNAPPLIABLE_ACTION_TYPES = new Set<string>([
    'edit_note',
    'edit_note_batch',
    'zotero_note',
    'highlight_annotation',
    'note_annotation',
]);

/**
 * Groups the bulk ✓ must never carry along. They are separate approval groups
 * in runApprovalPolicy precisely so approving annotation or note edits cannot
 * include them; a bulk apply must not re-open that.
 */
const NON_BULK_TOOL_GROUPS = new Set<string>(['annotation_deletion', 'note_rewrite']);

/** False for annotation deletions and destructive note rewrites. */
export function isBulkApplicable(action: AgentAction): boolean {
    const group = getActionToolGroup(action.action_type, action.proposed_data);
    return group === null || !NON_BULK_TOOL_GROUPS.has(group);
}

/**
 * Build the review card's rows from the actions of one terminal run: one row
 * per tool call, the same unit the in-stream card renders.
 */
export function buildReviewRows(
    actions: AgentAction[],
    options: BuildReviewRowsOptions = {},
): ReviewRow[] {
    const { liveApprovalActionIds, retainedActionIds } = options;
    const rowsByToolcall = new Map<string, ReviewRow>();

    // A live approval claims its whole tool call, not just the action it names:
    // the in-stream card renders and applies a call as one unit, so a create_items
    // approval covering one of five actions must not leave the other four here.
    const approvedToolcallIds = new Set<string>();
    if (liveApprovalActionIds) {
        for (const action of actions) {
            if (action.toolcall_id && liveApprovalActionIds.has(action.id)) {
                approvedToolcallIds.add(action.toolcall_id);
            }
        }
    }

    for (const action of actions) {
        if (GATING_ACTION_TYPES.has(action.action_type)) continue;
        if (UNAPPLIABLE_ACTION_TYPES.has(action.action_type)) continue;
        if (liveApprovalActionIds?.has(action.id)) continue;

        const toolcallId = action.toolcall_id;
        if (!toolcallId || toolcallId === CITATIONS_TOOLCALL_ID) continue;
        if (approvedToolcallIds.has(toolcallId)) continue;

        // Start with pending actions. Once the user resolves actions from this
        // card, retain them so the rows do not shift while other changes
        // are still pending and the resolved status remains visible.
        if (action.status !== 'pending' && !retainedActionIds?.has(action.id)) continue;

        const row = rowsByToolcall.get(toolcallId);
        if (row) {
            row.actions.push(action);
        } else {
            rowsByToolcall.set(toolcallId, {
                toolcallId,
                actionType: action.action_type,
                actions: [action],
                bulkApplicable: true,
                resolved: true,
            });
        }
    }

    const rows = Array.from(rowsByToolcall.values());
    for (const row of rows) {
        row.bulkApplicable = row.actions.every(isBulkApplicable);
        row.resolved = !row.actions.some((action) => action.status === 'pending');
    }
    return rows;
}

/** Whether the current card snapshot still has work awaiting a decision. */
export function hasPendingReviewRows(rows: ReviewRow[]): boolean {
    return rows.some((row) => !row.resolved);
}

/**
 * Header copy for the card. N counts actions as a set union keyed on action id,
 * not rows — one create_items row with 5 items contributes 5.
 */
export function getReviewHeaderCopy(rows: ReviewRow[]): {
    text: string;
    tone: 'review' | 'resolved';
} {
    const counted = new Map<string, AgentAction>();
    for (const row of rows) {
        for (const action of row.actions) counted.set(action.id, action);
    }

    const actions = Array.from(counted.values());
    const noun = actions.length === 1 ? 'change' : 'changes';

    if (actions.some((action) => action.status === 'pending')) {
        const verb = actions.length === 1 ? 'needs' : 'need';
        return { text: `${actions.length} ${noun} ${verb} your review`, tone: 'review' };
    }

    const allApplied = actions.every((action) => action.status === 'applied');
    return { text: `${actions.length} ${noun} ${allApplied ? 'applied' : 'reviewed'}`, tone: 'resolved' };
}
