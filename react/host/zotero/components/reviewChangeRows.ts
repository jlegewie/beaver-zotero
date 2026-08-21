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

/**
 * Which changes a card is built from: the ones still awaiting a decision, or
 * the ones already written to Zotero in this session.
 */
export type ReviewRowMode = 'pending' | 'completed';

export interface BuildReviewRowsOptions {
    /** Defaults to `'pending'`. */
    mode?: ReviewRowMode;
    /** Action ids with a live approval (pendingApprovalsAtom) — those belong to the in-stream card. */
    liveApprovalActionIds?: ReadonlySet<string>;
    /** Actions resolved from this card that stay in its current session snapshot. */
    retainedActionIds?: ReadonlySet<string>;
    /**
     * Action ids a live run wrote in this session (`sessionAppliedActionIdsAtom`).
     * The only source for `'completed'` mode, which ignores the action status: an
     * action stays in the completed card once undone or re-applied, so the row
     * does not vanish out from under the click that changed it.
     */
    appliedActionIds?: ReadonlySet<string>;
}

/** These gate a run rather than propose a change, so they are never review material. */
const GATING_ACTION_TYPES = new Set<string>(['confirm_extraction', 'confirm_external_search']);

/** Citation imports have their own card. */
const CITATIONS_TOOLCALL_ID = 'citations';

/**
 * Types the shared executor has no apply path for: inline notes apply through
 * their own surface, and the per-annotation types are legacy. A row here would
 * offer a dead ✓.
 */
