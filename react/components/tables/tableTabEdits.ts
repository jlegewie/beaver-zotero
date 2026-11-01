/**
 * The pure half of the table tab's structural edits: turning a column into
 * the column editor's draft and back into an update, what an edit would do
 * before it is made (a dry run of the same builder the write uses), and the
 * sentences its confirmation and Undo toast show. No Zotero, no I/O.
 */

import type { Cell, Column, LibraryScope, TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableCardLibraryScope } from '@beaver/agent-core/protocol/tableCardProtocol';
import { applyEdit, type TableUserColumnUpdate, type TableUserEdit } from '@beaver/agent-core/layouts/tableEdit';
import type { TableChange, TableEditColumnType } from '@beaver/agent-core/protocol/tableEditProtocol';
import { newOptionKey, type DraftColumn } from '@beaver/agent-core/run-state/tableCardDraft';
import { columnTypeOf } from './columnTypes';
import { tableChangeLines } from '@beaver/agent-core/run-state/tableEditCopy';

/** A picked collection, tag or saved search as a source entry's scope. */
export function libraryScope(scope: TableCardLibraryScope): LibraryScope {
    return {
        kind: scope.kind,
        library_ref: scope.library_ref,
        ...(scope.key ? { key: scope.key } : {}),
        ...(scope.tag ? { tag: scope.tag } : {}),
        ...(scope.name ? { name: scope.name } : {}),
    };
}

/** A column as the editor edits it, with each option's stored label by key. */
export interface ColumnEditorDraft {
    column: DraftColumn;
    /** The stored label of each option the column had, by draft key: renames send it as `previous_label`. */
    labels: Record<string, string>;
}

/** The editor's draft of a stored question column. */
export function columnEditorDraft(column: Column): ColumnEditorDraft {
    const labels: Record<string, string> = {};
    const options = (column.options ?? []).map((option) => {
        const key = newOptionKey();
        labels[key] = option.label;
        return { key, label: option.label, description: option.description ?? '' };
    });
    return {
        column: {
            key: column.id,
            header: column.header,
            type: isEditableType(column.type) ? column.type : 'text',
            description: column.description ?? '',
            options,
        },
        labels,
    };
}

/** An empty draft for a new column. */
export function newColumnDraft(type: TableEditColumnType = 'text'): ColumnEditorDraft {
    return { column: { key: 'new', header: '', type, description: '', options: [] }, labels: {} };
}

function isEditableType(type: string): type is TableEditColumnType {
    return type === 'text' || type === 'date' || type === 'boolean' || type === 'select';
}

function draftOptions(draft: DraftColumn) {
    return draft.options
        .map((option) => ({ ...option, label: option.label.trim(), description: option.description.trim() }))
        .filter((option) => option.label);
}

/**
 * The update a draft makes to its stored column, naming only what moved; null
 * when nothing did. An option keeps its identity through a rename by its
 * draft key (`previous_label`), so its cells are relabelled rather than
 * cleared.
 */
export function columnUpdate(column: Column, editor: ColumnEditorDraft): TableUserColumnUpdate | null {
    const draft = editor.column;
    const update: TableUserColumnUpdate = { id: column.id };
    const header = draft.header.trim();
    const description = draft.description.trim();
    if (header !== column.header) update.header = header;
    if (description !== (column.description ?? '')) update.description = description;
    const typeChanged = draft.type !== column.type;
    if (typeChanged) update.type = draft.type;
    if (draft.type === 'select') {
        const options = draftOptions(draft).map((option) => {
            const previous = editor.labels[option.key];
            return {
                label: option.label,
                description: option.description || null,
                ...(previous !== undefined && previous !== option.label && !typeChanged ? { previous_label: previous } : {}),
            };
        });
        const stored = (column.options ?? []).map((o) => ({ label: o.label, description: o.description || null }));
        const next = options.map((o) => ({ label: o.label, description: o.description }));
        if (typeChanged || JSON.stringify(stored) !== JSON.stringify(next)) update.options = options;
    }
    return Object.keys(update).length > 1 ? update : null;
}

/** What an edit would do to `spec`, without writing: the same builder the write runs. */
export function dryRun(spec: TableSpec, operations: TableUserEdit): { ok: true; changes: TableChange[] } | { ok: false; message: string } {
    // Additions need resolved sources, which a dry run does not have.
    const result = applyEdit(spec, { ...operations, add_sources: null, refresh_sources: null }, { added: [], refreshed: new Map() }, new Date().toISOString());
    return result.ok ? { ok: true, changes: result.changes } : { ok: false, message: result.message };
}

function isAnswer(cell: Cell | undefined): boolean {
    return !!cell && (cell.outcome === 'answered' || cell.outcome === 'not_reported' || cell.outcome === 'cleared');
}

/**
 * The answers a column holds, Beaver's and the user's, and of Beaver's those
 * already out of date: the counts the editor's "Mark out of date · 44
 * answers … Your 1 edited answer is kept" names.
 */
