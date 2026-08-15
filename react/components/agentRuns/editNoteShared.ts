import { ToolCallPart } from '@beaver/agent-core/agents/types';
import type { ToolCallStatus } from '@beaver/agent-core/run-state/atoms';
import type { AgentAction } from '../../agents/agentActions';
import type { EditNoteResolvedTarget, PendingApproval } from '@beaver/agent-ui/host';
import { resolveObjectId } from '../../../src/utils/libraryIdentity';

export type EditNoteDisplayStatus =
    | 'awaiting'
    | 'pending'
    | 'applied'
    | 'rejected'
    | 'undone'
    | 'error';

export type EditNoteTarget =
    | { kind: 'known'; libraryId: number; zoteroKey: string }
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
    /**
     * Short human label for how this edit addresses the note, e.g.
     * `replace · block 5`. Set only for `edit_note_blocks` rows: the other two
     * variants address by matched text, which the diff itself already shows,
     * whereas a block number is invisible in the diff and is the whole point of
     * the call. See {@link describeBlockEdit}.
     */
    label?: string;
    /**
     * Present when this edit was skipped and never reached the note (blocks
     * only). The row renders the reason instead of a diff.
     *
     * Sourced from EXECUTE's `skipped` once the action has produced a result,
     * and from validation's `skip_reason_code` before that (including when
     * execute failed outright and stored none) — execute re-resolves every
     * edit, so it can refuse one validation accepted. See the `executedSkips`
     * note in {@link deriveEditNoteRows}.
     */
    skippedReason?: string;
    /**
     * Validation-supplied anchors for locating this edit's target region in the
     * note, so "jump to edit" lands on the right occurrence. Copied verbatim
     * from the persisted edit's `target_before_context` / `target_after_context`.
     */
    targetBeforeContext?: string;
    targetAfterContext?: string;
}

/** Which of the three note-edit call shapes a row/preview is looking at. */
export type EditNoteCallVariant = 'legacy' | 'batch' | 'blocks';

/**
 * Classify a note-edit call into its variant.
 *
 * `actionType` is authoritative whenever it is known (a stored action or a
 * pending approval). It is NOT known while the tool call is still streaming, and
 * that is the case this helper exists for: the previous inline test was
 * `Array.isArray(toolArgs.edits)` → batch, which classifies EVERY `edits[]` call
 * as batch and would therefore select the batch UI for a streaming
 * `edit_note_blocks` call.
 *
 * The streaming discriminant is the per-edit field name, which the two array
 * shapes do not share: a batch edit carries `operation`, a block edit carries
 * `op`. `op` is checked first because validation writes a display-only
 * `operation` onto persisted BLOCK edits as well (for the diff preview), so a
 * finalized-args block call has both.
 *
 * RENDER-LAYER PURE: no Zotero, no prefs, no atoms.
 */
export function getEditNoteCallVariant({
    toolArgs,
    actionType,
    actionData,
}: {
    toolArgs?: Record<string, any>;
    actionType?: string;
    actionData?: Record<string, any>;
}): EditNoteCallVariant {
    if (actionType === 'edit_note_blocks') return 'blocks';
    if (actionType === 'edit_note_batch') return 'batch';
    if (actionType === 'edit_note') return 'legacy';

    const edits: unknown = Array.isArray(actionData?.edits)
        ? actionData!.edits
        : (Array.isArray(toolArgs?.edits) ? toolArgs!.edits : null);
    // The PRESENCE of an `edits` array is what makes a call multi-edit, not its
    // length. An empty one must still classify as multi-edit: the previous
    // `Array.isArray(toolArgs?.edits)` test did, and callers map over `edits`,
    // so falling back to 'legacy' here makes a degenerate `{edits: []}` derive
    // one blank row from the (absent) flat fields instead of no rows at all.
    if (!Array.isArray(edits)) return 'legacy';
    if (edits.length === 0) return 'batch';

    const hasOp = edits.some((edit: any) => edit && typeof edit === 'object' && edit.op !== undefined);
    if (hasOp) return 'blocks';
    return 'batch';
}

