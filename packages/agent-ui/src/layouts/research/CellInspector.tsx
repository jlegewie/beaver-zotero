import React, { useLayoutEffect, useRef, useState } from "react";
import type { Column, Row, TableSpec } from "@beaver/agent-core/layouts/table";
import { rowReference } from "@beaver/agent-core/layouts/tableCitations";
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, CancelIcon, EditIcon, FileIcon, Icon } from "../../icons";
import type { MenuItem } from "../../primitives/ContextMenu";
import type { TextRenderer } from "../tableView";
import { selectionWithin } from "../../primitives/HoverLayer";
import { EvidencePassage, StatusTag } from "./CellTags";
import {
    inspectorContent,
    rowDocumentLine,
    tagDefinition,
    type InspectorAnswer,
    type CellFill,
    type InspectorContent,
    type TableDocuments,
} from "./cellModel";
import { CellBody, CellValue, FillNote } from "./ResearchGrid";
import { PaperActions, paperText } from "./PaperCell";

/**
 * The cell's edit controls: `edit` sits beside the answer (the pencil), and
 * `more` under it (Reset to Beaver's answer on the user's answer).
 */
export interface CellActionControls {
    edit?: React.ReactNode;
    more?: React.ReactNode;
}

export interface CellInspectorProps {
    row: Row;
    /** The anchor column, which names a row without a reference. */
    paperColumnId?: string;
    /** The selected question column; absent when the Paper cell is selected. */
    column?: Column;
    /** What a running fill is doing with the selected cell. */
    fill?: CellFill;
    /** The question columns, for the paper view. */
    questions: Column[];
    /** The table, for the row actions it declares (import) in the paper view. */
    table?: TableSpec;
    /** The row's menu, beside its actions in the paper view. */
    rowMenuItems?: MenuItem[];
    /** A row added since the last fill, noted in the paper view. */
    isNew?: boolean;
    /**
     * Opens another cell of the same row: a question from the paper view, or
     * the Paper cell (`paperColumnId`) from the cell view's subtitle.
     */
    onColumn(columnId: string): void;
    /** Previous and next row in the view's order; absent at either end. */
    onPrevious?: () => void;
    onNext?: () => void;
    onClose(): void;
    renderText: TextRenderer;
    documents?: TableDocuments;
    /** The cell's edit controls. Absent in a read-only view. */
    cellActions?: (row: Row, column: Column) => CellActionControls;
    /** Beside the document line (Change). */
    documentAction?: (row: Row) => React.ReactNode;
}

/**
 * "Cell details": the panel beside the grid for the selected cell. A question
 * cell shows the cell view: the question, then what the cell holds (Beaver's
 * answer with its explanation and evidence, or the user's answer with
 * Beaver's earlier one from `replaced`). The Paper cell shows the paper view:
 * the row's actions (with its menu) and every question of the row.
 */