const UNAPPLIABLE_ACTION_TYPES = new Set<string>([
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
 * Build a change card's rows from the actions of one terminal run: one row per
 * tool call, the same unit the in-stream card renders.
 *
 * `'pending'` mode feeds the review card, `'completed'` mode the card of changes
 * the run itself wrote. The two are disjoint by construction: a completed row is
 * only offered once the review card has let go of it (`retainedActionIds`), and
 * the completed set holds no action the review card could have owned, since a
 * run's own write is never pending.
 */
export function buildReviewRows(
    actions: AgentAction[],
    options: BuildReviewRowsOptions = {},
): ReviewRow[] {
    const { mode = 'pending', liveApprovalActionIds, retainedActionIds, appliedActionIds } = options;
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

        if (mode === 'completed') {
            if (!appliedActionIds?.has(action.id)) continue;
            // Still part of the review card's resolved snapshot; it moves over
            // when that card clears its retention.
            if (retainedActionIds?.has(action.id)) continue;
        } else {
            // Start with pending actions. Once the user resolves actions from this
            // card, retain them so the rows do not shift while other changes
            // are still pending and the resolved status remains visible.
            if (action.status !== 'pending' && !retainedActionIds?.has(action.id)) continue;
        }

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

function plural(count: number, noun: string, pluralNoun?: string): string {
    return `${count} ${count === 1 ? noun : pluralNoun ?? `${noun}s`}`;
}

function countAnnotationTargets(data: any): number {
    return data?.annotation_refs?.length ?? data?.annotation_ids?.length ?? 0;
}

/**
 * Annotations an edit_annotations action targets. A delete carries a flat list;
 * an edit carries them inside its per-group `edits` entries. Both an approved
 * action (`annotation_refs`) and streaming tool arguments (`annotation_ids`) are
 * counted.
 */
export function countEditAnnotationTargets(actionData?: Record<string, any>): number {
    const flat = countAnnotationTargets(actionData);
    if (flat) return flat;
    return (actionData?.edits ?? []).reduce(
        (sum: number, group: any) => sum + countAnnotationTargets(group),
        0,
    );
}

/**
 * How many things one completed action changed. Most tools store one action per
 * change, but the batch tools carry all of their targets inside a single action,
 * and what an apply reports having done is preferred over what it proposed —
 * a partial failure changed fewer things than it set out to.
 */
function countChangedUnits(action: AgentAction): number {
    const data = action.proposed_data as Record<string, any> | undefined;
    switch (completedTypeKey(action)) {
        case 'organize_items':
            return action.result_data?.items_modified ?? data?.item_ids?.length ?? 0;
        case 'create_highlight_annotations':
        case 'create_note_annotations':
            return action.result_data?.created?.length ?? data?.items?.length ?? 0;
        case 'edit_annotations':
        case 'delete_annotations':
            return action.result_data?.applied_refs?.length ?? countEditAnnotationTargets(data);
        default:
            // Reached by edit_note_batch as `edit_note`: its many edits all land
            // in one note, so the batch is one changed note.
            return 1;
    }
}

/**
 * The thing an action changed, when changing it twice in one run must not count
 * twice: two edits to one note are one edited note. Null for the tools whose
 * unit is a count rather than an identity.
 */
function changedUnitKey(action: AgentAction): string | null {
    const data = action.proposed_data as Record<string, any> | undefined;
    switch (completedTypeKey(action)) {
        case 'edit_metadata':
        case 'edit_note': {
            const library = data?.library_ref ?? data?.library_id;
            if (library == null || !data?.zotero_key) return null;
            return `${completedTypeKey(action)}:${library}:${data.zotero_key}`;
        }
        default:
            return null;
    }
}

/**
 * The action type for header purposes. Aliases collapse onto the type actually
 * stored, and an annotation deletion splits back out of the edit type it shares,
 * so the header can say "Deleted" rather than "Edited".
 */
function completedTypeKey(action: AgentAction): string {
    // Widened: callers may hold either the stored type or the tool name it came
    // from, and two tool names differ from the type they store.
    const actionType: string = action.action_type;
    if (actionType === 'create_items') return 'create_item';
    if (actionType === 'edit_item') return 'edit_metadata';
    // One kind of change for the header: both tools edit a note, and
    // completedPhrase gives them the same phrase.
    if (actionType === 'edit_note_batch') return 'edit_note';
    if (actionType === 'edit_annotations' && (action.proposed_data as any)?.operation === 'delete') {
        return 'delete_annotations';
    }
    return actionType;
}

/** Type-specific header for a card whose changes are all of one kind. */
function completedPhrase(typeKey: string, count: number): string | null {
    switch (typeKey) {
        case 'create_item':
            return `Imported ${plural(count, 'item')}`;
        case 'create_note':
            return `Created ${plural(count, 'note')}`;
        case 'create_collection':
            return `Created ${plural(count, 'collection')}`;
        case 'edit_metadata':
            return `Edited ${plural(count, 'item')}`;
        case 'edit_note':
            return `Edited ${plural(count, 'note')}`;
        case 'organize_items':
            return `Organized ${plural(count, 'item')}`;
        case 'manage_tags':
            return `Updated ${plural(count, 'tag')}`;
        case 'manage_collections':
            return `Updated ${plural(count, 'collection')}`;
        case 'create_highlight_annotations':
            return `Created ${plural(count, 'highlight')}`;
        case 'create_note_annotations':
            return `Created ${plural(count, 'sticky note')}`;
        case 'edit_annotations':
            return `Edited ${plural(count, 'annotation')}`;
        case 'delete_annotations':
            return `Deleted ${plural(count, 'annotation')}`;
        default:
            return null;
    }
}

function uniqueActionsFromRows(rows: ReviewRow[]): AgentAction[] {
    const counted = new Map<string, AgentAction>();
    for (const row of rows) {
        for (const action of row.actions) counted.set(action.id, action);
    }
    return Array.from(counted.values());
}

function isChangeInEffect(action: AgentAction): boolean {
    return action.status === 'applied'
        || (action.status === 'error' && action.result_data != null);
}

/**
 * How many library things the in-effect actions changed. Deduplicates where an
 * action names the thing it changed, so a note edited twice in one run is one
 * edited note.
 */
function countInEffectUnits(actions: AgentAction[]): number {
    const seenUnits = new Set<string>();
    let units = 0;
    for (const action of actions) {
        const unitKey = changedUnitKey(action);
        if (unitKey === null) {
            units += countChangedUnits(action);
        } else if (!seenUnits.has(unitKey)) {
            seenUnits.add(unitKey);
            units += 1;
        }
    }
    return units;
}

/**
 * How many library things the completed-changes card would summarize.
 *
 * Same counting as `getCompletedHeaderCopy`: a batch tool's targets, not its
 * actions, and only changes still in effect. All-reverted cards count the
 * original actions, matching "Reverted N library changes".
 */
export function countCompletedChangedUnits(rows: ReviewRow[]): number {
    const actions = uniqueActionsFromRows(rows);
    const inEffect = actions.filter(isChangeInEffect);
    if (inEffect.length === 0) return actions.length;

    const typeKeys = new Set(inEffect.map(completedTypeKey));
    if (typeKeys.size === 1) return countInEffectUnits(inEffect);
    return inEffect.length;
}

/**
 * Whether to mount the completed-changes card.
 *
 * A single changed unit is already the in-stream action card, so the summary
 * stays hidden — except a created note, which this card replaced a dedicated
 * bottom-of-run display for, including the single-note case.
 */
export function shouldShowCompletedCard(rows: ReviewRow[]): boolean {
    if (countCompletedChangedUnits(rows) > 1) return true;
    return uniqueActionsFromRows(rows).some(
        (action) => completedTypeKey(action) === 'create_note' && isChangeInEffect(action),
    );
}

/**
 * Header copy for the completed-changes card.
 *
 * A card whose changes are all of one kind names them ("Created 4 notes");
 * anything mixed falls back to a count of changes, because stacking clauses for
 * every kind present produces a header too long to read at a glance.
 *
 * Only the changes still in effect are described, since a row stays in the card
 * after the user undoes it: a header naming a note that no longer exists would
 * contradict the row right below it. An errored row counts only when it still
 * carries its result — that is a failed undo, which left the change in the
 * library, as opposed to a failed re-apply, which never made one.
 */
export function getCompletedHeaderCopy(rows: ReviewRow[]): string {
    const actions = uniqueActionsFromRows(rows);
    const inEffect = actions.filter(isChangeInEffect);

    if (inEffect.length === 0) {
        return `Reverted ${plural(actions.length, 'library change')}`;
    }

    const typeKeys = new Set(inEffect.map(completedTypeKey));
    if (typeKeys.size === 1) {
        const [typeKey] = typeKeys;
        const units = countInEffectUnits(inEffect);
        const phrase = units > 0 ? completedPhrase(typeKey, units) : null;
        if (phrase) return phrase;
    }

    return `Completed ${plural(inEffect.length, 'library change')}`;
}