/**
 * Human label for how one block edit addresses the note, e.g.
 * `replace · block 5`, `insert · after 12`, `delete · blocks 4-7`,
 * `rewrite · whole note`.
 *
 * Reads ONLY the persisted addressing fields, which is why it can live in the
 * render layer: nothing here consults the note, prefs, or the editor.
 *
 * `prepend` and `append` address no block, so they name the position in words
 * instead of quoting an address. An edit whose addressing field is missing or
 * malformed degrades to the bare op rather than inventing an address.
 */
export function describeBlockEdit(edit: Record<string, any> | null | undefined): string {
    const op = typeof edit?.op === 'string' ? edit.op : '';
    switch (op) {
        case 'rewrite':
            return 'rewrite · whole note';
        case 'replace': {
            const block = edit!.block;
            return typeof block === 'number' ? `replace · block ${block}` : 'replace';
        }
        case 'prepend':
            return 'insert · at start';
        case 'append':
            return 'insert · at end';
        case 'insert': {
            const after = edit!.after;
            return typeof after === 'number' ? `insert · after ${after}` : 'insert';
        }
        case 'delete': {
            const from = edit!.block;
            const to = edit!.to;
            if (typeof from !== 'number') return 'delete';
            return typeof to === 'number' && to > from
                ? `delete · blocks ${from}-${to}`
                : `delete · block ${from}`;
        }
        default:
            return op || 'edit';
    }
}

