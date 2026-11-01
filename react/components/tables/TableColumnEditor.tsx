import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Column, TableSpec } from '@beaver/agent-core/layouts/table';
import { columnProblem, type DraftColumn } from '@beaver/agent-core/run-state/tableCardDraft';
import Button from '@beaver/agent-ui/primitives/Button';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import { ColumnFields, focusAtEnd } from './ColumnEditorFields';
import { columnAnswers, columnUpdate, dryRun, type ColumnEditorDraft } from './tableTabEdits';

/** What the editor saves: the new draft and, when the question changed, what happens to existing answers. */
export interface ColumnEditorSave {
    draft: ColumnEditorDraft;
    keepAnswers: boolean;
}

function plural(count: number, noun: string): string {
    return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The tab's column editor, over the table: the fields the create card's
 * Columns step uses (name, type, question, options), then — when the edit
 * asks a new question of a column that has answers — "Existing answers: Keep
 * them / Mark out of date", preselected by the question hash (the engine's
 * own test, run on the draft). Save hands the draft back; the caller
 * confirms what it would clear and writes it.
 */
export function TableColumnEditor({
    spec,
    column,
    initial,
    saving,
    error,
    onCancel,
    onSave,
}: {
    spec: TableSpec;
    /** The stored column; absent for a new one. */
    column?: Column;
    initial: ColumnEditorDraft;
    saving: boolean;
    error?: string | null;
    onCancel(): void;
    onSave(save: ColumnEditorSave): void;
}): React.ReactElement {
    const [draft, setDraft] = useState<ColumnEditorDraft>(initial);
    const [keep, setKeep] = useState<boolean | null>(null);
    const headerRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        focusAtEnd(headerRef.current);
    }, []);

    const update = (patch: Partial<Omit<DraftColumn, 'key'>>) =>
        setDraft((current) => ({ ...current, column: { ...current.column, ...patch } }));

    // Whether this edit asks a new question, by the engine's own rule. The
    // answer depends on the column alone, so the dry run skips the rows: it
    // runs on every keystroke.
    const columnsOnly = useMemo(() => ({ ...spec, rows: [] }), [spec]);
    const questionChanged = useMemo(() => {
        if (!column) return false;
        const change = columnUpdate(column, draft);
        if (!change || (change.type && change.type !== column.type)) return false;
        const result = dryRun(columnsOnly, { update_columns: [change] });
        const entry = result.ok ? result.changes[0] : undefined;
        return entry?.op === 'update_column' && entry.fields.includes('question');
    }, [columnsOnly, column, draft]);
    const answers = useMemo(() => (column ? columnAnswers(spec, column.id) : { model: 0, user: 0, stale: 0 }), [spec, column]);
    const askAnswers = questionChanged && answers.model + answers.user > 0;
    const keepAnswers = askAnswers ? keep === true : false;

    const problem = columnProblem(draft.column);
    const unchanged = !!column && !columnUpdate(column, draft);
    const save = () => {
        if (problem || saving || unchanged) return;
        onSave({ draft, keepAnswers });
    };

    return (
        <div className="rt-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={column ? 'Edit column' : 'Add column'}
                className="rt-dialog rt-column-editor"
                onKeyDown={(event) => {
                    if (isImeKeyEvent(event.nativeEvent)) return;
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        onCancel();
                    }
                }}
            >
                <div className="rt-dialog-body">
                    <div className="rt-dialog-title">{column ? 'Edit column' : 'Add column'}</div>
                    <ColumnFields
                        column={draft.column}
                        label="Column"
                        disabled={saving}
                        typeControl="segmented"
                        refs={{ header: headerRef }}
                        onUpdate={update}
                    />
                    {column && draft.column.type !== column.type && answers.model + answers.user > 0 ? (
                        <div className="rt-dialog-warning" role="note">
                            Changing the type clears the column’s {plural(answers.model + answers.user, 'answer')}.
                        </div>
                    ) : null}
                    {askAnswers ? (
                        <fieldset className="rt-existing-answers">
                            <legend className="rt-existing-legend">The question changed. Existing answers:</legend>
                            <label>
                                <input type="radio" name="existing-answers" checked={keepAnswers} onChange={() => setKeep(true)} />
                                <span>
                                    <span>Keep them</span>
                                    <span className="rt-hint">
                                        {answers.stale
                                            ? 'For small wording fixes. Answers already out of date stay out of date.'
                                            : 'For small wording fixes. Nothing to fill.'}
                                    </span>
                                </span>
                            </label>
                            <label>
                                <input type="radio" name="existing-answers" checked={!keepAnswers} onChange={() => setKeep(false)} />
                                <span>
                                    <span>
                                        Mark out of date
                                        {answers.model ? <span className="rt-hint"> · {plural(answers.model, 'answer')}</span> : null}
                                    </span>
                                    <span className="rt-hint">
                                        They stay visible and update on the next Fill.
                                        {answers.user
                                            ? ` Your ${answers.user === 1 ? '1 edited answer is' : `${answers.user} edited answers are`} kept.`
                                            : ''}
                                    </span>
                                </span>
                            </label>
                        </fieldset>
                    ) : null}
                    {problem && (draft.column.header || draft.column.description) ? (
                        <div className="text-sm table-card-problem">{problem}</div>
                    ) : null}
                    {error ? (
                        <div className="rt-dialog-error" role="alert">
                            {error}
                        </div>
                    ) : null}
                </div>
                <div className="rt-dialog-actions">
                    <Button variant="outline" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button variant="solid" onClick={save} disabled={!!problem || saving || unchanged}>
                        {column ? 'Save' : 'Add column'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
