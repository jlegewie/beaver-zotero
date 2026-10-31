/**
 * What the research table shows for each cell, column and row, as pure rules
 * over the spec: which inline tags a cell carries, the badges on a column
 * header, which rows are new, and what the cell inspector says.
 *
 * Nothing here renders or reads a store. The components in this folder draw
 * these answers; the rules live apart so they can be read and tested whole.
 */

import {
    REFERENCE_COLUMN_ID,
    YEAR_COLUMN_ID,
    anchorColumn,
    isFillableColumn,
    staleReason,
    type AnsweredCell,
    type Cell,
    type Column,
    type Evidence,
    type NotReportedCell,
    type ReplacedCell,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { cellsToFill } from "@beaver/agent-core/layouts/tableFill";

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * What the host found out about one of the table's documents: its file name
 * and kind. A table stores only document ids, so the host looks these up when
 * the table is shown and hands them in; without them the view says "the
 * document" and labels passages without pages generically.
 */
export interface TableDocumentInfo {
    /** The file name, or the attachment's title. */
    name: string;
    /** `pdf`, `epub`, `snapshot`, `text`, …; absent when unknown. */
    kind?: string;
}

export type TableDocuments = ReadonlyMap<string, TableDocumentInfo>;

/** "the PDF", "the EPUB", "the snapshot" or "the document". */
export function documentNoun(kind: string | undefined): string {
    switch (kind) {
        case "pdf":
            return "the PDF";
        case "epub":
            return "the EPUB";
        case "snapshot":
            return "the snapshot";
        default:
            return "the document";
    }
}

/** "PDF", "EPUB", "snapshot" or "document", for a verb ("Open PDF"). */
export function documentKindLabel(kind: string | undefined): string {
    switch (kind) {
        case "pdf":
            return "PDF";
        case "epub":
            return "EPUB";
        case "snapshot":
            return "snapshot";
        default:
            return "document";
    }
}

// ---------------------------------------------------------------------------
// Cell state and tags
// ---------------------------------------------------------------------------

/**
 * What a cell reads as: `pending` (unattempted, shown as "—"), an answer,
 * "Not reported", a cell the user cleared, or a failed answer.
 */
export type CellState =
    | "pending"
    | "answered"
    | "not_reported"
    | "cleared"
    | "failed";

export function cellState(cell: Cell | undefined): CellState {
    if (!cell) return "pending";
    return cell.outcome;
}

/** One inline tag after a cell's text. */
export type CellTag =
    /** An evidence entry: `evidence` indexes `cell.evidence`. */
    | { kind: "page"; evidence: number }
    /** A model answer read from the title and abstract. */
    | { kind: "abstract" }
    /** The question (or, for a model cell, the row's document) changed since. */
    | { kind: "stale"; reason: "question" | "document" }
    /** A user cell. */
    | { kind: "edited" }
    /** A model answer read from a document that cites no passage. */
    | { kind: "no_passage" };

/**
 * The tags a cell shows, in reading order: Out of date, Edited, the page
 * tags, Abstract, No passage.
 *
 * - A model cell shows a page tag per evidence entry. An answer read from a
 *   document with no evidence shows No passage; a blank (Not reported) shows
 *   its closest passages and never No passage.
 * - A model answer or blank read from title and abstract shows Abstract.
 * - A user cell shows Edited and never page tags: its evidence is Beaver's
 *   earlier answer, shown in the inspector.
 * - Out of date follows `staleReason`: a model cell when its question or its
 *   row's document changed, a user cell only when its question changed.
 * - An unattempted or failed cell shows none.
 */
export function cellTags(row: Pick<Row, "documents">, cell: Cell | undefined): CellTag[] {
    if (!cell || cell.outcome === "failed") return [];
    if (cell.provenance === "system") return [];
    const tags: CellTag[] = [];
    const stale = staleReason(row, cell);
    if (stale) tags.push({ kind: "stale", reason: stale });
    if (cell.provenance === "user") {
        tags.push({ kind: "edited" });
        return tags;
    }
    const evidence = cell.evidence ?? [];
    evidence.forEach((_, index) => tags.push({ kind: "page", evidence: index }));
    const fromDocuments = (cell.documents?.length ?? 0) > 0;
    if (!fromDocuments) tags.push({ kind: "abstract" });
    else if (cell.outcome === "answered" && evidence.length === 0)
        tags.push({ kind: "no_passage" });
    return tags;
}

/** The definition a status tag's tooltip gives. */
export function tagDefinition(
    tag: Exclude<CellTag, { kind: "page" }>,
    cell: Cell | undefined,
): string {
    switch (tag.kind) {
        case "abstract":
            return "Answered from title and abstract. No full text was read.";
        case "no_passage":
            return "The answer cited no passage. Check it before relying on it.";
        case "edited":
            if (cell?.outcome === "cleared")
                return "You cleared this cell. Fills never change it.";
            if (cell?.outcome === "not_reported")
                return "You marked this Not reported. Fills never change it.";
            return "You edited this answer. Fills never change it.";
        case "stale":
            if (cell?.provenance === "user")
                return "The question changed after your edit.";
            return tag.reason === "document"
                ? "The paper's document changed after this answer was written. The next Fill updates it."
                : "The question changed after this answer was written. The next Fill updates it.";
    }
}

/**
 * The label of an evidence entry's tag: its page ("p. 14", the printed label
 * when the host knows it) for a passage on a page, else "Passage", numbered
 * when the cell cites several. EPUB and snapshot passages have no pages a
 * reader would recognise.
 */
export function evidenceTagLabel(
    evidence: Pick<Evidence, "page">,
    index: number,
    count: number,
    options: { pageLabel?: string; kind?: string } = {},
): string {
    const paged = options.kind === undefined || options.kind === "pdf";
    // A page locator (`page12`, `s12.2`) gives the citation its page when the
    // entry names none; the caller passes that page's label.
    if (paged && (evidence.page != null || options.pageLabel))
        return `p. ${options.pageLabel || evidence.page! + 1}`;
    return count > 1 ? `Passage ${index + 1}` : "Passage";
}

// ---------------------------------------------------------------------------
// Columns and rows
// ---------------------------------------------------------------------------

/** The columns the research table draws, in order. */
export interface ResearchColumns {
    /** The paper: the anchor (reference) column. */
    paper: Column | undefined;
    /** The year system column, when the table has one. */
    year: Column | undefined;
    /** The question columns: everything else that is not a system column. */
    questions: Column[];
}

export function researchColumns(spec: TableSpec): ResearchColumns {
    const paper =
        spec.columns.find((column) => column.id === REFERENCE_COLUMN_ID) ??
        anchorColumn(spec);
    const year = spec.columns.find((column) => column.id === YEAR_COLUMN_ID);
    const questions = spec.columns.filter(
        (column) => column !== paper && column !== year && !column.system,
    );
    return { paper, year, questions };
}

/** A column's pending-work badges. */
export interface ColumnBadges {
    /**
     * Cells to fill in a column nothing has been written into yet ("New");
     * 0 when the column has answers or nothing to fill.
     */
    newCells: number;
    /** Model answers that are out of date (the "⟳ N" badge). */
    staleCells: number;
    /** What made them so, when there are any. */
    staleReason?: "question" | "document" | "mixed";
}

/**
 * The badges a question column's header carries. "New" on a fillable column
 * with no cell written in any row, counting the cells a fill of the column
 * would answer. The stale count covers model cells only: a user cell is never
 * filled, so its staleness is the cell's own note, not pending work.
 */
export function columnBadges(spec: TableSpec, column: Column): ColumnBadges {
    let written = false;
    let staleCells = 0;
    let question = false;
    let document = false;
    for (const row of spec.rows) {
        const cell = row.cells[column.id];
        if (!cell) continue;
        written = true;
        if (cell.provenance !== "model") continue;
        const reason = staleReason(row, cell);
        if (!reason) continue;
        staleCells += 1;
        if (reason === "question") question = true;
        else document = true;
    }
    const newCells =
        !written && isFillableColumn(column)
            ? cellsToFill(spec, { columns: [column.id] }).length
            : 0;
    return {
        newCells,
        staleCells,
        ...(staleCells
            ? { staleReason: question && document ? "mixed" : question ? "question" : "document" }
            : {}),
    };
}

export function newBadgeText(cells: number): string {
    return `New column: ${cells} ${cells === 1 ? "cell" : "cells"} to fill`;
}

export function staleBadgeText(
    cells: number,
    reason: ColumnBadges["staleReason"],
): string {
    const what =
        reason === "document"
            ? "the paper's document"
            : reason === "mixed"
              ? "the question or the paper's document"
              : "the question";
    return cells === 1
        ? `1 answer is out of date: ${what} changed after it was written. Fill to update it.`
        : `${cells} answers are out of date: ${what} changed after they were written. Fill to update them.`;
}

/**
 * A row added since the last fill: the table has questions and none of them
 * has a cell written in the row (`PendingWork.new_rows`). A row whose fill
 * failed was attempted, so it is not new.
 */
export function isNewRow(spec: TableSpec, row: Row): boolean {
    if (row.failure) return false;
    const fillable = spec.columns.filter(isFillableColumn);
    return fillable.length > 0 && !fillable.some((column) => row.cells[column.id] !== undefined);
}

// ---------------------------------------------------------------------------
// The cell inspector
// ---------------------------------------------------------------------------

/** A model answer or blank as the inspector lays it out. */
export interface InspectorAnswer {
    outcome: "answered" | "not_reported";
    cell: AnsweredCell | NotReportedCell | ReplacedCell;
    /** "from the PDF", "from title and abstract", … */
    sourceLine: string;
    reasoning?: string;
    evidence: Evidence[];
    /** Set when the answer is out of date, and why. */
    stale?: "question" | "document";
}

/** What the inspector says about one cell, by kind. */
export type InspectorContent =
    /** Unattempted. */
    | { kind: "pending" }
    /** A failed answer (kept in the spec; nothing in v1 writes one). */
    | { kind: "failed"; message: string }
    /** Beaver's answer or blank. */
    | { kind: "model"; answer: InspectorAnswer }
    /**
     * The user's answer, "Not reported" or cleared cell, with the note they
     * left and Beaver's earlier answer from `replaced` when there is one.
     */
    | {
          kind: "user";
          outcome: "answered" | "not_reported" | "cleared";
          cell: Cell;
          note?: string;
          /** The question changed after the user's edit. */
          stale: boolean;
          replaced?: InspectorAnswer;
      }
    /** A cell the producer owns (reference, year): not inspected. */
    | { kind: "system"; cell: Cell };

function answerOf(
    row: Pick<Row, "documents">,
    cell: AnsweredCell | NotReportedCell | ReplacedCell,
    documents: TableDocuments | undefined,
): InspectorAnswer {
    const read = cell.documents ?? [];
    const sourceLine = read.length
        ? `from ${documentNoun(documents?.get(read[0])?.kind)}`
        : "from title and abstract";
    const stale = staleReason(row, cell as Cell);
    return {
        outcome: cell.outcome,
        cell,
        sourceLine,
        ...(cell.reasoning ? { reasoning: cell.reasoning } : {}),
        evidence: cell.evidence ?? [],
        ...(stale ? { stale } : {}),
    };
}

export function inspectorContent(
    row: Row,
    column: Column,
    documents?: TableDocuments,
): InspectorContent {
    const cell = row.cells[column.id];
    if (!cell) return { kind: "pending" };
    if (cell.outcome === "failed") return { kind: "failed", message: cell.error };
    if (cell.provenance === "system") return { kind: "system", cell };
    if (cell.provenance === "user") {
        // The question a user cell went stale on is the one its `replaced`
        // answered too; the engine marks both, and a cell written before it
        // did is read the same way.
        const replaced =
            cell.replaced && cell.stale && !cell.replaced.stale
                ? { ...cell.replaced, stale: true as const }
                : cell.replaced;
        // A user cell's own staleness is the question alone; its `replaced`
        // is judged as the model cell it was, against the row's document.
        return {
            kind: "user",
            outcome: cell.outcome,
            cell,
            ...(cell.outcome !== "cleared" && cell.reasoning ? { note: cell.reasoning } : {}),
            stale: !!cell.stale,
            ...(replaced ? { replaced: answerOf(row, replaced, documents) } : {}),
        };
    }
    return { kind: "model", answer: answerOf(row, cell, documents) };
}

/**
 * The inspector's document line: what the row's answers are read from.
 * Undefined name when the host has not looked the document up.
 */
export function rowDocumentLine(
    row: Pick<Row, "documents">,
    documents?: TableDocuments,
): string {
    const id = row.documents?.[0];
    if (!id) return "No document. Answers in this row come from the title and abstract.";
    const info = documents?.get(id);
    return info ? `Read from ${info.name}` : `Read from ${documentNoun(undefined)}`;
}
