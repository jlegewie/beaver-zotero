import type { EditOperation } from './noteEditorDiffPreview';

function pushPreviewableEdit(edits: EditOperation[], entry: Record<string, any>): void {
    const oldString = (entry.old_string as string | undefined) ?? '';
    const newString = (entry.new_string as string | undefined) ?? '';
    const operation = (entry.operation ?? 'str_replace') as EditOperation['operation'];
    if (operation === 'rewrite' || operation === 'append' || oldString) {
        edits.push({
            oldString,
            newString,
            operation,
            ...(entry.target_before_context !== undefined
                ? { targetBeforeContext: entry.target_before_context }
                : {}),
            ...(entry.target_after_context !== undefined
                ? { targetAfterContext: entry.target_after_context }
                : {}),
        });
    }
}

/**
 * Flatten legacy edit_note data and edit_note_batch `edits[]` into the ordered
 * operations consumed by the in-editor diff preview. Validation-supplied
 * target anchors are retained so a repeated old_string is previewed at the
 * same occurrence that execution will edit.
 */
export function buildPreviewableEditOperations(
    entries: Array<Record<string, any> | null | undefined>,
): EditOperation[] {
    const edits: EditOperation[] = [];
    for (const entry of entries) {
        if (!entry) continue;
        if (Array.isArray(entry.edits)) {
            for (const batchEdit of entry.edits) {
                if (batchEdit) pushPreviewableEdit(edits, batchEdit);
            }
            continue;
        }
        pushPreviewableEdit(edits, entry);
    }
    return edits;
}
