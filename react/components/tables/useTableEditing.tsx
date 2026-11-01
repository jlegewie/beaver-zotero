import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { Column, RemovedPaper, Row, SourceEntry, TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableUserEdit } from '@beaver/agent-core/layouts/tableEdit';
import type { TableSourceDraft } from '@beaver/agent-core/protocol/tableEditProtocol';
import type { TableCardLibraryScope } from '@beaver/agent-core/protocol/tableCardProtocol';
import type { ResearchColumnType, ResearchTableEditing } from '@beaver/agent-ui/layouts';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { getHost } from '@beaver/agent-ui/host';
import { DeleteIcon } from '../icons/icons';
import { getTablesApi } from '../../../src/services/artifacts/tablesApi';
import type { TableRef } from '../../../src/services/artifacts/tableItemIdentity';
import type { TableUndoTarget } from '../../../src/services/artifacts/tableStore';
import type { TableUserEditResult } from '../../../src/services/artifacts/tableUserEdits';
import { tableActionErrorMessage } from '../../../src/ui/tableDocumentActions';
import { TableColumnEditor, type ColumnEditorSave } from './TableColumnEditor';
import { TableAddSources, TableSourcesPopover, addPapersContent, removedPaperId, sourceEntryName } from './TableSources';
import { wireColumn } from '@beaver/agent-core/run-state/tableCardDraft';
import {
    columnEditConfirmation,
    columnEditorDraft,
    columnUpdate,
    dryRun,
    editToastText,
    isDestructiveUpdate,
    newColumnDraft,
    removalConfirmation,
    libraryScope,
    rowsOnlyFrom,
    userCellsInRows,
    type ColumnEditorDraft,
    type EditConfirmation,
} from './tableTabEdits';

/** The toast under the toolbar after an edit: what it did and, for a destructive one, Undo. */
export interface TableEditToast {
    text: string;
    /** The version a destructive edit committed, which Undo takes back. */
    undo?: TableUndoTarget;
    /** Why Undo did not happen. */
    error?: string;
}

interface EditorState {
    column?: Column;
    initial: ColumnEditorDraft;
    error?: string | null;
}

/** Each tab mount is one editing session: its ordinary edits collapse into one version. */
function newSessionId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The table tab's structural edits: the controls `ResearchTable` offers
 * (title and description, the column menu and editor, (+), the sources
 * popover, + Papers, the new-papers notice's Add, Remove from table) and
 * what they write.
 *
 * Every edit is data handed to the plugin realm (`commands.edit`), which
 * resolves added sources with the one resolver and applies the edit with the
 * same builder as the model's `apply_edit`. An ordinary edit collapses into
 * this tab session's version; a destructive one (a removal, a type change, a
 * removed option) seals its own and shows the Undo toast. An edit that would
 * clear answers asks first, as §5 of the table design requires, naming how
 * many were the user's. The table re-renders from the store's update event.
 */
