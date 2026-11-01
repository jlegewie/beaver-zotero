/**
 * The research table's display rules: which tags a cell shows (by outcome,
 * provenance and staleness), the column badges, new rows, and what the cell
 * inspector says for each kind of cell.
 */

import { describe, expect, it } from 'vitest';
import type { Cell, Column, Row, TableSpec } from '@beaver/agent-core/layouts/table';
import {
    cellState,
    cellTags,
    columnBadges,
    evidenceTagLabel,
    inspectorContent,
    isNewRow,
    newBadgeText,
    researchColumns,
    rowDocumentLine,
    staleBadgeText,
    tagDefinition,
} from '@beaver/agent-ui/layouts/research/cellModel';
import { paperText } from '@beaver/agent-ui/layouts/research/PaperCell';

const doc = 'u-PDF1';
const evidence = (page?: number) => ({ document: doc, locator: 's1.2', quote: 'A quoted passage.', ...(page != null ? { page } : {}) });

const modelAnswer = (extra: Partial<Cell> = {}): Cell =>
    ({ outcome: 'answered', provenance: 'model', value: { kind: 'text', text: 'Yes' }, documents: [doc], evidence: [evidence(13), evidence(20)], ...extra }) as Cell;
const row = (cells: Record<string, Cell> = {}, extra: Partial<Row> = {}): Row => ({ id: 'r1', documents: [doc], cells, ...extra });
const kinds = (r: Row, cell: Cell | undefined) => cellTags(r, cell).map((tag) => tag.kind);

describe('cell tags', () => {
    it('shows nothing for an unattempted or failed cell', () => {
        expect(cellTags(row(), undefined)).toEqual([]);
        expect(cellTags(row(), { outcome: 'failed', provenance: 'model', error: 'x', error_code: 'y' } as Cell)).toEqual([]);
        expect(cellState(undefined)).toBe('pending');
    });

    it('gives a model answer one page tag per evidence entry', () => {
        expect(cellTags(row(), modelAnswer())).toEqual([
            { kind: 'page', evidence: 0 },
            { kind: 'page', evidence: 1 },
        ]);
    });

    it('marks a model answer read from a document without evidence as No passage', () => {
        expect(kinds(row(), modelAnswer({ evidence: undefined }))).toEqual(['no_passage']);
    });

    it('never marks a model Not reported as No passage, and shows its closest passages', () => {
        const blank = { outcome: 'not_reported', provenance: 'model', documents: [doc] } as Cell;
        expect(kinds(row(), blank)).toEqual([]);
        expect(kinds(row(), { ...blank, evidence: [evidence(3)] } as Cell)).toEqual(['page']);
        expect(cellState(blank)).toBe('not_reported');
    });

    it('marks answers and blanks from title and abstract as Abstract', () => {
        const fromAbstract = { outcome: 'answered', provenance: 'model', value: { kind: 'text', text: 'x' } } as Cell;
        expect(kinds(row({}, { documents: undefined }), fromAbstract)).toEqual(['abstract']);
        expect(kinds(row({}, { documents: undefined }), { outcome: 'not_reported', provenance: 'model' } as Cell)).toEqual(['abstract']);
    });

    it('puts Out of date first, for a changed question or a changed document', () => {
        expect(kinds(row(), modelAnswer({ stale: true }))).toEqual(['stale', 'page', 'page']);
        expect(cellTags(row(), modelAnswer({ stale: true }))[0]).toEqual({ kind: 'stale', reason: 'question' });
        const moved = row({}, { documents: ['u-OTHER'] });
        expect(cellTags(moved, modelAnswer())[0]).toEqual({ kind: 'stale', reason: 'document' });
    });

    it('marks user cells Edited, without page tags, stale only by their question', () => {
        const user = { outcome: 'answered', provenance: 'user', value: { kind: 'text', text: 'Mine' }, replaced: modelAnswer() } as Cell;
        expect(kinds(row(), user)).toEqual(['edited']);
        expect(kinds(row({}, { documents: ['u-OTHER'] }), user)).toEqual(['edited']);
        expect(kinds(row(), { ...user, stale: true } as Cell)).toEqual(['stale', 'edited']);
        expect(kinds(row(), { outcome: 'not_reported', provenance: 'user' } as Cell)).toEqual(['edited']);
        expect(kinds(row(), { outcome: 'cleared', provenance: 'user' } as Cell)).toEqual(['edited']);
    });

    it('gives system cells no tags', () => {
        expect(cellTags(row(), { outcome: 'answered', provenance: 'system', value: { kind: 'date', value: '2020' } } as Cell)).toEqual([]);
    });

    it('defines each status tag as the design states it', () => {
        expect(tagDefinition({ kind: 'abstract' }, undefined)).toBe('Answered from title and abstract. No full text was read.');
        expect(tagDefinition({ kind: 'no_passage' }, undefined)).toBe('The answer cited no passage. Check it before relying on it.');
        expect(tagDefinition({ kind: 'edited' }, { outcome: 'answered', provenance: 'user' } as Cell)).toBe('You edited this answer. Fills never change it.');
        expect(tagDefinition({ kind: 'stale', reason: 'question' }, modelAnswer())).toMatch(/^The question changed/);
        expect(tagDefinition({ kind: 'stale', reason: 'document' }, modelAnswer())).toMatch(/document changed/);
        expect(tagDefinition({ kind: 'stale', reason: 'question' }, { outcome: 'answered', provenance: 'user' } as Cell)).toBe('The question changed after your edit.');
    });

    it('labels a passage by its page, and passages without pages generically', () => {
        expect(evidenceTagLabel({ page: 13 }, 0, 1)).toBe('p. 14');
        expect(evidenceTagLabel({ page: 13 }, 0, 1, { pageLabel: 'xiv' })).toBe('p. xiv');
        expect(evidenceTagLabel({}, 0, 1, { kind: 'snapshot' })).toBe('Passage');
        expect(evidenceTagLabel({ page: 2 }, 1, 3, { kind: 'epub' })).toBe('Passage 2');
        // A page locator without `page`: the citation's page label.
        expect(evidenceTagLabel({}, 0, 1, { pageLabel: '12' })).toBe('p. 12');
    });
});

