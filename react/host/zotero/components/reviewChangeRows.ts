import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { getActionToolGroup } from '../../../atoms/runApprovalPolicy';

/** A tool call the changes card lists, with all of its actions. */
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
    /** Which half of the run's actions to build. Defaults to `'changes'`. */
    include?: RunActionRowSet;
}

/**
 * The two bottom-of-run surfaces an action can belong to, and never both.
 *
 * `'changes'` is the record of what the run did to the library; `'artifacts'`
 * is what it produced for the user to open. Splitting them at membership rather
 * than layering one over the other is what keeps a created note from being
 * reported twice.
 */
export type RunActionRowSet = 'changes' | 'artifacts';

/** These gate a run rather than propose a change, so they are never review material. */
const GATING_ACTION_TYPES = new Set<string>(['confirm_extraction', 'confirm_external_search']);

/** Citation imports have their own card. */
const CITATIONS_TOOLCALL_ID = 'citations';

/**
 * Types whose result is a thing the user opens rather than a change to record.
 *
 * Deliberately narrow: a note has content worth reading, so at the bottom of a
 * long answer it has to be reachable without scrolling back to the in-stream
 * card. A created collection or an edited item has nothing to open and stays an
 * ordinary change. Membership is by type and not by status, so undoing a note
 * leaves it where the user last saw it instead of moving it to the other card.
 */
const ARTIFACT_ACTION_TYPES = new Set<string>(['create_note']);

/** Whether this action belongs to the artifacts surface rather than the changes card. */
export function isArtifactAction(action: AgentAction): boolean {
    return ARTIFACT_ACTION_TYPES.has(changeTypeKey(action));
}

/** Where a row's note lives, for the surfaces that open it. */
export interface OpenNoteTarget {
    library_ref?: string;
    library_id?: number;
    zotero_key: string;
}

/**
 * The note a row opens, or null when the row has no note to open.
 *
 * A created note is opened rather than revealed: its content is the point of
 * the row, so the same glyph that shows an item in the library takes the user
 * into the note instead. Only an applied action has one — a proposal has no
 * note yet, and an undone one has had it deleted.
 */
export function getOpenNoteTarget(row: ReviewRow): OpenNoteTarget | null {
    if (row.actions.length !== 1) return null;
    const [action] = row.actions;
    if (changeTypeKey(action) !== 'create_note' || action.status !== 'applied') return null;

    const result = action.result_data as Record<string, any> | undefined;
    if (!result?.zotero_key) return null;
    return {
        library_ref: result.library_ref,
        library_id: result.library_id,
        zotero_key: result.zotero_key,
    };
}

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
 * Build one bottom-of-run surface's rows from the actions of one terminal run:
 * one row per tool call, the same unit the in-stream card renders. `include`
 * picks the surface; every other exclusion here applies to both.
 *
 * Every change the run proposed belongs here whatever became of it, so the card
 * is the run's durable record and a row does not vanish out from under the click
 * that resolved it. The only actions held back are the ones another surface
 * owns: a live approval, a citation import, and the types with no apply path.
 */
export function buildReviewRows(
    actions: AgentAction[],
    options: BuildReviewRowsOptions = {},
): ReviewRow[] {
    const { liveApprovalActionIds, include = 'changes' } = options;
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

        if (isArtifactAction(action) !== (include === 'artifacts')) continue;

        const toolcallId = action.toolcall_id;
        if (!toolcallId || toolcallId === CITATIONS_TOOLCALL_ID) continue;
        if (approvedToolcallIds.has(toolcallId)) continue;

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
    // Undecided rows first, so the card's row cap cuts into settled rows before
    // it reaches work the user still has to decide. This seeds the order the
    // card then freezes; it is not an invariant the card holds, since rows
    // resolved after it mounts keep the place they were given here. Stable
    // within each half, so rows keep their tool-call order.
    return [...rows.filter((row) => !row.resolved), ...rows.filter((row) => row.resolved)];
}

/** Whether the current card snapshot still has work awaiting a decision. */
export function hasPendingReviewRows(rows: ReviewRow[]): boolean {
    return rows.some((row) => !row.resolved);
}

function pluralNoun(count: number, noun: string): string {
    return count === 1 ? noun : `${noun}s`;
}

