/**
 * The user's edits from the table tab, applied in the plugin realm: the
 * structural edits below, and the cell edits at the end.
 *
 * A tab edit takes the same path as the model's `apply_edit`: the sources it
 * adds or refreshes are resolved first by the one resolver
 * (`tableSources.ts`), then the pure builder (`applyEdit`) applies the whole
 * edit to the table as it stands under the store's lock, all of it or
 * nothing. The renderer passes data only (the operations and how to commit);
 * nothing of the window crosses into the write.
 *
 * Unlike a model edit, a tab edit is local and is never repeated, so it
 * carries no operation identity. An ordinary edit (a title, a new column, a
 * reworded question, added papers) collapses into the tab session's version;
 * a destructive one (a removal, a type change, a removed option) seals a
 * version of its own, which Undo restores from.
 */

import { readSpec, validateTableSpec, type SourceEntry, type TableSpec } from '@beaver/agent-core/layouts/table';
import {
    applyEdit,
    cellEditMutations,
    refreshTargets,
    type ResolvedSource,
    type TableCellEdit,
    type TableUserEdit,
} from '@beaver/agent-core/layouts/tableEdit';
import { applyMutations, type TableMutation } from '@beaver/agent-core/layouts/tableMutations';
import { parseItemReference } from '@beaver/agent-core/identity/libraryRef';
import type { TableChange } from '@beaver/agent-core/protocol/tableEditProtocol';
import { applyTableEditUncoordinated, openTableUncoordinated, type TableApplyEditResult } from './tableStore';
import { resolveSource } from './tableSources';
import { isRowDocumentKind } from '../tableFills/planner';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';
import { resolveLibraryRef } from '../../utils/libraryIdentity';
import { TableItemError, type TableRef } from './tableItemIdentity';

/** How the tab commits an edit. */
export interface TableUserEditOptions {
    /** A destructive edit: its own sealed version, which Undo can restore from. */
    seal: boolean;
    /** The tab session an ordinary edit collapses into. */
    session?: string;
    /** One line for the version history. */
    change?: string;
}

/** The store's answer, with the builder's typed change list. */
export type TableUserEditResult =
    | (Extract<TableApplyEditResult, { ok: true }> & { changes: TableChange[] })
    | Extract<TableApplyEditResult, { ok: false }>;

/** The table as stored, or a refusal: the engine only edits a valid table. */
function validSpec(raw: unknown): TableSpec {
    const parsed = readSpec(raw);
    if (!parsed.ok || validateTableSpec(parsed.spec).length)
        throw new TableItemError('This table could not be read, so it cannot be edited.', 'invalid_spec');
    return parsed.spec;
}

/** Applies one tab edit. Call through `addon.libraryOperations` (`table_applyUserEdit`). */
export async function applyUserTableEditUncoordinated(
    ref: TableRef,
    operations: TableUserEdit,
    options: TableUserEditOptions,
): Promise<TableUserEditResult> {
    const added: ResolvedSource[] = [];
    for (const draft of operations.add_sources ?? [])
        added.push(await resolveSource({ ...draft, id: 'new' } as SourceEntry));
    const refreshed = new Map<string, ResolvedSource>();
    if (operations.refresh_sources != null) {
        const opened = await openTableUncoordinated(ref);
        for (const entry of refreshTargets(validSpec(opened.spec), operations.refresh_sources))
            refreshed.set(entry.id, await resolveSource(entry));
    }
    const now = new Date().toISOString();
    const result = await applyTableEditUncoordinated(
        ref,
        (spec) => applyEdit(validSpec(spec), operations, { added, refreshed }, now),
        {
            actor: 'user',
            ...(options.seal ? { seal: true } : options.session ? { collapse_key: `tab:${options.session}` } : {}),
            ...(options.change ? { change: options.change } : {}),
        },
    );
    return result as TableUserEditResult;
}

/**
 * Checks a chosen document before it is written: a readable attachment of
 * the row's own item. Throws a user-facing refusal otherwise.
 */
async function checkRowDocument(spec: TableSpec, edit: Extract<TableCellEdit, { op: 'document' }>): Promise<void> {
    const row = spec.rows.find((candidate) => candidate.id === edit.row);
    const ref = row?.ref;
    if (!row) throw new TableItemError('This row is no longer in the table.', 'invalid_request');
    if (ref?.kind !== 'item') throw new TableItemError('Only a library item’s row can be read from another document.', 'invalid_request');
    const parsed = parseItemReference(edit.document);
    const libraryID = parsed ? resolveLibraryRef(parsed) : null;
    const attachment = parsed && libraryID != null
        ? ((await Zotero.Items.getByLibraryAndKeyAsync(libraryID, parsed.zotero_key)) as Zotero.Item | false)
        : false;
    const parent = attachment && attachment.parentItemID ? ((await Zotero.Items.getAsync(attachment.parentItemID)) as Zotero.Item | false) : false;
    const sameItem = !!parent && parent.key === ref.zotero_key && resolveLibraryRef({ library_ref: ref.library_ref, library_id: ref.library_id }) === parent.libraryID;
    if (!attachment || attachment.deleted || !sameItem || !isRowDocumentKind(getReadableContentKind(attachment)))
        throw new TableItemError('That document is not a readable attachment of this paper.', 'invalid_request');
}

/**
 * Applies cell edits from the tab (section 5): the user's answers, Not
 * reported and cleared cells, a reset to Beaver's answer, and the document a
 * row is read from. All of them or none, under the table's lock; they
 * collapse into the tab session's version like other ordinary edits. A row
 * whose documents changed since the user chose another is refused. Call
 * through `addon.libraryOperations` (`table_applyUserCellEdit`).
 */
export async function applyUserCellEditUncoordinated(
    ref: TableRef,
    edits: TableCellEdit[],
    options: { session?: string; change?: string } = {},
): Promise<TableApplyEditResult> {
    if (!Array.isArray(edits) || !edits.length) throw new TableItemError('A cell edit names what to change.', 'invalid_request');
    const documents = edits.filter((edit): edit is Extract<TableCellEdit, { op: 'document' }> => edit?.op === 'document');
    if (documents.length) {
        const opened = validSpec((await openTableUncoordinated(ref)).spec);
        for (const edit of documents) await checkRowDocument(opened, edit);
    }
    return applyTableEditUncoordinated(
        ref,
        (raw) => {
            const spec = validSpec(raw);
            const mutations: TableMutation[] = [];
            for (const edit of edits) {
                const built = cellEditMutations(spec, edit);
                if (!built.ok) return { ok: false, code: built.code, message: built.message };
                mutations.push(...built.mutations);
            }
            const applied = applyMutations(spec, mutations);
            if (!applied.ok) return { ok: false, code: applied.error.code, message: applied.error.message };
            if (applied.skipped.some((skip) => skip.reason === 'documents_changed'))
                return { ok: false, code: 'documents_changed', message: 'This row’s document changed in the meantime. Choose again.' };
            return { ok: true, spec: applied.spec, changes: [] };
        },
        {
            actor: 'user',
            ...(options.session ? { collapse_key: `tab:${options.session}` } : {}),
            ...(options.change ? { change: options.change } : {}),
        },
    );
}