export function CellInspector({
    row,
    paperColumnId,
    column,
    fill,
    questions,
    table,
    rowMenuItems,
    isNew = false,
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
    const documentLine = (
        <div className="rt-inspector-document">
            <Icon icon={FileIcon} size={13} />
            <span className="rt-inspector-document-name">{rowDocumentLine(row, documents)}</span>
            {documentAction?.(row)}
        </div>
    );

    let title: React.ReactNode;
    let subtitle: React.ReactNode = null;
    let body: React.ReactNode;
    if (column) {
        const heading = [
            reference?.display_name ?? paper.title,
            year && !reference?.display_name?.includes(year) ? year : undefined,
        ]
            .filter(Boolean)
            .join(" · ");
        title = column.header;
        subtitle = paperColumnId ? (
            <button
                type="button"
                className="rt-inspector-subtitle rt-inspector-paper-link"
                title={paper.title}
                onClick={() => onColumn(paperColumnId)}
            >
                <span className="rt-inspector-subtitle-text">{heading}</span>
                <Icon icon={ArrowRightIcon} size={11} className="rt-inspector-chevron" />
            </button>
        ) : (
            <span className="rt-inspector-subtitle" title={paper.title}>
                <span className="rt-inspector-subtitle-text">{heading}</span>
            </span>
        );
        // The document line goes under the first Evidence heading; without
        // one it closes the panel.
        const content = inspectorContent(row, column);
        const evidenceAnswer =
            content.kind === "model" ? content.answer : content.kind === "user" ? content.replaced : undefined;
        const documentInEvidence = !!evidenceAnswer && hasEvidenceSection(evidenceAnswer);
        body = (
            <>
                {column.description ? <p className="rt-inspector-text rt-inspector-question">{column.description}</p> : null}
                {fill ? <FillNote fill={fill} replacing={content.kind !== "pending"} /> : null}
                {/* The fill's note says an unfilled cell's answer is coming. */}
                {fill && content.kind === "pending" ? null : (
                    <CellDetails
                        row={row}
                        column={column}
                        content={content}
                        renderText={renderText}
                        documents={documents}
                        actions={content.kind === "system" ? undefined : cellActions?.(row, column)}
                        documentLine={documentInEvidence ? documentLine : undefined}
                    />
                )}
                {row.failure ? (
                    <div className="rt-inspector-failure" role="note">
                        {row.failure.message}
                    </div>
                ) : null}
                {documentInEvidence ? null : documentLine}
            </>
        );
    } else {
        title = paper.title;
        const byline = [reference?.subtitle, year].filter(Boolean).join(" · ");
        subtitle = byline ? (
            <span className="rt-inspector-subtitle">
                <span className="rt-inspector-subtitle-text">{byline}</span>
            </span>
        ) : null;
        body = (
            <PaperDetails
                table={table}
                row={row}
                menuItems={rowMenuItems}
                questions={questions}
                isNew={isNew}
                renderText={renderText}
                documents={documents}
                onColumn={onColumn}
                documentLine={documentLine}
            />
        );
    }

    return (
        <aside
            className="rt-inspector"
            aria-label="Cell details"
            data-view={column ? "cell" : "paper"}
            data-row-id={row.id}
            data-column-id={column?.id ?? paperColumnId}
        >
            <div className="rt-inspector-head">
                <div className="rt-inspector-nav rt-inspector-nav-titled">
                    <div className="rt-inspector-titles">
                        <div className="rt-inspector-title">{title}</div>
                        {subtitle}
                    </div>
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
            </div>
            <div className="rt-inspector-body">{body}</div>
        </aside>
    );
}

/** An answer from the documents that cites no passage: its Evidence section notes it. */
function citesNoPassage(answer: InspectorAnswer): boolean {
    return answer.outcome === "answered" && answer.evidence.length === 0 && (answer.cell.documents?.length ?? 0) > 0;
}

function hasEvidenceSection(answer: InspectorAnswer): boolean {
    return answer.evidence.length > 0 || citesNoPassage(answer);
}

function CellDetails({
    row,
    column,
    content,
    renderText,
    documents,
    actions,
    documentLine,
}: {
    row: Row;
    column: Column;
    content: InspectorContent;
    renderText: TextRenderer;
    documents?: TableDocuments;
    actions?: CellActionControls;
    documentLine?: React.ReactNode;
}): React.ReactElement {
    switch (content.kind) {
        case "pending":
        case "failed":
            return (
                <section className="rt-inspector-section">
                    <div className="rt-inspector-answer-row">
                        {content.kind === "failed" ? (
                            <p className="rt-failed">{content.message}</p>
                        ) : (
                            <p className="rt-inspector-empty">
                                {row.failure
                                    ? "Not answered: the last fill could not read this item."
                                    : "Not filled yet. The next Fill answers it."}
                            </p>
                        )}
                        {actions?.edit}
                    </div>
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
                    edit={actions?.edit}
                    documentLine={documentLine}
                />
            );
        case "user":
            return (
                <>
                    <section className="rt-inspector-section rt-inspector-answer-section">
                        <div className="rt-inspector-heading">
                            <Icon icon={EditIcon} size={12} />
                            <span>Your answer</span>
                        </div>
                        <div className="rt-inspector-answer-row">
                            <div className="rt-inspector-answer">
                                {content.outcome === "answered" ? (
                                    <CellValue cell={content.cell} column={column} renderText={renderText} />
                                ) : (
                                    <span className="rt-muted">
                                        {content.outcome === "not_reported" ? "Not reported" : "Cleared"}
                                    </span>
                                )}
                            </div>
                            {actions?.edit}
                        </div>
                        {content.note ? <p className="rt-inspector-text">{content.note}</p> : null}
                        {content.stale ? (
                            <p className="rt-inspector-stale">
                                {tagDefinition({ kind: "stale", reason: "question" }, content.cell)}
                            </p>
                        ) : null}
                        {actions?.more ? <div className="rt-inspector-links">{actions.more}</div> : null}
                    </section>
                    {content.replaced ? (
                        <AnswerSection
                            row={row}
                            column={column}
                            answer={content.replaced}
                            renderText={renderText}
                            documents={documents}
                            documentLine={documentLine}
                        />
                    ) : null}
                </>
            );
    }
}

/**
 * Beaver's answer: the answer with where it was read from, its explanation,
 * and each passage with its tag under the row's document. On the user's cell
 * it is Beaver's earlier answer, headed "Beaver's answer" and drawn quieter.
 */
function AnswerSection({
    row,
    column,
    answer,
    renderText,
    documents,
    primary = false,
    edit,
    documentLine,
}: {
    row: Row;
    column: Column;
    answer: InspectorAnswer;
    renderText: TextRenderer;
    documents?: TableDocuments;
    primary?: boolean;
    /** The Edit control beside the answer. */
    edit?: React.ReactNode;
    /** The row's document line, under the Evidence heading. */
    documentLine?: React.ReactNode;
}): React.ReactElement {
    const count = answer.evidence.length;
    return (
        <>
            <section className="rt-inspector-section rt-inspector-answer-section">
                {primary ? null : <div className="rt-inspector-heading">Beaver’s answer</div>}
                <div className="rt-inspector-answer-row">
                    <div className="rt-inspector-answer">
                        {answer.outcome === "answered" ? (
                            <CellValue cell={answer.cell} column={column} renderText={renderText} />
                        ) : (
                            <span className="rt-muted">Not reported</span>
                        )}
                    </div>
                    {edit}
                </div>
                {answer.fromAbstract ? (
                    <span className="rt-tags rt-tags-wrap">
                        <StatusTag tag={{ kind: "abstract" }} cell={answer.cell} />
                    </span>
                ) : null}
                {answer.stale ? (
                    <p className="rt-inspector-stale">
                        {primary
                            ? tagDefinition({ kind: "stale", reason: answer.stale }, answer.cell)
                            : // Kept under the user's answer, it is never refilled.
                              answer.stale === "question"
                              ? "The question changed after this answer was written."
                              : "The item's document changed after this answer was written."}
                    </p>
                ) : null}
            </section>
            {answer.reasoning ? (
                <section className="rt-inspector-section">
                    <div className="rt-inspector-heading">Explanation</div>
                    <Explanation key={answer.reasoning}>{renderText(answer.reasoning)}</Explanation>
                </section>
            ) : null}
            {hasEvidenceSection(answer) ? (
                <section className="rt-inspector-section rt-passages">
                    <div className="rt-inspector-heading">
                        <span>{answer.outcome === "not_reported" ? "Closest passages" : "Evidence"}</span>
                        {count ? <span className="rt-inspector-count">{count}</span> : null}
                    </div>
                    {documentLine}
                    {count ? null : (
                        <p className="rt-inspector-stale">{tagDefinition({ kind: "no_passage" }, answer.cell)}</p>
                    )}
                    {answer.evidence.map((entry, index) => (
                        <EvidencePassage
                            key={index}
                            row={row}
                            evidence={entry}
                            index={index}
                            count={count}
                            documents={documents}
                        />
                    ))}
                </section>
            ) : null}
        </>
    );
}

/**
 * The explanation, clamped to three lines with a More / Less toggle when the
 * clamp cuts it. Keyed by its text, so other text starts clamped again.
 */
function Explanation({ children }: { children: React.ReactNode }): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState(false);
    const [cut, setCut] = useState(false);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || expanded) return;
        const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
        measure();
        const Observer = el.ownerDocument.defaultView?.ResizeObserver;
        if (!Observer) return;
        const observer = new Observer(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [expanded]);
    return (
        <>
            <div ref={ref} className={`rt-inspector-text rt-inspector-reasoning${expanded ? "" : " rt-clamp"}`}>
                {children}
            </div>
            {cut || expanded ? (
                <button
                    type="button"
                    className="rt-inspector-link rt-inspector-more"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((open) => !open)}
                >
                    {expanded ? "Less" : "More"}
                </button>
            ) : null}
        </>
    );
}

