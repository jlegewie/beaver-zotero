import { ToolCallPart } from '@beaver/agent-core/agents/types';
import type { ToolCallStatus } from '@beaver/agent-core/run-state/atoms';
import type { AgentAction } from '../../agents/agentActions';
import type { EditNoteResolvedTarget, PendingApproval } from '@beaver/agent-ui/host';
import { parseLibraryRef, resolveLibraryRef, resolveObjectId, UNRESOLVED_LIBRARY_ID } from '../../../src/utils/libraryIdentity';

export type EditNoteDisplayStatus =
    | 'awaiting'
    | 'pending'
    | 'applied'
    | 'rejected'
    | 'undone'
    | 'error';

export type EditNoteTarget =
    // Reuses `EditNoteResolvedTarget` rather than restating its fields, so a
    // field added there (e.g. the portable `libraryRef`) cannot be silently
    // dropped on the way through the grouping pass.
    | ({ kind: 'known' } & EditNoteResolvedTarget)
    | { kind: 'pending' }
    | null;

export type EditNoteRenderItem =
    | { kind: 'single'; part: ToolCallPart }
    | {
        kind: 'edit-note-group';
        parts: ToolCallPart[];
        target: EditNoteResolvedTarget | null;
    };

/**
 * One renderable row of an edit_note run: either the whole part (a v1
 * single-edit call, `editIndex: null`) or one edit within an edit_note_batch
 * action's ordered `edits[]` (`editIndex` is that edit's position).
 */
export interface EditNoteRowDescriptor {
    editIndex: number | null;
    operation: string;
    oldString: string;
    newString: string;
    occurrencesReplaced?: number;
}

/**
 * Derive the row(s) a single edit_note / edit_note_batch tool-call part
 * contributes to the group view. A v1 call always yields exactly one row
 * built from its flat fields. A batch call (recognized by `action_type ===
 * 'edit_note_batch'`, or — while still streaming and no action/pendingApproval
 * exists yet — by the tool args carrying an `edits` array) yields one row per
 * edit, in request order, with `occurrencesReplaced` joined from
 * `resultData.applied[]` by `index`.
 *
 * `actionData` (the authoritative proposed_data from a stored action or
 * pending approval) takes precedence over `toolArgs` (streaming/finalized
 * tool-call args) wherever both are available.
 */
export function deriveEditNoteRows({
    toolArgs,
    actionType,
    actionData,
    resultData,
}: {
    toolArgs?: Record<string, any>;
    actionType?: string;
    actionData?: Record<string, any>;
    resultData?: Record<string, any>;
}): EditNoteRowDescriptor[] {
    const isBatch = actionType === 'edit_note_batch'
        || (actionType == null && Array.isArray(toolArgs?.edits));

    if (isBatch) {
        const edits: any[] = Array.isArray(actionData?.edits)
            ? actionData!.edits
            : (Array.isArray(toolArgs?.edits) ? toolArgs!.edits : []);

        const appliedByIndex = new Map<number, number>();
        const applied = resultData?.applied;
        if (Array.isArray(applied)) {
            for (const entry of applied) {
                if (entry && typeof entry.index === 'number') {
                    appliedByIndex.set(entry.index, entry.occurrences_replaced);
                }
            }
        }

        return edits.map((edit, position) => {
            const editIndex = typeof edit?.index === 'number' ? edit.index : position;
            return {
                editIndex,
                operation: edit?.operation ?? 'str_replace',
                oldString: edit?.old_string ?? '',
                newString: edit?.new_string ?? '',
                occurrencesReplaced: appliedByIndex.get(editIndex),
            };
        });
    }

    return [{
        editIndex: null,
        operation: actionData?.operation ?? toolArgs?.operation ?? 'str_replace',
        oldString: actionData?.old_string ?? toolArgs?.old_string ?? '',
        newString: actionData?.new_string ?? toolArgs?.new_string ?? '',
        occurrencesReplaced: resultData?.occurrences_replaced,
    }];
}

export function getEditNoteGroupInstanceId(parts: ToolCallPart[]): string {
    return parts[0]?.tool_call_id ?? 'unknown';
}

export function getEditNoteGroupExpansionKey(
    runId: string,
    responseIndex: number,
    parts: ToolCallPart[],
): string {
    return `${runId}:${responseIndex}:group:${getEditNoteGroupInstanceId(parts)}`;
}

