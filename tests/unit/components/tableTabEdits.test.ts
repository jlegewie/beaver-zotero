/**
 * The table tab's structural edits before they are written: the column
 * editor's draft and the update it makes, what an edit would clear, the
 * confirmations that name it, and the Undo toast's text.
 */

import { describe, expect, it } from 'vitest';
import type { Cell, Column, TableSpec } from '@beaver/agent-core/layouts/table';
import { wireColumn } from '@beaver/agent-core/run-state/tableCardDraft';
import {
    columnAnswers,
    columnEditConfirmation,
    columnEditorDraft,
    columnUpdate,
    dryRun,
    editToastText,
    isDestructiveUpdate,
    removalConfirmation,
    rowsOnlyFrom,
    userCellsInRows,
} from '../../../react/components/tables/tableTabEdits';

const design: Column = {
    id: 'design',
    header: 'Design',
    type: 'select',
    description: 'What is the design?',
    options: [
        { label: 'RCT', color: 'green', description: 'Randomized' },
        { label: 'Cohort', color: 'blue' },
    ],
};

const answer = (label: string, provenance: 'model' | 'user'): Cell =>
    ({ outcome: 'answered', provenance, value: { kind: 'select', label } }) as Cell;

function spec(): TableSpec {
    return {
        id: 't',
        title: 'T',
        sources: [
            { id: 's1', type: 'items', ids: ['u-AAAA1111'] },
            { id: 's2', type: 'library', scope: { kind: 'collection', library_ref: 'u', key: 'COLL0001', name: 'Trials' } },
        ],
        columns: [{ id: '_reference', header: 'Reference', type: 'reference', system: true }, design],
        rows: [
            { id: 'r1', origin: [{ source: 's1', date: '2026-10-30' }], cells: { design: answer('RCT', 'model') } },
            { id: 'r2', origin: [{ source: 's2', date: '2026-10-30' }], cells: { design: answer('Cohort', 'user') } },
            {
                id: 'r3',
                origin: [
                    { source: 's1', date: '2026-10-30' },
                    { source: 's2', date: '2026-10-30' },
                ],
                cells: { design: answer('RCT', 'model') },
            },
        ],
    } as TableSpec;
}

describe('the column editor draft', () => {
    it('round-trips to no update when nothing changed', () => {
        expect(columnUpdate(design, columnEditorDraft(design))).toBeNull();
    });

    it('sends a renamed option with its stored label, so its answers are relabelled', () => {
        const draft = columnEditorDraft(design);
        draft.column.options[0] = { ...draft.column.options[0], label: 'Randomized trial' };
        expect(columnUpdate(design, draft)).toEqual({
            id: 'design',
            options: [
                { label: 'Randomized trial', description: 'Randomized', previous_label: 'RCT' },
                { label: 'Cohort', description: null },
            ],
        });
    });

    it('names only what moved: the header and the question', () => {
        const draft = columnEditorDraft(design);
        draft.column.header = ' Study design ';
        draft.column.description = 'Which design?';
        expect(columnUpdate(design, draft)).toEqual({ id: 'design', header: 'Study design', description: 'Which design?' });
    });

    it('sends a new type, and a category its options without renames', () => {
        const text: Column = { id: 'notes', header: 'Notes', type: 'text', description: 'Notes?' };
        const draft = columnEditorDraft(text);
        draft.column.type = 'select';
        draft.column.options = [{ key: 'a', label: 'Yes', description: '' }];
        expect(columnUpdate(text, draft)).toEqual({ id: 'notes', type: 'select', options: [{ label: 'Yes', description: null }] });
    });

    it('builds a new column from the draft as the card does, dropping empty options', () => {
        const draft = columnEditorDraft({ ...design, id: 'x' }).column;
        draft.options.push({ key: 'empty', label: '  ', description: '' });
        expect(wireColumn(draft)).toEqual({
            header: 'Design',
            type: 'select',
            description: 'What is the design?',
            options: [{ label: 'RCT', description: 'Randomized' }, { label: 'Cohort' }],
        });
    });
});

describe('what an edit clears, and asking first', () => {
    it('counts the answers a column holds, Beaver’s and the user’s', () => {
        expect(columnAnswers(spec(), 'design')).toEqual({ model: 2, user: 1, stale: 0 });
        const stale = spec();
        stale.rows[0].cells.design = { ...stale.rows[0].cells.design, stale: true } as Cell;
        expect(columnAnswers(stale, 'design').stale).toBe(1);
    });

    it('confirms a type change with the answers it clears and how many were the user’s', () => {
        const update = { id: 'design', type: 'boolean' as const };
        const result = dryRun(spec(), { update_columns: [update] });
        if (!result.ok) throw new Error(result.message);
        expect(columnEditConfirmation(design, update, result.changes[0])).toEqual({
            title: 'Change “Design” to Yes / no?',
            text: "Changing the type clears the column's 3 answers, 1 of them yours. The column is filled again on the next Fill.",
            confirmLabel: 'Change type',
        });
        expect(isDestructiveUpdate(design, update, result.changes[0])).toBe(true);
    });

    it('confirms removing an option that answers hold, naming it', () => {
        const update = { id: 'design', options: [{ label: 'RCT', description: 'Randomized' }] };
        const result = dryRun(spec(), { update_columns: [update] });
        if (!result.ok) throw new Error(result.message);
        expect(columnEditConfirmation(design, update, result.changes[0])).toEqual({
            title: 'Remove the option “Cohort”?',
            text: '1 answer holds it, which you edited. Removing it clears that answer.',
            confirmLabel: 'Remove option',
        });
        expect(isDestructiveUpdate(design, update, result.changes[0])).toBe(true);
    });

    it('asks nothing for a rename, which clears nothing and is not destructive', () => {
        const update = { id: 'design', options: [{ label: 'Trial', previous_label: 'RCT' }, { label: 'Cohort' }] };
        const result = dryRun(spec(), { update_columns: [update] });
        if (!result.ok) throw new Error(result.message);
        expect(columnEditConfirmation(design, update, result.changes[0])).toBeNull();
        expect(isDestructiveUpdate(design, update, result.changes[0])).toBe(false);
    });

    it('treats removing an option no answer holds as destructive without asking', () => {
        const unused: Column = { ...design, options: [...design.options!, { label: 'Survey', color: 'red' }] };
        const update = { id: 'design', options: [{ label: 'RCT', description: 'Randomized' }, { label: 'Cohort' }] };
        expect(columnEditConfirmation(unused, update, undefined)).toBeNull();
        expect(isDestructiveUpdate(unused, update, undefined)).toBe(true);
    });

    it('finds the rows only one source added, and the user’s answers in them', () => {
        expect(rowsOnlyFrom(spec(), 's2')).toEqual(['r2']);
        expect(userCellsInRows(spec(), ['r2'])).toBe(1);
        expect(userCellsInRows(spec(), ['r1', 'r3'])).toBe(0);
    });

    it('asks before a removal only when it takes the user’s answers', () => {
        expect(removalConfirmation('rows', '2 rows', 0)).toBeNull();
        expect(removalConfirmation('column', 'Design', 1)).toEqual({
            title: 'Remove column “Design”?',
            text: 'It holds 1 answer you edited. They are removed with the column.',
            confirmLabel: 'Remove column',
        });
    });
});

describe('the Undo toast', () => {
    it('reads the change list as one line', () => {
        const result = dryRun(spec(), { remove_columns: ['design'] });
        if (!result.ok) throw new Error(result.message);
        expect(editToastText(result.changes)).toBe('Removed column “Design” · 3 answers, 1 of them yours');
    });
});
