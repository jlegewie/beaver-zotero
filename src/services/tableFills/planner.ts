/**
 * Planning a table fill, without Zotero: which rows' documents to look up,
 * the document rule, the cell selection on the table as the fill will see it,
 * and what each row is answered from.
 *
 * The order is the backend planner's: look up documents for every selected
 * item row, every row with a failure and every row answered from title and
 * abstract that names no document; apply the document rule to a copy of the
 * table; select cells on that copy, so a row that gained a document has its
 * title-and-abstract answers stale and a blocked row whose document was
 * replaced is unblocked; and record the document changes as `update_row`
 * writes that expect the row's previous documents.
 */

import {
    REFERENCE_COLUMN_ID,
    YEAR_COLUMN_ID,
    isTitleAbstractOnly,
    questionHash,
    type Column,
    type Row,
    type TableSpec,
} from '@beaver/agent-core/layouts/table';
import { applyMutations, type UpdateRowMutation } from '@beaver/agent-core/layouts/tableMutations';
import { NO_SOURCE, cellsToFill, selectedColumns, type FillSelection } from '@beaver/agent-core/layouts/tableFill';
import type { TableFillColumn, TableFillDocumentKind, TableFillRequest } from '@beaver/agent-core/protocol/tableFillProtocol';

/** The kinds the document rule picks, in order of preference. */
export const DOCUMENT_KINDS = ['pdf', 'epub', 'snapshot'] as const;
/**
 * The kinds a row may name. Plain text is never picked by the rule but is
 * read when a row already names it.
 */
export type RowDocumentKind = (typeof DOCUMENT_KINDS)[number] | 'text';

/** A kind a row may name: the rule's kinds, and plain text a row already names. */
export function isRowDocumentKind(kind: string | null | undefined): kind is RowDocumentKind {
    return kind === 'text' || (DOCUMENT_KINDS as readonly string[]).includes(kind ?? '');
}

/** A readable document attachment of an item. */
export interface DocumentCandidate {
    /** Portable id (`u-KEY`, `g<id>-KEY`). */
    id: string;
    kind: RowDocumentKind;
    /** Zotero's primary attachment of the item. */
    primary: boolean;
}

/** What Zotero says about an item row, from metadata only. */
export interface RowLookup {
    /** A row failure code when the item cannot be used. */
    error?: string;
    /** The item's readable documents, in attachment order. */
    documents: DocumentCandidate[];
    abstract?: string;
}

/** How a row is answered. */
export type RowMode =
    /** Read from its document. */
    | 'document'
    /** From its title and abstract. */
    | 'metadata'
    /** Neither exists: the row gets `no_source`, with no request. */
    | 'no_input'
    /** The row cannot be filled (its item is gone, its document is gone, an excluded library). */
    | 'unavailable';

export interface RowPlan {
    row: string;
    /** The row's subject, for the exclusion gate before each request. */
    ref?: Row['ref'];
    /** The columns it answers, in table order. */
    columns: string[];
    mode: RowMode;
    /** The document read in document mode; `kind` when the lookup knew it. */
    document?: { id: string; kind?: RowDocumentKind };
    /** The row's documents as planned; every write of the row expects them. */
    documents: string[];
    /** The row failure code an unavailable or no-input row gets. */
    error?: string;
    reference: TableFillRequest['row']['reference'];
    abstract?: string;
}

/** A column as the plan answers it. */
export interface PlannedColumn {
    request: TableFillColumn;
    revision: number;
}

/** A document change planning writes before the fill reads. */
export interface DocumentUpdate {
    row: string;
    documents: string[];
    /** The row's documents in the table planned from, which the update expects. */
    before: string[];
}

export interface PlannedFill {
    rows: RowPlan[];
    columns: PlannedColumn[];
    documentUpdates: DocumentUpdate[];
    cells: number;
}

/**
 * The document rule over an item's readable documents: Zotero's primary
 * attachment first, then a PDF over an EPUB over a snapshot; the first in
 * attachment order wins a tie.
 */
