import React from "react";
import type { Column, Row } from "@beaver/agent-core/layouts/table";
import { rowReference } from "@beaver/agent-core/layouts/tableCitations";
import { ArrowDownIcon, ArrowUpIcon, CancelIcon, EditIcon, FileIcon, Icon } from "../../icons";
import type { TextRenderer } from "../tableView";
import { EvidencePassage } from "./CellTags";
import {
    inspectorContent,
    rowDocumentLine,
    tagDefinition,
    type InspectorAnswer,
    type TableDocuments,
} from "./cellModel";
import { CellBody, CellValue } from "./ResearchGrid";
import { paperText } from "./PaperCell";

/** Which view of the row the inspector shows. */
export type InspectorView = "cell" | "paper";

export interface CellInspectorProps {
    row: Row;
    /** The anchor column, which names a row without a reference. */
    paperColumnId?: string;
    column: Column;
    /** The question columns, for the whole-paper view. */
    questions: Column[];
    view: InspectorView;
    onView(view: InspectorView): void;
    /** Opens another column of the same row (from the whole-paper view). */
    onColumn(columnId: string): void;
    /** Previous and next row in the view's order; absent at either end. */
    onPrevious?: () => void;
    onNext?: () => void;
    onClose(): void;
    renderText: TextRenderer;
    documents?: TableDocuments;
    /**
     * Controls under the cell's answer (Edit; on the user's answer also Clear
     * and Restore Beaver's answer) and beside the document line (Change).
     * Absent in a read-only view.
     */
    cellActions?: (row: Row, column: Column) => React.ReactNode;
    documentAction?: (row: Row) => React.ReactNode;
}

/**
 * "Cell details": the panel beside the grid for the cell the user clicked.
 * It names the paper, the column and its question, then what the cell holds:
 * Beaver's answer with its reasoning and evidence, or the user's answer with
 * Beaver's earlier one from `replaced`; and last, the document the row is
 * read from. The whole-paper view lists every question of the row.
 */
export function CellInspector({
    row,
    paperColumnId,
    column,
    questions,
    view,
    onView,
    onColumn,
    onPrevious,
    onNext,
    onClose,
    renderText,
    documents,
    cellActions,
    documentAction,
}: CellInspectorProps): React.ReactElement {
    const reference = rowReference(row);
    const paper = paperText(row, paperColumnId);
    const year = paper.year;
    const heading = [reference?.display_name ?? paper.title, year && !reference?.display_name?.includes(year) ? year : undefined]
        .filter(Boolean)
        .join(" · ");
    return (
        <aside className="rt-inspector" aria-label="Cell details" data-row-id={row.id} data-column-id={column.id}>
            <div className="rt-inspector-head">
                <div className="rt-inspector-nav">
                    <span className="rt-inspector-paper" title={paper.title}>
                        {heading}
                    </span>
                    <button
                        type="button"
                        className="rt-icon-button"
                        aria-label="Previous row"
                        disabled={!onPrevious}
                        onClick={onPrevious}
                    >
                        <Icon icon={ArrowUpIcon} size={14} />
                    </button>
                    <button
                        type="button"
                        className="rt-icon-button"
                        aria-label="Next row"
                        disabled={!onNext}
                        onClick={onNext}
                    >
                        <Icon icon={ArrowDownIcon} size={14} />
                    </button>
                    <button type="button" className="rt-icon-button" aria-label="Close details" onClick={onClose}>
                        <Icon icon={CancelIcon} size={14} />
                    </button>
                </div>
                <div className="rt-segmented" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={view === "cell"}
                        className={view === "cell" ? "rt-active" : ""}
                        onClick={() => onView("cell")}
                    >
                        {column.header}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={view === "paper"}
                        className={view === "paper" ? "rt-active" : ""}
                        onClick={() => onView("paper")}
                    >
                        Whole paper
                    </button>
                </div>
                {view === "cell" && column.description ? (
                    <p className="rt-inspector-question">{column.description}</p>
                ) : null}
            </div>
            <div className="rt-inspector-body">
                {view === "cell" ? (
                    <CellDetails
                        row={row}
                        column={column}
                        renderText={renderText}
                        documents={documents}
                        cellActions={cellActions}
                    />
                ) : (
                    <WholePaper
                        row={row}
                        questions={questions}
                        renderText={renderText}
                        documents={documents}
                        onColumn={onColumn}
                    />
                )}
                {row.failure ? (
                    <div className="rt-inspector-failure" role="note">
                        {row.failure.message}
                    </div>
                ) : null}
                <div className="rt-inspector-document">
                    <Icon icon={FileIcon} size={13} />
                    <span className="rt-inspector-document-name">{rowDocumentLine(row, documents)}</span>
                    {documentAction?.(row)}
                </div>
            </div>
        </aside>
    );
}

