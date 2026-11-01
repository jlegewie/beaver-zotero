/**
 * The user's structural edits from the table tab, applied in the plugin realm.
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
import { applyEdit, refreshTargets, type ResolvedSource, type TableUserEdit } from '@beaver/agent-core/layouts/tableEdit';
import type { TableChange } from '@beaver/agent-core/protocol/tableEditProtocol';
import { applyTableEditUncoordinated, openTableUncoordinated, type TableApplyEditResult } from './tableStore';
import { resolveSource } from './tableSources';
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