export function bestDocument(candidates: readonly DocumentCandidate[]): string | undefined {
    let best: DocumentCandidate | undefined;
    const rank = (c: DocumentCandidate): [number, number] => [c.primary ? 1 : 0, -DOCUMENT_KINDS.indexOf(c.kind as (typeof DOCUMENT_KINDS)[number])];
    for (const candidate of candidates) {
        if (!(DOCUMENT_KINDS as readonly string[]).includes(candidate.kind)) continue;
        if (!best) {
            best = candidate;
            continue;
        }
        const [p, k] = rank(candidate);
        const [bp, bk] = rank(best);
        if (p > bp || (p === bp && k > bk)) best = candidate;
    }
    return best?.id;
}

/**
 * The item rows whose documents planning checks: rows with cells to fill,
 * rows with a failure (a gone document may have a replacement by now, even
 * for a blocked row), and rows answered from title and abstract that name no
 * document (one may have been attached since). Limited to the named rows when
 * the selection names some.
 */
export function rowsToLookUp(spec: TableSpec, selection: FillSelection, columns: readonly Column[]): Row[] {
    const initial = new Set(cellsToFill(spec, selection).map(([row]) => row));
    const wanted = selection.rows ? new Set(selection.rows) : undefined;
    return spec.rows.filter((row) => {
        if (row.ref?.kind !== 'item') return false;
        if (wanted && !wanted.has(row.id)) return false;
        return (
            initial.has(row.id) ||
            row.failure != null ||
            (!row.documents?.length && columns.some((column) => isTitleAbstractOnly(row.cells[column.id])))
        );
    });
}

/**
 * The documents planning writes, by row. A row that names none gains the one
 * the document rule finds. A row's documents are switched only when the named
 * one no longer exists and another does, so nothing can point at the wrong
 * file; a row whose document is gone with nothing to replace it is left alone.
 */
export function documentChanges(rows: readonly Row[], lookups: ReadonlyMap<string, RowLookup>): Map<string, string[]> {
    const changes = new Map<string, string[]>();
    for (const row of rows) {
        const lookup = lookups.get(row.id);
        if (!lookup || lookup.error) continue;
        // A row naming several documents is never refilled, so none of them
        // is replaced by one.
        if ((row.documents?.length ?? 0) > 1) continue;
        const named = row.documents?.[0];
        if (named !== undefined && lookup.documents.some((d) => d.id === named)) continue;
        const replacement = bestDocument(lookup.documents);
        if (replacement !== undefined) changes.set(row.id, [replacement]);
    }
    return changes;
}

function text(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** The row's bibliographic reference, from its system columns. */
export function rowReference(row: Row): TableFillRequest['row']['reference'] {
    const value = row.cells[REFERENCE_COLUMN_ID]?.value;
    const reference: TableFillRequest['row']['reference'] = {};
    if (value?.kind === 'reference') {
        const title = text(value.title, 1000) ?? text(value.display_name, 1000);
        if (title) reference.title = title;
        const authors = text(value.subtitle, 1000);
        if (authors) reference.authors = authors;
        const venue = text(value.venue, 1000);
        if (venue) reference.venue = venue;
        const itemType = text(value.item_type, 1000);
        if (itemType) reference.item_type = itemType;
    }
    const year = row.cells[YEAR_COLUMN_ID]?.value;
    if (year?.kind === 'date' && year.value) reference.year = year.value.slice(0, 4);
    else if (year?.kind === 'text' && year.text.trim()) reference.year = year.text.trim().slice(0, 1000);
    return reference;
}

/** A column as the endpoint receives it, with its hash as planned. */
export function plannedColumn(column: Column): PlannedColumn {
    const request: TableFillColumn = {
        id: column.id,
        header: column.header.slice(0, 1000),
        type: column.type,
        question_hash: questionHash(column),
    };
    if (column.description) request.description = column.description;
    if (column.options?.length) {
        request.options = column.options.map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
            ...(option.color ? { color: option.color } : {}),
        }));
    }
    return { request, revision: column.revision ?? 0 };
}

const ABSTRACT_MAX_CHARS = 20_000;

/**
 * The plan: the rows and cells a fill works on and what each row is answered
 * from, given the lookups of {@link rowsToLookUp}'s rows. Throws
 * `TableSelectionError` for a row or column the table does not have.
 */