function CellDetails({
    row,
    column,
    renderText,
    documents,
    cellActions,
}: {
    row: Row;
    column: Column;
    renderText: TextRenderer;
    documents?: TableDocuments;
    cellActions?: (row: Row, column: Column) => React.ReactNode;
}): React.ReactElement {
    const content = inspectorContent(row, column, documents);
    const actions = content.kind === "system" ? null : cellActions?.(row, column);
    const actionRow = actions ? <div className="rt-inspector-actions">{actions}</div> : null;
    switch (content.kind) {
        case "pending":
            return (
                <section className="rt-inspector-section">
                    <p className="rt-inspector-empty">
                        {row.failure
                            ? "Not answered: the last fill could not read this paper."
                            : "Not filled yet. The next Fill answers it."}
                    </p>
                    {actionRow}
                </section>
            );
        case "failed":
            return (
                <section className="rt-inspector-section">
                    <p className="rt-failed">{content.message}</p>
                    {actionRow}
                </section>
            );
        case "system":
            return (
                <section className="rt-inspector-section">
                    <CellValue cell={content.cell} column={column} renderText={renderText} />
                </section>
            );
        case "model":
            return (
                <AnswerSection
                    row={row}
                    column={column}
                    answer={content.answer}
                    renderText={renderText}
                    documents={documents}
                    primary
                    actions={actionRow}
                />
            );
        case "user": {
            return (
                <>
                    <section className="rt-inspector-section">
                        <div className="rt-section-label">
                            <Icon icon={EditIcon} size={12} />
                            <span>Your answer</span>
                        </div>
                        <div className="rt-inspector-answer">
                            {content.outcome === "answered" ? (
                                <CellValue cell={content.cell} column={column} renderText={renderText} />
                            ) : (
                                <span className="rt-muted">
                                    {content.outcome === "not_reported" ? "Not reported" : "Cleared"}
                                </span>
                            )}
                        </div>
                        {content.note ? <p className="rt-inspector-note">{content.note}</p> : null}
                        {content.stale ? (
                            <p className="rt-inspector-stale">
                                {tagDefinition({ kind: "stale", reason: "question" }, content.cell)}
                            </p>
                        ) : null}
                        {actionRow}
                    </section>
                    {content.replaced ? (
                        <AnswerSection
                            row={row}
                            column={column}
                            answer={content.replaced}
                            renderText={renderText}
                            documents={documents}
                        />
                    ) : null}
                </>
            );
        }
    }
}

/**
 * Beaver's answer: where it was read from, the answer, its reasoning and each
 * passage with its tag. The user's cell shows Beaver's earlier answer in the
 * same form, set apart as a card.
 */
function AnswerSection({
    row,
    column,
    answer,
    renderText,
    documents,
    primary = false,
    actions,
}: {
    row: Row;
    column: Column;
    answer: InspectorAnswer;
    renderText: TextRenderer;
    documents?: TableDocuments;
    primary?: boolean;
    /** Controls under the answer (Edit). */
    actions?: React.ReactNode;
}): React.ReactElement {
    const heading = answer.outcome === "not_reported" ? "Closest passages" : "Evidence";
    return (
        <section className={`rt-inspector-section${primary ? "" : " rt-inspector-card"}`}>
            <div className="rt-section-label">
                <span className="rt-section-title">Beaver answered</span>
                <span className="rt-section-source">{answer.sourceLine}</span>
            </div>
            <div className="rt-inspector-answer">
                {answer.outcome === "answered" ? (
                    <CellValue cell={answer.cell} column={column} renderText={renderText} />
                ) : (
                    <span className="rt-muted">Not reported</span>
                )}
            </div>
            {answer.stale ? (
                <p className="rt-inspector-stale">
                    {primary
                        ? tagDefinition({ kind: "stale", reason: answer.stale }, answer.cell)
                        : // Kept under the user's answer, it is never refilled.
                          answer.stale === "question"
                          ? "The question changed after this answer was written."
                          : "The paper's document changed after this answer was written."}
                </p>
            ) : null}
            {actions}
            {answer.reasoning ? <div className="rt-inspector-reasoning">{renderText(answer.reasoning)}</div> : null}
            {answer.evidence.length ? (
                <div className="rt-passages">
                    <div className="rt-passages-label">{heading}</div>
                    {answer.evidence.map((entry, index) => (
                        <EvidencePassage
                            key={index}
                            row={row}
                            evidence={entry}
                            index={index}
                            count={answer.evidence.length}
                            documents={documents}
                        />
                    ))}
                </div>
            ) : answer.outcome === "answered" && (answer.cell.documents?.length ?? 0) > 0 ? (
                <p className="rt-inspector-stale">
                    {tagDefinition({ kind: "no_passage" }, answer.cell)}
                </p>
            ) : null}
        </section>
    );
}

/** Every question of the row, each opening its own cell. */
function WholePaper({
    row,
    questions,
    renderText,
    documents,
    onColumn,
}: {
    row: Row;
    questions: Column[];
    renderText: TextRenderer;
    documents?: TableDocuments;
    onColumn(columnId: string): void;
}): React.ReactElement {
    return (
        <div className="rt-whole-paper">
            {questions.map((column) => (
                <div
                    key={column.id}
                    className="rt-whole-paper-entry"
                    role="button"
                    tabIndex={0}
                    onClick={() => onColumn(column.id)}
                    onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onColumn(column.id);
                        }
                    }}
                >
                    <div className="rt-whole-paper-header">{column.header}</div>
                    <div className="rt-whole-paper-value">
                        <CellBody
                            row={row}
                            cell={row.cells[column.id]}
                            column={column}
                            renderText={renderText}
                            documents={documents}
                            full
                        />
                    </div>
                </div>
            ))}
        </div>
    );
}
