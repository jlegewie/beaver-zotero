/**
 * Section 5 of the table design, cell by cell: what the user's edit, Not
 * reported, Clear and Reset make of a cell, and that no fill selects the
 * user's cell — not the default fill, a column fill, a row refill or a trial.
 */

import { describe, expect, it } from 'vitest';
import { isStale, type Cell, type TableSpec } from '@beaver/agent-core/layouts/table';
import { cellEditMutations, type TableCellEdit } from '@beaver/agent-core/layouts/tableEdit';
import { cellsToFill, pendingWork } from '@beaver/agent-core/layouts/tableFill';
import { applyMutations } from '@beaver/agent-core/layouts/tableMutations';

const beavers: Cell = {
    outcome: 'answered',
    provenance: 'model',
    value: { kind: 'text', text: 'A cohort of 2,000 girls' },
    documents: ['u-PDF00001'],
    reasoning: 'Table 1.',
    evidence: [{ document: 'u-PDF00001', locator: 's1', quote: '2,000 girls' }],
};

function table(): TableSpec {
    return {
        id: 't',
        title: 'T',
        columns: [
            { id: '_reference', header: 'Reference', type: 'reference', system: true },
            { id: 'sample', header: 'Sample', type: 'text', description: 'Who was studied?' },
            {
                id: 'design',
                header: 'Design',
                type: 'select',
                description: 'Which design?',
                options: [
                    { label: 'RCT', color: 'green' },
                    { label: 'Cohort', color: 'blue' },
                ],
            },
            { id: 'year', header: 'Published', type: 'date', description: 'When?' },
        ],
        rows: [
            {
                id: 'r1',
                ref: { kind: 'item', library_ref: 'u', zotero_key: 'ITEM0001' },
                documents: ['u-PDF00001'],
                cells: {
                    sample: beavers,
                    design: { outcome: 'answered', provenance: 'model', value: { kind: 'select', label: 'RCT' }, documents: ['u-PDF00001'] },
                },
            },
            { id: 'r2', ref: { kind: 'item', library_ref: 'u', zotero_key: 'ITEM0002' }, cells: {} },
        ],
    } as TableSpec;
}

function edit(spec: TableSpec, ...edits: TableCellEdit[]): TableSpec {
    const mutations = edits.flatMap((entry) => {
        const built = cellEditMutations(spec, entry);
        if (!built.ok) throw new Error(built.message);
        return built.mutations;
    });
    const applied = applyMutations(spec, mutations);
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.skipped).toEqual([]);
    return applied.spec;
}

const cells = (spec: TableSpec, selection: Parameters<typeof cellsToFill>[1] = {}) =>
    cellsToFill(spec, selection).map(([row, column]) => `${row}/${column}`);

describe('the user edits a value', () => {
    it('makes it the user’s, with the note, keeping Beaver’s answer it replaced', () => {
        const spec = edit(table(), { op: 'answer', row: 'r1', column: 'sample', value: { kind: 'text', text: ' 1,980 girls ' }, note: 'Attrition' });
        const cell = spec.rows[0].cells.sample;
        expect(cell).toMatchObject({ outcome: 'answered', provenance: 'user', value: { kind: 'text', text: '1,980 girls' }, reasoning: 'Attrition' });
        expect(cell.replaced).toMatchObject({ provenance: 'model', value: { text: 'A cohort of 2,000 girls' } });
    });

    it('is never selected by a fill: the default, a column, a row refill or a trial', () => {
        const spec = edit(table(), { op: 'answer', row: 'r1', column: 'sample', value: { kind: 'text', text: 'Mine' } });
        expect(cells(spec)).not.toContain('r1/sample');
        expect(cells(spec, { columns: ['sample'] })).toEqual(['r2/sample']);
        expect(cells(spec, { rows: ['r1'] })).toEqual(['r1/design', 'r1/year']);
        expect(pendingWork(spec).columns.some((c) => c.id === 'sample')).toBe(false);
    });

    it('refuses a value that does not fit the column', () => {
        const spec = table();
        expect(cellEditMutations(spec, { op: 'answer', row: 'r1', column: 'design', value: { kind: 'select', label: 'Survey' } })).toMatchObject({ ok: false });
        expect(cellEditMutations(spec, { op: 'answer', row: 'r1', column: 'year', value: { kind: 'date', value: 'last May' } })).toMatchObject({ ok: false });
        expect(cellEditMutations(spec, { op: 'answer', row: 'r1', column: 'sample', value: { kind: 'text', text: '  ' } })).toMatchObject({ ok: false });
        expect(cellEditMutations(spec, { op: 'answer', row: 'r1', column: '_reference', value: { kind: 'text', text: 'x' } })).toMatchObject({ ok: false });
        expect(cellEditMutations(spec, { op: 'clear', row: 'gone', column: 'sample' })).toMatchObject({ ok: false, code: 'unknown_row' });
    });
});

