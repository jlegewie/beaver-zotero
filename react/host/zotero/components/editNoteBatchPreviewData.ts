import type { EditNoteRowDescriptor } from '../../../components/agentRuns/editNoteShared';
import type { PreviewData } from './agentActionViewHelpers';

export type EditNotePreviewKind = 'legacy' | 'batch' | null;

/** Batch wins when the model-facing tool name is the legacy `edit_note`. */
export function getEditNotePreviewKind(
    toolName: string,
    actionType: string,
): EditNotePreviewKind {
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
 * Scope a batch action's preview metadata to one rendered edit row without
 * discarding the snapshots needed after the action has been applied. The
 * caller passes a prebuilt undo index (see buildUndoByIndex) so this stays
 * O(1) per row.
 */
export function buildBatchRowPreviewData(
    basePreviewData: PreviewData | null,
    row: EditNoteRowDescriptor,
    undoByIndex?: Map<number, any>,
): PreviewData {
    const baseActionData = basePreviewData?.actionData ?? {};
    const baseResultData = basePreviewData?.resultData;
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

    return {
        actionType: 'edit_note_batch',
        actionData: {
            library_id: baseActionData.library_id,
            zotero_key: baseActionData.zotero_key,
            library_ref: baseActionData.library_ref,
            edits: [{
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