/**
 * Best-effort parse of a tool-call `args` payload into an object.
 */
export function parseEditNoteToolCallArgs(
    args: ToolCallPart['args'] | Record<string, any> | null | undefined,
): Record<string, any> | null {
    if (args == null) return null;
    if (typeof args !== 'string') {
        return typeof args === 'object' && !Array.isArray(args) ? args as Record<string, any> : null;
    }
    if (!args) return null;
    try {
        const parsed = JSON.parse(args);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, any>
            : null;
    } catch {
        return null;
    }
}

/**
 * Resolve an edit_note target from note_id or library_id/zotero_key.
 */
export function resolveEditNoteTargetFromData(
    args: ToolCallPart['args'] | Record<string, any> | null | undefined,
): EditNoteResolvedTarget | null {
    const parsedArgs = parseEditNoteToolCallArgs(args);
    if (!parsedArgs) return null;

    const noteId = parsedArgs.note_id;
    if (typeof noteId === 'string' && noteId) {
        const ref = resolveObjectId(noteId);
        if (ref) {
            return {
                libraryId: ref.library_id,
                zoteroKey: ref.zotero_key,
                ...(ref.library_ref ? { libraryRef: ref.library_ref } : {}),
            };
        }
    }

    const keyRaw = parsedArgs.zotero_key;
    if (typeof keyRaw !== 'string' || !keyRaw) return null;

    // The portable `library_ref` is the identity and wins; the numeric
    // `library_id` may be absent or the unresolved sentinel, so it cannot be
    // read on its own.
    //
    // A library this device doesn't have still yields a target, carrying
    // `UNRESOLVED_LIBRARY_ID` — the same shape the `note_id` branch above
    // produces for `g<groupID>-KEY`. The target is an identity, and dropping it
    // would fold this note's edits into the neighbouring note's group
    // (`buildEditNoteRenderItems` treats a missing target as "still streaming").
    // Callers gate their Zotero lookups on `isOpenableEditNoteTarget` instead.
    const libRaw = parsedArgs.library_id;
    const numericLibraryId = typeof libRaw === 'number'
        ? libRaw
        : (typeof libRaw === 'string' ? parseInt(libRaw, 10) : NaN);
    const libraryId = resolveLibraryRef({
        library_ref: parsedArgs.library_ref,
        library_id: Number.isFinite(numericLibraryId) ? numericLibraryId : null,
    });
    const libraryRef = typeof parsedArgs.library_ref === 'string' && parseLibraryRef(parsedArgs.library_ref)
        ? parsedArgs.library_ref
        : undefined;
    if (libraryId && libraryId > 0) {
        return { libraryId, zoteroKey: keyRaw, ...(libraryRef ? { libraryRef } : {}) };
    }
    if (libraryRef) {
        return { libraryId: UNRESOLVED_LIBRARY_ID, zoteroKey: keyRaw, libraryRef };
    }
    return null;
}

/**
 * Whether two resolved targets name the same note.
 *
 * A rowid identifies a library only when the library is on this device. When
 * either side is unresolved its rowid is the `UNRESOLVED_LIBRARY_ID` sentinel,
 * which every unavailable library shares — and Zotero keys are unique only
 * within a library, so comparing the sentinel would merge two genuinely
 * different notes. The portable ref is the only thing that separates them.
 */
export function sameEditNoteTarget(
    a: EditNoteResolvedTarget,
    b: EditNoteResolvedTarget,
): boolean {
    if (a.zoteroKey !== b.zoteroKey) return false;
    if (a.libraryId > 0 && b.libraryId > 0) return a.libraryId === b.libraryId;
    return a.libraryRef === b.libraryRef;
}

/**
 * Whether a resolved target names a note this device can actually open.
 *
 * A target may carry `UNRESOLVED_LIBRARY_ID`: it identifies the note, but its
 * library is not on this computer, so every `Zotero.Items` lookup keyed on it
 * silently misses. Gate open/preview affordances on this rather than on the
 * target's mere presence, or the UI offers buttons that do nothing.
 */
export function isOpenableEditNoteTarget(
    target: EditNoteResolvedTarget | null | undefined,
): target is EditNoteResolvedTarget {
    return target != null && target.libraryId > 0;
}

export function findPendingApprovalForToolcall(
    toolcallId: string,
    pendingApprovals: Iterable<PendingApproval>,
): PendingApproval | null {
    for (const pending of pendingApprovals) {
        if (pending.toolcallId === toolcallId) {
            return pending;
        }
    }
    return null;
}