function plural(count: number, noun: string): string {
    return `${count} ${pluralNoun(count, noun)}`;
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
    switch (changeTypeKey(action)) {
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
    switch (changeTypeKey(action)) {
        case 'edit_metadata':
        case 'edit_note': {
            const library = data?.library_ref ?? data?.library_id;
            if (library == null || !data?.zotero_key) return null;
            return `${changeTypeKey(action)}:${library}:${data.zotero_key}`;
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
function changeTypeKey(action: AgentAction): string {
    // Widened: callers may hold either the stored type or the tool name it came
    // from, and two tool names differ from the type they store.
    const actionType: string = action.action_type;
    if (actionType === 'create_items') return 'create_item';
    if (actionType === 'edit_item') return 'edit_metadata';
    // One kind of change for the heading: both tools edit a note.
    if (actionType === 'edit_note_batch') return 'edit_note';
    if (actionType === 'edit_annotations' && (action.proposed_data as any)?.operation === 'delete') {
        return 'delete_annotations';
    }
    return actionType;
}

/** Past-tense label for a single kind of change. */
const CHANGE_KINDS: Record<string, { verb: string; noun: string }> = {
    create_item: { verb: 'imported', noun: 'item' },
    create_note: { verb: 'created', noun: 'note' },
    create_collection: { verb: 'created', noun: 'collection' },
    edit_metadata: { verb: 'edited', noun: 'item' },
    edit_note: { verb: 'edited', noun: 'note' },
    organize_items: { verb: 'organized', noun: 'item' },
    manage_tags: { verb: 'updated', noun: 'tag' },
    manage_collections: { verb: 'updated', noun: 'collection' },
    create_highlight_annotations: { verb: 'created', noun: 'highlight' },
    create_note_annotations: { verb: 'created', noun: 'sticky note' },
    edit_annotations: { verb: 'edited', noun: 'annotation' },
    delete_annotations: { verb: 'deleted', noun: 'annotation' },
};

/** Compact trail for a single kind: "10 edited items". */
function changeTrailLabel(typeKey: string, count: number): string | null {
    const kind = CHANGE_KINDS[typeKey];
    if (!kind) return null;
    return `${count} ${kind.verb} ${pluralNoun(count, kind.noun)}`;
}

function uniqueActionsFromRows(rows: ReviewRow[]): AgentAction[] {
    const counted = new Map<string, AgentAction>();
    for (const row of rows) {
        for (const action of row.actions) counted.set(action.id, action);
    }
    return Array.from(counted.values());
}

/**
 * How many library things a set of actions covers. A batch tool carries all of
 * its targets inside one action, and an action that names the thing it changed
 * is deduplicated, so a note edited twice in one run is one edited note.
 */
function countUnits(actions: AgentAction[]): number {
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
 * `error_details.outcome` when the backend closed an action out without an
 * answer from Zotero: the change was sent and the plugin stopped responding
 * before it reported what happened.
 */
const UNCONFIRMED_OUTCOME = 'unconfirmed';

/**
 * True when an errored action's effect on the library is unknown, rather than
 * known to have failed or known to have landed.
 *
 * Only the backend can tell these apart — it knows whether the plugin ever
 * received the request — so it says so explicitly instead of leaving the
 * client to read it out of `result_data`, which is absent both for a change
 * that never ran and for one whose outcome never came back.
 */
export function isUnconfirmedAction(action: AgentAction): boolean {
    return action.status === 'error' && action.error_details?.outcome === UNCONFIRMED_OUTCOME;
}

/** The card's heading names the surface; its trail carries all of the state. */
const CHANGES_CARD_LEAD = 'Library changes';

/** Trail clauses beyond this read as a list rather than a summary. */
const MAX_TRAIL_CLAUSES = 2;

/**
 * Heading for the changes card: a fixed lead and a trail of what the run's
 * changes currently are ("3 failed, 2 pending").
 *
 * The trail is ordered by what the user most needs to see and capped, so an
 * unfinished decision is never crowded out by a count of settled changes. A run
 * that applied cleanly has nothing to flag, so its trail names the changes
 * ("10 edited items") instead of counting them.
 */
export function getChangesCardHeading(rows: ReviewRow[]): { lead: string; trail?: string } {
    const actions = uniqueActionsFromRows(rows);
    const applied = actions.filter((action) => action.status === 'applied');

    // `error` splits three ways, because the card states what the library now
    // holds and the three cases disagree about that. An action the backend
    // marked unconfirmed reached Zotero but never reported back, so whether it
    // landed is unknown (see `isUnconfirmedAction`) — it leads the trail
    // because it is the only state that asks the user to go and look. Of the
    // rest, one without a result never landed, so the change is not in the
    // library; one with a result is in it, either because an undo failed or
    // because an apply succeeded and only its acknowledgement failed (see
    // `hasFailedUndo`). The copy must not name the failed operation, since the
    // record cannot tell those two apart — only that the change is applied and
    // something went wrong. Reporting them under one word would misstate what
    // the library holds, and none is counted among the clean applies.
    const errored = actions.filter((action) => action.status === 'error');
    const settledErrors = errored.filter((action) => !isUnconfirmedAction(action));
    const groups = [
        {
            key: 'unconfirmed',
            actions: errored.filter(isUnconfirmedAction),
            label: (count: number) => `${count} unconfirmed`,
        },
        {
            key: 'failed',
            actions: settledErrors.filter((action) => action.result_data == null),
            label: (count: number) => `${count} failed`,
        },
        {
            key: 'applied-with-errors',
            actions: settledErrors.filter((action) => action.result_data != null),
            label: (count: number) => `${count} applied with errors`,
        },
        {
            key: 'pending',
            actions: actions.filter((action) => action.status === 'pending'),
            label: (count: number) => `${count} pending`,
        },
        { key: 'applied', actions: applied, label: (count: number) => `${count} applied` },
        {
            key: 'undone',
            actions: actions.filter((action) => action.status === 'undone'),
            label: (count: number) => `${count} undone`,
        },
        {
            key: 'rejected',
            actions: actions.filter((action) => action.status === 'rejected'),
            label: (count: number) => `${count} rejected`,
        },
    ];

    const present = groups
        // A tool whose apply reports having changed nothing still changed one
        // thing as far as this card is concerned — the tool call itself. Without
        // the fallback such a group drops out of the trail entirely, and a
        // pending one would leave the card's apply/reject buttons above a
        // heading that never mentions anything to decide.
        .map((group) => ({
            key: group.key,
            units: countUnits(group.actions) || group.actions.length,
            label: group.label,
        }))
        .filter((group) => group.units > 0);

    if (present.length === 1 && present[0].key === 'applied') {
        const typeKeys = new Set(applied.map(changeTypeKey));
        const label = typeKeys.size === 1
            ? changeTrailLabel([...typeKeys][0], present[0].units)
            : null;
        return { lead: CHANGES_CARD_LEAD, trail: label ?? plural(present[0].units, 'change') };
    }

    const trail = present
        .slice(0, MAX_TRAIL_CLAUSES)
        .map((group) => group.label(group.units))
        .join(', ');
    return { lead: CHANGES_CARD_LEAD, trail: trail || undefined };
}