export function columnAnswers(spec: TableSpec, columnId: string): { model: number; user: number; stale: number } {
    let model = 0;
    let user = 0;
    let stale = 0;
    for (const row of spec.rows) {
        const cell = row.cells[columnId];
        if (!isAnswer(cell)) continue;
        if (cell!.provenance === 'user') user += 1;
        else {
            model += 1;
            if (cell!.stale) stale += 1;
        }
    }
    return { model, user, stale };
}

/** The user's cells in these rows: what removing them takes with them. */
export function userCellsInRows(spec: TableSpec, rowIds: Iterable<string>): number {
    const wanted = new Set(rowIds);
    let count = 0;
    for (const row of spec.rows) {
        if (!wanted.has(row.id)) continue;
        for (const [id, cell] of Object.entries(row.cells)) {
            const column = spec.columns.find((c) => c.id === id);
            if (column && !column.system && cell.provenance === 'user') count += 1;
        }
    }
    return count;
}

/** The rows only this source yielded: what removing it removes. */
export function rowsOnlyFrom(spec: TableSpec, sourceId: string): string[] {
    return spec.rows
        .filter((row) => {
            const origins = row.origin ?? [];
            return origins.some((o) => o.source === sourceId) && origins.every((o) => o.source === sourceId);
        })
        .map((row) => row.id);
}

function plural(count: number, noun: string): string {
    return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

function quoted(text: string): string {
    return `“${text}”`;
}

/** ", 1 of them yours" and the like, as the change list says it. */
function yours(cleared: number, user: number): string {
    if (!user) return '';
    if (user < cleared) return `, ${user} of them yours`;
    return cleared === 1 ? ', which you edited' : ', all of them yours';
}

/** A confirmation to ask before a write that clears answers. */
export interface EditConfirmation {
    title: string;
    text: string;
    confirmLabel: string;
}

/**
 * The confirmation a column edit needs: a type change or a removed option
 * clears answers and asks first, naming how many and how many were the
 * user's. Null when the edit clears nothing.
 */
export function columnEditConfirmation(column: Column, update: TableUserColumnUpdate, change: TableChange | undefined): EditConfirmation | null {
    if (change?.op !== 'update_column' || !change.cleared) return null;
    const counts = `${plural(change.cleared, 'answer')}${yours(change.cleared, change.user_cleared)}`;
    if (update.type && update.type !== column.type) {
        return {
            title: `Change ${quoted(column.header)} to ${columnTypeOf(update.type).label}?`,
            text: `Changing the type clears the column's ${counts}. The column is filled again on the next Fill.`,
            confirmLabel: 'Change type',
        };
    }
    const kept = new Set((update.options ?? []).map((o) => o.previous_label ?? o.label));
    const removed = (column.options ?? []).map((o) => o.label).filter((label) => !kept.has(label));
    const names = removed.map(quoted).join(', ');
    return {
        title: removed.length === 1 ? `Remove the option ${names}?` : 'Remove these options?',
        text: `${plural(change.cleared, 'answer')} ${change.cleared === 1 ? 'holds' : 'hold'} ${removed.length === 1 ? 'it' : 'them'}${yours(change.cleared, change.user_cleared)}. Removing ${removed.length === 1 ? 'it' : 'them'} clears ${change.cleared === 1 ? 'that answer' : 'those answers'}.`,
        confirmLabel: removed.length === 1 ? 'Remove option' : 'Remove options',
    };
}

/** Whether a column update is destructive: it seals its own version and offers Undo. */
export function isDestructiveUpdate(column: Column, update: TableUserColumnUpdate, change: TableChange | undefined): boolean {
    if (update.type && update.type !== column.type) return true;
    if (change?.op === 'update_column' && change.cleared > 0) return true;
    if (!update.options) return false;
    const kept = new Set(update.options.map((o) => o.previous_label ?? o.label));
    return (column.options ?? []).some((o) => !kept.has(o.label));
}

/**
 * The confirmation a removal needs when it takes answers the user wrote with
 * it; null otherwise (Undo is enough for Beaver's answers).
 */
export function removalConfirmation(
    what: 'column' | 'rows' | 'source',
    label: string,
    userCells: number,
): EditConfirmation | null {
    if (!userCells) return null;
    const answers = `${plural(userCells, 'answer')} you edited`;
    switch (what) {
        case 'column':
            return { title: `Remove column ${quoted(label)}?`, text: `It holds ${answers}. They are removed with the column.`, confirmLabel: 'Remove column' };
        case 'rows':
            return { title: `Remove ${label} from the table?`, text: `They hold ${answers}. They are removed with the rows.`, confirmLabel: 'Remove' };
        case 'source':
            return { title: `Remove ${label}?`, text: `The rows only it added hold ${answers}. They are removed with the rows.`, confirmLabel: 'Remove source' };
    }
}

/** The Undo toast's text: the edit's change lines, joined. */
export function editToastText(changes: readonly TableChange[]): string {
    return tableChangeLines(changes)
        .map((line) => line.text)
        .join(' · ');
}