/**
 * Derive the row(s) a single edit_note / edit_note_batch / edit_note_blocks
 * tool-call part contributes to the group view. A v1 call always yields exactly
 * one row built from its flat fields. A batch or blocks call (classified by
 * {@link getEditNoteCallVariant}) yields one row per edit, in request order,
 * with `occurrencesReplaced` joined from `resultData.applied[]` by `index` —
 * absent for blocks, which has no such concept.
 *
 * `actionData` (the authoritative proposed_data from a stored action or
 * pending approval) takes precedence over `toolArgs` (streaming/finalized
 * tool-call args) wherever both are available.
 *
 * DECOUPLING BOUNDARY. This is render-layer code and consumes only the
 * SELF-CONTAINED persisted metadata — which is precisely why validation writes
 * `operation`/`old_string`/`new_string`/`skip_reason*`/`target_*_context` onto
 * each block edit. It must gain no Zotero import and no pref read; editor
 * interaction stays host-side.
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
    // Both multi-edit variants render one row per entry of `edits[]`; only the
    // legacy single-edit call uses the flat fields below. Block edits carry the
    // same display-only `operation`/`old_string`/`new_string` triple, written
    // onto them by validation for exactly this.
    const variant = getEditNoteCallVariant({ toolArgs, actionType, actionData });

    if (variant !== 'legacy') {
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

        const isBlocks = variant === 'blocks';

        /**
         * Execute-time skips, keyed by edit index — AUTHORITATIVE once present.
         *
         * Execute re-resolves every edit against the note as it stands, so an
         * edit validation accepted can still be refused: citation identity and
         * library exclusion are looked up again and either can change while the
         * edit waits for approval. Labelling a row from `skip_reason_code` after
         * the action has run would report a validation-time guess as what
         * happened to the user's note. (Execute can only ADD skips — a
         * validation skip is honored there, see `planBlockEditsExecution`.)
         *
         * `null` means no execution result to consult (pending or validate-only),
         * where the validation marker is the only signal there is. An empty map
         * means execute applied everything.
         */
        const executedSkips: Map<number, any> | null =
            isBlocks && Array.isArray(resultData?.skipped)
                ? new Map(
                    (resultData!.skipped as any[])
                        .filter((entry) => entry && typeof entry.index === 'number')
                        .map((entry) => [entry.index as number, entry]),
                )
                : null;

        const skipFieldsFor = (edit: any, editIndex: number): { skippedReason?: string } => {
            if (!isBlocks) return {};
            if (executedSkips) {
                const entry = executedSkips.get(editIndex);
                if (!entry) return {};
                return { skippedReason: entry.reason ?? String(entry.reason_code ?? 'not applied') };
            }
            return edit?.skip_reason_code
                ? { skippedReason: edit.skip_reason ?? String(edit.skip_reason_code) }
                : {};
        };

        return edits.map((edit, position) => {
            const editIndex = typeof edit?.index === 'number' ? edit.index : position;
            return {
                editIndex,
                // `operation` is written by validation, so a row whose validation
                // failed has none. `op: 'rewrite'` is a direct discriminant on the
                // raw tool args, so a failed rewrite still renders as one instead
                // of an ordinary str_replace.
                operation: edit?.operation ?? (edit?.op === 'rewrite' ? 'rewrite' : 'str_replace'),
                // The preview triple is written by VALIDATION, so a block edit
                // only has it once an action exists. Fall back to the raw tool
                // args (`expect` / `content`) so a card whose validation FAILED
                // still shows what the model meant. That is a settled state,
                // not just a streaming flicker: on `snapshot_mismatch` or
                // `no_applicable_edits` there is no action at all, and the
                // group auto-expands on error — so without this the user sees
                // an expanded "3 Note Edits" card whose every row is an empty
                // diff box, which reads as "nothing changes here".
                //
                // An insert's `expect` is excluded: it confirms the ANCHOR block,
                // which the insert leaves untouched, so feeding it to `oldString`
                // would render the anchor as deleted text.
                oldString: edit?.old_string
                    ?? (isBlocks && edit?.op !== 'insert' ? edit?.expect ?? '' : ''),
                newString: edit?.new_string ?? (isBlocks ? edit?.content ?? '' : ''),
                occurrencesReplaced: appliedByIndex.get(editIndex),
                ...(isBlocks ? { label: describeBlockEdit(edit) } : {}),
                // Skipped-ness is derived, never stored separately: from the
                // execute result once there is one, else from validation's
                // `skip_reason_code` (see `skipFieldsFor`). An edit skipped
                // without a wording still renders as skipped.
                ...skipFieldsFor(edit, editIndex),
                // Blocks only. Batch rows must keep producing NO anchor keys:
                // batch validation routinely writes `target_*_context` onto its
                // edits, so spreading them here unconditionally would change
                // every batch row's shape — and `useEditNoteActions` reads
                // `row.targetBeforeContext ?? fullEdit?.target_before_context`,
                // so the two paths diverge exactly where a row falls back to
                // positional lookup. Keeping this blocks-scoped preserves the
                // "batch untouched" invariant the rollback path rests on.
                ...(isBlocks && edit?.target_before_context !== undefined
                    ? { targetBeforeContext: edit.target_before_context }
                    : {}),
                ...(isBlocks && edit?.target_after_context !== undefined
                    ? { targetAfterContext: edit.target_after_context }
                    : {}),
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
            return { libraryId: ref.library_id, zoteroKey: ref.zotero_key };
        }
    }

    const libRaw = parsedArgs.library_id;
    const keyRaw = parsedArgs.zotero_key;
    const libraryId = typeof libRaw === 'number'
        ? libRaw
        : (typeof libRaw === 'string' ? parseInt(libRaw, 10) : NaN);
    if (Number.isFinite(libraryId) && typeof keyRaw === 'string' && keyRaw) {
        return { libraryId, zoteroKey: keyRaw };
    }

    return null;
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
            if (runParts.length === 0) {
                runParts = [part];
                runTarget = {
                    libraryId: target.libraryId,
                    zoteroKey: target.zoteroKey,
                };
            } else if (
                runTarget === null
                || (
                    runTarget.libraryId === target.libraryId
                    && runTarget.zoteroKey === target.zoteroKey
                )
            ) {
                runParts.push(part);
                runTarget = runTarget ?? {
                    libraryId: target.libraryId,
                    zoteroKey: target.zoteroKey,
                };
            } else {
                flushRun();
                runParts = [part];
                runTarget = {
                    libraryId: target.libraryId,
                    zoteroKey: target.zoteroKey,
                };
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