export function useTableEditing({
    tableRef,
    spec,
    disabledReason,
    fillRunning,
    surfaceWindow,
    portalContainer,
    newBySource,
}: {
    tableRef: TableRef;
    spec: TableSpec;
    /** Why the table cannot be edited (a read-only library). */
    disabledReason?: string;
    /** A fill of this table is running: Undo waits for it to end. */
    fillRunning: boolean;
    surfaceWindow: Window | null;
    portalContainer: HTMLElement | null;
    newBySource: ReadonlyMap<string, number>;
}) {
    const session = useRef(newSessionId()).current;
    const [toast, setToast] = useState<TableEditToast | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editor, setEditor] = useState<EditorState | null>(null);
    const [saving, setSaving] = useState(false);
    const specRef = useRef(spec);
    specRef.current = spec;

    const commands = useCallback(() => {
        const api = getTablesApi();
        if (!api || !surfaceWindow) return null;
        try {
            return api.local.commands(surfaceWindow);
        } catch {
            return null;
        }
    }, [surfaceWindow]);

    const confirm = useCallback(
        (question: EditConfirmation | null): boolean => {
            if (!question) return true;
            const dialogs = getHost().dialogs;
            return dialogs
                ? dialogs.confirm({ ...question, window: surfaceWindow ?? undefined })
                : !!surfaceWindow?.confirm(`${question.title}\n\n${question.text}`);
        },
        [surfaceWindow],
    );

    /**
     * Writes one edit. A destructive edit that committed shows the Undo toast;
     * an addition shows what it added. Returns the refusal's message, if any.
     */
    const run = useCallback(
        async (operations: TableUserEdit, options: { destructive?: boolean; change?: string; report?: boolean } = {}) => {
            const local = commands();
            if (!local) {
                const message = 'Editing is unavailable right now. Reload Beaver and try again.';
                setError(message);
                return message;
            }
            let result: TableUserEditResult;
            try {
                result = await local.edit(tableRef, operations, {
                    seal: !!options.destructive,
                    session,
                    ...(options.change ? { change: options.change } : {}),
                });
            } catch (thrown) {
                const message = tableActionErrorMessage(thrown, tableRef);
                setError(message);
                return message;
            }
            if (!result.ok) {
                setError(result.message);
                return result.message;
            }
            setError(null);
            if (result.committed && options.destructive)
                setToast({ text: editToastText(result.changes), undo: { version: result.version, sha256: result.sha256 } });
            else if (options.report && result.changes.length) setToast({ text: editToastText(result.changes) });
            return null;
        },
        [commands, tableRef, session],
    );

    const undo = useCallback(async () => {
        const target = toast?.undo;
        const local = commands();
        if (!target || !local) return;
        try {
            const result = await local.undo(tableRef, target);
            setToast((current) =>
                current?.undo !== target
                    ? current
                    : result.ok
                      ? { text: `Undone: ${current.text}` }
                      : { ...current, undo: undefined, error: result.message },
            );
        } catch (thrown) {
            setToast((current) => (current ? { ...current, undo: undefined, error: tableActionErrorMessage(thrown, tableRef) } : current));
        }
    }, [toast, commands, tableRef]);

    // Removals ---------------------------------------------------------------

    const removeRows = useCallback(
        (rowIds: string[]) => {
            const current = specRef.current;
            const label = rowIds.length === 1 ? 'this row' : `${rowIds.length} rows`;
            if (!confirm(removalConfirmation('rows', label, userCellsInRows(current, rowIds)))) return;
            void run({ remove_rows: rowIds }, { destructive: true, change: `Removed ${label.replace('this ', '1 ')}` });
        },
        [confirm, run],
    );

    const removeColumn = useCallback(
        (column: Column) => {
            const dry = dryRun(specRef.current, { remove_columns: [column.id] });
            const change = dry.ok ? dry.changes[0] : undefined;
            const userCleared = change?.op === 'remove_column' ? change.user_cleared : 0;
            if (!confirm(removalConfirmation('column', column.header, userCleared))) return;
            void run({ remove_columns: [column.id] }, { destructive: true, change: `Removed column “${column.header}”` });
        },
        [confirm, run],
    );

    const removeSource = useCallback(
        (entry: SourceEntry) => {
            const current = specRef.current;
            const name = sourceEntryName(entry);
            const users = userCellsInRows(current, rowsOnlyFrom(current, entry.id));
            if (!confirm(removalConfirmation('source', `“${name}”`, users))) return;
            void run({ remove_sources: [entry.id] }, { destructive: true, change: `Removed source “${name}”` });
        },
        [confirm, run],
    );

    // Columns ----------------------------------------------------------------

    const changeType = useCallback(
        (column: Column, type: ResearchColumnType) => {
            // A category needs its options: the editor opens on them.
            if (type === 'select') {
                const initial = columnEditorDraft(column);
                setEditor({ column, initial: { ...initial, column: { ...initial.column, type } } });
                return;
            }
            const update = { id: column.id, type };
            const dry = dryRun(specRef.current, { update_columns: [update] });
            if (!dry.ok) {
                setError(dry.message);
                return;
            }
            if (!confirm(columnEditConfirmation(column, update, dry.changes[0]))) return;
            void run({ update_columns: [update] }, { destructive: true, change: `Changed the type of “${column.header}”` });
        },
        [confirm, run],
    );

    const saveColumn = useCallback(
        async ({ draft, keepAnswers }: ColumnEditorSave) => {
            if (!editor) return;
            const column = editor.column;
            let operations: TableUserEdit;
            let destructive = false;
            if (column) {
                const update = columnUpdate(column, draft);
                if (!update) {
                    setEditor(null);
                    return;
                }
                if (keepAnswers) update.existing_answers = 'keep';
                const dry = dryRun(specRef.current, { update_columns: [update] });
                if (!dry.ok) {
                    setEditor({ ...editor, error: dry.message });
                    return;
                }
                if (!confirm(columnEditConfirmation(column, update, dry.changes[0]))) return;
                destructive = isDestructiveUpdate(column, update, dry.changes[0]);
                operations = { update_columns: [update] };
            } else {
                operations = { add_columns: [wireColumn(draft.column)] };
            }
            setSaving(true);
            const refused = await run(operations, {
                destructive,
                change: column ? `Changed column “${column.header}”` : `Added column “${draft.column.header.trim()}”`,
            });
            setSaving(false);
            if (refused) setEditor((current) => (current ? { ...current, error: refused } : current));
            else setEditor(null);
        },
        [editor, confirm, run],
    );

    // Sources ----------------------------------------------------------------

    /** Library sources the table does not have yet, so a duplicate pick is not an error. */
    const newScopes = useCallback((scopes: TableCardLibraryScope[]) => {
        const key = (scope: TableCardLibraryScope) => `${scope.kind}\u0000${scope.library_ref}\u0000${scope.key ?? scope.tag}`;
        const known = new Set((specRef.current.sources ?? []).flatMap((s) => (s.scope ? [key(s.scope)] : [])));
        return scopes.filter((scope) => !known.has(key(scope)));
    }, []);

    const addSources = useCallback(
        (sources: TableSourceDraft[]) => {
            const library = newScopes(sources.flatMap((s) => (s.type === 'library' ? [s.scope as TableCardLibraryScope] : [])));
            const items = sources.flatMap((s) => (s.type === 'items' ? s.ids : []));
            const drafts: TableSourceDraft[] = [
                ...(items.length ? [{ type: 'items' as const, ids: [...new Set(items)] }] : []),
                ...library.map((scope) => ({ type: 'library' as const, scope: libraryScope(scope) })),
            ];
            if (!drafts.length) {
                setToast({ text: 'Already in the table.' });
                return;
            }
            void run({ add_sources: drafts }, { report: true, change: 'Added papers' });
        },
        [newScopes, run],
    );

    const restore = useCallback(
        (paper: RemovedPaper) => {
            const id = removedPaperId(paper);
            if (id) void run({ add_sources: [{ type: 'items', ids: [id] }] }, { report: true, change: 'Restored a paper' });
        },
        [run],
    );

    const refresh = useCallback(
        (sourceIds: string[]) => {
            if (sourceIds.length) void run({ refresh_sources: sourceIds }, { report: true, change: 'Added new papers' });
        },
        [run],
    );

    // What the surface gets ----------------------------------------------------

    const disabled = !!disabledReason;
    const addMenu = (label: string, className: string) => (
        <TableAddSources
            spec={spec}
            disabledReason={disabledReason}
            triggerLabel={label}
            triggerClassName={className}
            triggerContent={addPapersContent(label)}
            portalContainer={portalContainer}
            onAdd={(source) => addSources([source])}
        />
    );

    const editing: ResearchTableEditing = {
        disabledReason,
        onTitle: (title) => void run({ title }, { change: 'Renamed the table' }),
        onDescription: (description) => void run({ description }, { change: 'Edited the description' }),
        onEditColumn: (column) => setEditor({ column, initial: columnEditorDraft(column) }),
        onAddColumn: () => setEditor({ initial: newColumnDraft() }),
        onChangeType: changeType,
        onRemoveColumn: removeColumn,
        renderSources: () => (
            <TableSourcesPopover
                spec={spec}
                newBySource={newBySource}
                disabledReason={disabledReason}
                addMenu={addMenu('Add papers or a collection', 'rt-sources-add-menu')}
                onRefresh={(entry) => refresh([entry.id])}
                onRemove={removeSource}
                onRestore={restore}
            />
        ),
        onAddNewPapers: () => refresh([...newBySource.keys()]),
        toolbarActions: addMenu('Papers', 'rt-add-papers'),
    };

    const selectionActions = (rowIds: string[]) => (
        <button
            type="button"
            className="rt-selection-action rt-selection-remove"
            disabled={disabled}
            title={disabledReason}
            onClick={() => removeRows(rowIds)}
        >
            Remove from table
        </button>
    );

    const rowMenuItems = (row: Row): MenuItem[] => [
        { label: 'Remove from table', icon: DeleteIcon, disabled, onClick: () => removeRows([row.id]) },
    ];

    const toastView = toast ? (
        <div className="rt-toast" role="status">
            <span className="rt-toast-text">{toast.error ? `${toast.text} · ${toast.error}` : toast.text}</span>
            {toast.undo ? (
                <button
                    type="button"
                    className="rt-toast-action"
                    disabled={fillRunning}
                    title={fillRunning ? 'Undo is available when the fill ends.' : undefined}
                    onClick={() => void undo()}
                >
                    Undo
                </button>
            ) : null}
            <button type="button" className="rt-icon-button rt-toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
                ×
            </button>
        </div>
    ) : null;

    const overlay = editor ? (
        <TableColumnEditor
            spec={spec}
            column={editor.column}
            initial={editor.initial}
            saving={saving}
            error={editor.error}
            onCancel={() => setEditor(null)}
            onSave={(save) => void saveColumn(save)}
        />
    ) : null;

    const onDrop = useMemo(
        () => ({
            onAddItems: (ids: string[]) => addSources([{ type: 'items', ids }]),
            onAddScopes: (scopes: TableCardLibraryScope[]) =>
                addSources(scopes.map((scope) => ({ type: 'library' as const, scope: libraryScope(scope) }))),
        }),
        [addSources],
    );

    return { editing, selectionActions, rowMenuItems, toast: toastView, overlay, error, onDrop };
}