describe('the user marks a cell Not reported, or clears it', () => {
    it('writes the user’s not_reported cell, with the note, which no fill selects', () => {
        const spec = edit(table(), { op: 'not_reported', row: 'r1', column: 'design', note: 'Not stated' });
        expect(spec.rows[0].cells.design).toMatchObject({ outcome: 'not_reported', provenance: 'user', reasoning: 'Not stated' });
        expect(cells(spec, { rows: ['r1'] })).not.toContain('r1/design');
    });

    it('writes the user’s cleared cell, even into an empty cell, which no fill selects', () => {
        const spec = edit(table(), { op: 'clear', row: 'r2', column: 'sample' });
        expect(spec.rows[1].cells.sample).toEqual({ outcome: 'cleared', provenance: 'user' });
        expect(cells(spec)).not.toContain('r2/sample');
    });
});

describe('the user resets a cell', () => {
    it('brings Beaver’s earlier answer back, which no fill then needs', () => {
        const edited = edit(table(), { op: 'answer', row: 'r1', column: 'sample', value: { kind: 'text', text: 'Mine' } });
        const spec = edit(edited, { op: 'restore', row: 'r1', column: 'sample' });
        expect(spec.rows[0].cells.sample).toEqual(beavers);
        expect(cells(spec)).not.toContain('r1/sample');
    });

    it('brings it back out of date when the row’s document changed since, so it is pending', () => {
        const edited = edit(table(), { op: 'answer', row: 'r1', column: 'sample', value: { kind: 'text', text: 'Mine' } });
        const moved = edit(edited, { op: 'document', row: 'r1', document: 'u-PDF00002', expected: ['u-PDF00001'] });
        const spec = edit(moved, { op: 'restore', row: 'r1', column: 'sample' });
        expect(isStale(spec.rows[0], spec.rows[0].cells.sample)).toBe(true);
        expect(cells(spec)).toContain('r1/sample');
    });

    it('empties a cell the user wrote into, which is pending again', () => {
        const edited = edit(table(), { op: 'answer', row: 'r2', column: 'sample', value: { kind: 'text', text: 'Mine' } });
        const spec = edit(edited, { op: 'restore', row: 'r2', column: 'sample' });
        expect(spec.rows[1].cells.sample).toBeUndefined();
        expect(cells(spec)).toContain('r2/sample');
    });
});

describe('the user chooses a row’s document', () => {
    it('puts Beaver’s answers in the row out of date and leaves the user’s', () => {
        const edited = edit(table(), { op: 'answer', row: 'r1', column: 'design', value: { kind: 'select', label: 'Cohort' } });
        const spec = edit(edited, { op: 'document', row: 'r1', document: 'u-PDF00002', expected: ['u-PDF00001'] });
        expect(spec.rows[0].documents).toEqual(['u-PDF00002']);
        expect(isStale(spec.rows[0], spec.rows[0].cells.sample)).toBe(true);
        expect(cells(spec)).toEqual(expect.arrayContaining(['r1/sample']));
        expect(cells(spec)).not.toContain('r1/design');
    });

    it('is skipped when the row names other documents by now', () => {
        const spec = table();
        const built = cellEditMutations(spec, { op: 'document', row: 'r1', document: 'u-PDF00002', expected: [] });
        if (!built.ok) throw new Error(built.message);
        const applied = applyMutations(spec, built.mutations);
        expect(applied.ok && applied.skipped).toEqual([{ row: 'r1', reason: 'documents_changed' }]);
    });
});