const question = (id: string, extra: Partial<Column> = {}): Column => ({ id, header: id, type: 'text', description: `${id}?`, ...extra });
const ref = { id: '_reference', header: 'Reference', type: 'reference', system: true } as Column;
const year = { id: '_year', header: 'Year', type: 'date', system: true } as Column;

describe('columns and rows', () => {
    const spec: TableSpec = {
        id: 't',
        anchor_column_id: '_reference',
        columns: [ref, year, question('a'), question('b'), question('fresh')],
        rows: [
            row({ a: modelAnswer({ stale: true }), b: modelAnswer() }),
            { id: 'r2', documents: ['u-NEW'], cells: { a: modelAnswer(), b: { outcome: 'answered', provenance: 'user', value: { kind: 'text', text: 'x' }, stale: true } as Cell } },
            { id: 'r3', cells: {} },
            { id: 'r4', cells: {}, failure: { code: 'timeout', message: 'Too long.' } },
        ],
    };

    it('splits the paper, the year and the questions', () => {
        const columns = researchColumns(spec);
        expect(columns.paper?.id).toBe('_reference');
        expect(columns.year?.id).toBe('_year');
        expect(columns.questions.map((c) => c.id)).toEqual(['a', 'b', 'fresh']);
    });

    it('counts model answers out of date, with what changed; never user cells', () => {
        expect(columnBadges(spec, spec.columns[2])).toEqual({ newCells: 0, staleCells: 2, staleReason: 'mixed' });
        expect(columnBadges(spec, spec.columns[3])).toEqual({ newCells: 0, staleCells: 0 });
    });

    it('marks a column with nothing written as New, counting what a fill would answer', () => {
        // r4's failure is retryable, so a column fill selects it too.
        expect(columnBadges(spec, spec.columns[4]).newCells).toBe(4);
        expect(newBadgeText(46)).toBe('New column: 46 cells to fill');
        expect(staleBadgeText(2, 'question')).toBe('2 answers are out of date: the question changed after they were written. Fill to update them.');
        expect(staleBadgeText(1, 'document')).toMatch(/^1 answer is out of date: the paper's document changed after it was written/);
    });

    it('calls a row new when no question cell is written and its fill did not fail', () => {
        expect(spec.rows.map((r) => isNewRow(spec, r))).toEqual([false, false, true, false]);
    });
});

describe('inspector content', () => {
    const column = question('a');
    const documents = new Map([[doc, { name: 'Smith_2020.pdf', kind: 'pdf' }]]);

    it('says an unattempted cell is not filled yet', () => {
        expect(inspectorContent(row(), column, documents)).toEqual({ kind: 'pending' });
    });

    it('lays out a model answer: source, reasoning, evidence', () => {
        const content = inspectorContent(row({ a: modelAnswer({ reasoning: 'Because.' }) }), column, documents);
        expect(content.kind).toBe('model');
        if (content.kind !== 'model') return;
        expect(content.answer.sourceLine).toBe('from the PDF');
        expect(content.answer.reasoning).toBe('Because.');
        expect(content.answer.evidence).toHaveLength(2);
        expect(content.answer.stale).toBeUndefined();
    });

    it('says an answer from title and abstract came from there', () => {
        const content = inspectorContent(
            row({ a: { outcome: 'answered', provenance: 'model', value: { kind: 'text', text: 'x' } } as Cell }, { documents: undefined }),
            column,
        );
        expect(content.kind === 'model' && content.answer.sourceLine).toBe('from title and abstract');
    });

    it("shows the user's answer with Beaver's earlier answer from replaced", () => {
        const replaced = modelAnswer({ stale: true }) as never;
        const content = inspectorContent(
            row({ a: { outcome: 'answered', provenance: 'user', value: { kind: 'text', text: 'Mine' }, reasoning: 'Table 3', stale: true, replaced } as Cell }),
            column,
            documents,
        );
        expect(content.kind).toBe('user');
        if (content.kind !== 'user') return;
        expect(content.outcome).toBe('answered');
        expect(content.note).toBe('Table 3');
        expect(content.stale).toBe(true);
        expect(content.replaced?.sourceLine).toBe('from the PDF');
        expect(content.replaced?.evidence).toHaveLength(2);
        expect(content.replaced?.stale).toBe('question');
    });

    it("reads Beaver's earlier answer as stale when the user's cell went stale on the question", () => {
        const content = inspectorContent(
            row({ a: { outcome: 'answered', provenance: 'user', value: { kind: 'text', text: 'Mine' }, stale: true, replaced: modelAnswer() as never } as Cell }),
            column,
            documents,
        );
        expect(content.kind === 'user' && content.replaced?.stale).toBe('question');
    });

    it('handles user Not reported and cleared cells, with or without replaced', () => {
        const notReported = inspectorContent(row({ a: { outcome: 'not_reported', provenance: 'user', reasoning: 'n/a' } as Cell }), column);
        expect(notReported).toMatchObject({ kind: 'user', outcome: 'not_reported', note: 'n/a', stale: false });
        expect(notReported.kind === 'user' && notReported.replaced).toBeUndefined();
        const cleared = inspectorContent(row({ a: { outcome: 'cleared', provenance: 'user', replaced: modelAnswer() as never } as Cell }), column, documents);
        expect(cleared).toMatchObject({ kind: 'user', outcome: 'cleared' });
        expect(cleared.kind === 'user' && cleared.replaced?.outcome).toBe('answered');
    });

    it('reports a failed cell by its message', () => {
        expect(inspectorContent(row({ a: { outcome: 'failed', provenance: 'model', error: 'Nope.', error_code: 'x' } as Cell }), column)).toEqual({ kind: 'failed', message: 'Nope.' });
    });

    it("names the row's document, or says it has none", () => {
        expect(rowDocumentLine(row(), documents)).toBe('Read from Smith_2020.pdf');
        expect(rowDocumentLine(row(), undefined)).toBe('Read from the document');
        expect(rowDocumentLine(row({}, { documents: undefined }))).toMatch(/^No document/);
    });
});

describe('the paper cell', () => {
    it('reads a row without a reference by its anchor value', () => {
        const textRow: Row = { id: 't1', cells: { name: { outcome: 'answered', provenance: 'user', value: { kind: 'text', text: 'Site A' } } as Cell } };
        expect(paperText(textRow, 'name').title).toBe('Site A');
        expect(paperText(textRow).title).toBe('Untitled');
    });
});
