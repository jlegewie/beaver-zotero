import type { EditOperation } from './noteEditorDiffPreview';

function pushPreviewableEdit(edits: EditOperation[], entry: Record<string, any>): void {
    // A skipped `edit_note_blocks` edit is never applied by execute, so it must
    // never contribute a diff the user is asked to approve. Validation already
    // withholds the preview triple from a skipped edit (see editNoteBlocks.ts),
    // but that is the writer's discipline; this is the reader's guard.
    //
    // Gated on `op`, which ONLY a block edit carries, rather than on
    // `skip_reason_code` alone. The inertness of this line for legacy/batch then
    // holds structurally instead of resting on a contract this repo cannot
    // enforce: batch entries reach here verbatim from backend `action_data`
    // whenever validation emits no `normalized_action_data`, legacy
    // normalization is a full spread that preserves unknown keys, and nothing
    // strips unknown keys at runtime (the edit types are TS interfaces only). An
    // unscoped guard would let a stray `skip_reason_code` on a batch edit drop a
    // diff the user is approving while execute still applies it.
    if (entry.op !== undefined && entry.skip_reason_code) return;
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
 * Flatten legacy edit_note data and edit_note_batch / edit_note_blocks
 * `edits[]` into the ordered operations consumed by the in-editor diff preview.
 * Validation-supplied target anchors are retained so a repeated old_string is
 * previewed at the same occurrence that execution will edit.
 *
 * Block edits participate through the same flat `{operation, old_string,
 * new_string}` triple the other two variants use — validation writes it onto
 * each applicable block edit for exactly this purpose — with skipped edits
 * dropped by the guard in {@link pushPreviewableEdit}.
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