export function buildPlan(
    spec: TableSpec,
    selection: FillSelection,
    lookups: ReadonlyMap<string, RowLookup>,
): PlannedFill {
    const columns = selectedColumns(spec, selection.columns);
    const looked = spec.rows.filter((row) => lookups.has(row.id));
    const changes = documentChanges(looked, lookups);
    const updates: UpdateRowMutation[] = [...changes].map(([row, documents]) => ({
        op: 'update_row',
        row,
        documents,
    }));
    // Selection sees each row with the documents it will be read from, by
    // the same mutation the fill writes.
    let planning = spec;
    if (updates.length) {
        const applied = applyMutations(spec, updates);
        if (applied.ok) planning = applied.spec;
    }
    const cells = cellsToFill(planning, { ...selection, columns: columns.map((c) => c.id) });
    const byRow = new Map<string, string[]>();
    for (const [row, column] of cells) {
        const list = byRow.get(row);
        if (list) list.push(column);
        else byRow.set(row, [column]);
    }
    const before = new Map(spec.rows.map((row) => [row.id, row.documents ?? []]));
    const rows: RowPlan[] = [];
    for (const row of planning.rows) {
        const rowColumns = byRow.get(row.id);
        if (!rowColumns) continue;
        const named = row.documents?.[0];
        const plan: RowPlan = {
            row: row.id,
            ...(row.ref ? { ref: row.ref } : {}),
            columns: rowColumns,
            mode: 'metadata',
            documents: [...(row.documents ?? [])],
            reference: rowReference(row),
        };
        const ref = row.ref;
        if (ref?.kind === 'item') {
            const lookup = lookups.get(row.id);
            if (!lookup) {
                plan.mode = 'unavailable';
                plan.error = 'item_unavailable';
            } else if (lookup.error) {
                plan.mode = 'unavailable';
                plan.error = lookup.error;
            } else if (named !== undefined && !lookup.documents.some((d) => d.id === named)) {
                // The named document is gone and nothing replaces it: the row
                // keeps its cited answers rather than being refilled from its
                // abstract, and the failure is retried on later fills.
                plan.mode = 'unavailable';
                plan.error = 'not_found';
            } else {
                const abstract = text(lookup.abstract, ABSTRACT_MAX_CHARS);
                if (abstract) plan.abstract = abstract;
                if (named !== undefined) {
                    plan.mode = 'document';
                    plan.document = { id: named, kind: lookup.documents.find((d) => d.id === named)?.kind };
                }
            }
        } else if (ref?.kind === 'external') {
            const abstract = text(ref.reference?.abstract, ABSTRACT_MAX_CHARS);
            if (abstract) plan.abstract = abstract;
        }
        // A row that names a document is read from it, whatever its ref (an
        // external work, or no ref at all): answers from anything else would
        // be stale against it at once. Item rows were checked above.
        if (plan.mode === 'metadata' && named !== undefined && ref?.kind !== 'item') {
            plan.mode = 'document';
            plan.document = { id: named };
        }
        // v1 reads one document per row: a row naming several is never sent,
        // since answers read from one would be stale against the others.
        // An item-level failure (gone, excluded) still says more than this.
        if ((before.get(row.id)?.length ?? 0) > 1 && (plan.mode !== 'unavailable' || plan.error === 'not_found')) {
            plan.mode = 'unavailable';
            plan.error = 'multiple_documents';
            delete plan.document;
        }
        if (plan.mode === 'metadata' && !plan.abstract) {
            plan.mode = 'no_input';
            plan.error = NO_SOURCE;
        }
        rows.push(plan);
    }
    return {
        rows,
        columns: columns.map(plannedColumn),
        documentUpdates: [...changes].map(([row, documents]) => ({
            row,
            documents,
            before: [...(before.get(row) ?? [])],
        })),
        cells: rows.reduce((sum, row) => sum + row.columns.length, 0),
    };
}

/** A document's kind for the endpoint, from what the extraction said it is. */
export function requestDocumentKind(kind: string | undefined): TableFillDocumentKind | undefined {
    return kind === 'pdf' || kind === 'epub' || kind === 'snapshot' || kind === 'text' ? kind : undefined;
}

/**
 * The row failure code for a document that could not be read. A missing text
 * layer is a PDF's failure; an EPUB or snapshot without text reads as having
 * no text.
 */
export function readFailureCode(code: string, contentKind: string | undefined): string {
    if (code === 'no_text_layer') return contentKind === 'pdf' || contentKind === undefined ? code : 'no_text';
    if (code === 'repeated_timeout') return 'timeout';
    return code;
}