/**
 * The paper view: the row's actions and menu, its failure or New
 * paper note, every question of the row (each opening its cell), and the
 * document the row is read from.
 */
function PaperDetails({
    table,
    row,
    menuItems,
    questions,
    isNew,
    renderText,
    documents,
    onColumn,
    documentLine,
}: {
    table?: TableSpec;
    row: Row;
    menuItems?: MenuItem[];
    questions: Column[];
    isNew: boolean;
    renderText: TextRenderer;
    documents?: TableDocuments;
    onColumn(columnId: string): void;
    documentLine: React.ReactNode;
}): React.ReactElement {
    return (
        <>
            <PaperActions
                table={table}
                row={row}
                documents={documents}
                menuItems={menuItems}
                className="rt-inspector-row-actions"
                buttonClassName="rt-inspector-action"
            />
            {row.failure ? (
                <div className="rt-inspector-failure" role="note">
                    {row.failure.message}
                </div>
            ) : isNew ? (
                <p className="rt-inspector-note">New item: added since the last fill.</p>
            ) : null}
            <div className="rt-paper-questions">
                {questions.map((column) => {
                    const cell = row.cells[column.id];
                    // A click anywhere on the block opens the cell, as its
                    // heading does; not one on a page chip, nor one that ends
                    // selecting the answer.
                    return (
                        <div
                            key={column.id}
                            className="rt-paper-question"
                            data-column-id={column.id}
                            onClick={(event) => {
                                const target = event.target as Element;
                                if (target.closest?.('button, a, [role="button"]')) return;
                                if (selectionWithin(event.currentTarget)) return;
                                onColumn(column.id);
                            }}
                        >
                            <button type="button" className="rt-paper-question-open" onClick={() => onColumn(column.id)}>
                                <span className="rt-inspector-heading">{column.header}</span>
                                <Icon icon={ArrowRightIcon} size={12} className="rt-inspector-chevron" />
                            </button>
                            <div className="rt-paper-question-value">
                                {cell ? (
                                    <CellBody
                                        row={row}
                                        cell={cell}
                                        column={column}
                                        renderText={renderText}
                                        documents={documents}
                                    />
                                ) : (
                                    // A row whose fill failed is not waiting on
                                    // the next Fill; its failure says why.
                                    <span className="rt-muted">
                                        {row.failure ? "Not answered" : "Not filled yet. The next Fill answers it."}
                                    </span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            {documentLine}
        </>
    );
}
