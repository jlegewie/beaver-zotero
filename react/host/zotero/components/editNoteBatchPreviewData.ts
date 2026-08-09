import type { EditNoteRowDescriptor } from '../../../components/agentRuns/editNoteShared';
import type { PreviewData } from './agentActionViewHelpers';

export type EditNotePreviewKind = 'legacy' | 'batch' | 'blocks' | null;

/**
 * Which note-edit preview to render.
 *
 * All three variants share the model-facing tool name `edit_note`, so the
 * action type is what actually discriminates them and the checks are ordered
 * MOST SPECIFIC FIRST: a caller that passes `edit_note_batch` as the tool name
 * for a multi-edit row (EditNoteRowView) must still get `blocks` when the
 * action type says blocks.
 */
export function getEditNotePreviewKind(
    toolName: string,
    actionType: string,
): EditNotePreviewKind {
    if (toolName === 'edit_note_blocks' || actionType === 'edit_note_blocks') return 'blocks';
    if (toolName === 'edit_note_batch' || actionType === 'edit_note_batch') return 'batch';
    if (toolName === 'edit_note' || actionType === 'edit_note') return 'legacy';
    return null;
}

/**
 * Index an edit_note_batch action's undo records by their edit index. Built
 * once per action so a group with N rows resolves each row's record in O(1)
 * instead of scanning the whole undo array once per row (O(N²) overall).
 */
export function buildUndoByIndex(
    resultData: Record<string, any> | null | undefined,
): Map<number, any> {
    const map = new Map<number, any>();
    const undo = resultData?.undo;
    if (Array.isArray(undo)) {
        for (const record of undo) {
            if (record && typeof record.index === 'number') {
                map.set(record.index, record);
            }
        }
    }
    return map;
}

/**
 * Locate the persisted edit a row was derived from, by its `index`, with a
 * positional fallback for payloads whose edits carry no index (streaming args).
 */
function findSourceEdit(
    actionData: Record<string, any>,
    editIndex: number | null,
): Record<string, any> | undefined {
    if (editIndex == null || !Array.isArray(actionData.edits)) return undefined;
    return actionData.edits.find((edit: any) => edit?.index === editIndex)
        ?? actionData.edits[editIndex];
}

/**
 * Scope a multi-edit note action's preview metadata to one rendered edit row
 * without discarding the snapshots needed after the action has been applied.
 * The caller passes a prebuilt undo index (see buildUndoByIndex) so this stays
 * O(1) per row.
 *
 * Serves `edit_note_batch` and `edit_note_blocks` alike (the name predates
 * blocks). The variant is preserved on the scoped copy so the preview
 * dispatcher still picks the right branch after slicing.
 *
 * A batch row's edit is REBUILT from the row descriptor — the descriptor holds
 * everything the batch preview reads. A block row's edit is instead passed
 * through VERBATIM: its preview also reads the addressing fields (`op`,
 * `block`/`after`/`from_block`/`to_block`) and the skip reason, none of which
 * survive a rebuild, and copying them field by field would just be a second
 * place to forget one.
 */
export function buildBatchRowPreviewData(
    basePreviewData: PreviewData | null,
    row: EditNoteRowDescriptor,
    undoByIndex?: Map<number, any>,
): PreviewData {
    const baseActionData = basePreviewData?.actionData ?? {};
    const baseResultData = basePreviewData?.resultData;
    const isBlocks = basePreviewData?.actionType === 'edit_note_blocks';
    const matchingUndo = row.editIndex != null
        ? undoByIndex?.get(row.editIndex)
        : undefined;

    const scopedResultData: Record<string, any> = {};
    if (row.occurrencesReplaced != null) {
        scopedResultData.applied = [{
            index: row.editIndex,
            occurrences_replaced: row.occurrencesReplaced,
        }];
    }
    if (matchingUndo) {
        scopedResultData.undo = [matchingUndo];
    }
    if (baseResultData?.warnings !== undefined) {
        scopedResultData.warnings = baseResultData.warnings;
    }

    const sourceEdit = isBlocks ? findSourceEdit(baseActionData, row.editIndex) : undefined;

    return {
        actionType: isBlocks ? 'edit_note_blocks' : 'edit_note_batch',
        actionData: {
            library_id: baseActionData.library_id,
            zotero_key: baseActionData.zotero_key,
            library_ref: baseActionData.library_ref,
            edits: [sourceEdit ?? {
                index: row.editIndex,
                operation: row.operation,
                old_string: row.oldString,
                new_string: row.newString,
            }],
        },
        currentValue: basePreviewData?.currentValue,
        resultData: Object.keys(scopedResultData).length > 0
            ? scopedResultData
            : undefined,
        errorMessage: basePreviewData?.errorMessage,
    };
}

/** Return the original body snapshot for a rewrite row, if one was persisted. */
export function getBatchRewriteOldContent(
    previewData: PreviewData,
    editIndex: number,
): string | undefined {
    const validationSnapshot = previewData.currentValue?.old_content;
    if (typeof validationSnapshot === 'string') {
        return validationSnapshot;
    }

    if (!Array.isArray(previewData.resultData?.undo)) {
        return undefined;
    }
    const matchingUndo = previewData.resultData.undo.find(
        (record: any) => record?.index === editIndex,
    );
    return typeof matchingUndo?.undo_old_html === 'string'
        ? matchingUndo.undo_old_html
        : undefined;
}