export function getEffectiveEditNotePendingApproval(
    action: Pick<AgentAction, 'status'> | null | undefined,
    pendingApproval: PendingApproval | null | undefined,
): PendingApproval | null {
    const actionInFinalState = action && action.status !== 'pending';
    return actionInFinalState ? null : (pendingApproval ?? null);
}

export function getEditNoteDisplayStatus({
    action,
    pendingApproval,
    toolCallStatus,
}: {
    action: Pick<AgentAction, 'status'> | null | undefined;
    pendingApproval: PendingApproval | null | undefined;
    toolCallStatus: ToolCallStatus;
}): EditNoteDisplayStatus {
    if (pendingApproval) return 'awaiting';
    if (action) return action.status;
    if (toolCallStatus === 'error') return 'error';
    return 'pending';
}

export function isEditNoteStreamingPlaceholder({
    action,
    pendingApproval,
    toolCallStatus,
}: {
    action: Pick<AgentAction, 'status'> | null | undefined;
    pendingApproval: PendingApproval | null | undefined;
    toolCallStatus: ToolCallStatus;
}): boolean {
    return !action && !pendingApproval && toolCallStatus === 'in_progress';
}

export function isEditNoteOrphaned({
    action,
    pendingApproval,
    toolCallStatus,
}: {
    action: Pick<AgentAction, 'status'> | null | undefined;
    pendingApproval: PendingApproval | null | undefined;
    toolCallStatus: ToolCallStatus;
}): boolean {
    return !action && !pendingApproval && toolCallStatus === 'error';
}

export function getOverallEditNoteDisplayStatus(
    statuses: EditNoteDisplayStatus[],
): EditNoteDisplayStatus {
    if (statuses.length === 0) return 'pending';
    if (statuses.includes('awaiting')) return 'awaiting';
    if (statuses.includes('pending')) return 'pending';
    if (statuses.includes('applied')) return 'applied';
    if (statuses.includes('error')) return 'error';
    if (statuses.every((status) => status === 'rejected' || status === 'undone')) {
        return 'rejected';
    }
    return 'pending';
}

/**
 * Inspect a tool-call part and decide how it participates in an edit_note run.
 */
export function getEditNoteTarget(part: ToolCallPart): EditNoteTarget {
    if (part.tool_name !== 'edit_note') return null;

    // Prefer streaming_args while the tool call is still arriving incrementally.
    // Once args is finalized it should agree, and remains the fallback.
    const target = resolveEditNoteTargetFromData(part.streaming_args)
        ?? resolveEditNoteTargetFromData(part.args);
    if (target) {
        return { kind: 'known', ...target };
    }

    return { kind: 'pending' };
}

/**
 * Fold consecutive edit_note parts into a single container item. Unlike the
 * original branch logic, single edit_note calls are grouped too so all note
 * edits render through EditNoteGroupView.
 */
export function buildEditNoteRenderItems(parts: ToolCallPart[]): EditNoteRenderItem[] {
    const items: EditNoteRenderItem[] = [];
    let runParts: ToolCallPart[] = [];
    let runTarget: EditNoteResolvedTarget | null = null;

    const flushRun = () => {
        if (runParts.length === 0) return;
        items.push({
            kind: 'edit-note-group',
            parts: runParts,
            target: runTarget,
        });
        runParts = [];
        runTarget = null;
    };

    for (const part of parts) {
        const target = getEditNoteTarget(part);
        if (target?.kind === 'known') {
            // Strip the discriminant; the portable ref must survive, or two
            // unavailable libraries become indistinguishable further down.
            const resolved: EditNoteResolvedTarget = {
                libraryId: target.libraryId,
                zoteroKey: target.zoteroKey,
                ...(target.libraryRef ? { libraryRef: target.libraryRef } : {}),
            };
            if (runParts.length === 0) {
                runParts = [part];
                runTarget = resolved;
            } else if (runTarget === null || sameEditNoteTarget(runTarget, resolved)) {
                runParts.push(part);
                runTarget = runTarget ?? resolved;
            } else {
                flushRun();
                runParts = [part];
                runTarget = resolved;
            }
        } else if (target?.kind === 'pending') {
            runParts.push(part);
        } else {
            flushRun();
            items.push({ kind: 'single', part });
        }
    }

    flushRun();
    return items;
}
