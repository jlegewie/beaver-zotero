import React, { useCallback, useMemo, useRef } from "react";
import {
    cellIdFor,
    cellValueText,
    columnAlign,
    selectOption,
    staleReason,
    type Cell,
    type Column,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { Icon, RepeatIcon, TickIcon } from "../../icons";
import type { MenuItem } from "../../primitives/ContextMenu";
import { useHoverAnchor, useHoverLayer } from "../../primitives/HoverLayer";
import type { TextRenderer } from "../tableView";
import type { TableState } from "../useTableState";
import { useRowWindow } from "../useRowWindow";
import { CellTags } from "./CellTags";
import {
    cellState,
    columnBadges,
    isNewRow,
    newBadgeText,
    staleBadgeText,
    type ResearchColumns,
    type TableDocuments,
} from "./cellModel";
import { PaperCell } from "./PaperCell";

/** The cell the inspector is open on. */
export interface CellAddress {
    rowId: string;
    columnId: string;
}

export interface ResearchGridProps {
    table: TableSpec;
    state: TableState;
    columns: ResearchColumns;
    renderText: TextRenderer;
    documents?: TableDocuments;
    selected: CellAddress | null;
    onSelectCell(address: CellAddress): void;
    rowMenuItems(row: Row): MenuItem[];
    /** Window the rows, for a long table. */
    virtualize?: boolean;
    emptyText: string;
    filteredEmptyText: string;
}

/** A question column's width: prose shares what is left; short types are fixed. */
function questionWidth(column: Column): string | undefined {
    if (typeof column.width === "number") return `${column.width}px`;
    switch (column.type) {
        case "select":
            return "11.5rem";
        case "boolean":
            return "8.5rem";
        case "date":
            return "9rem";
        default:
            return undefined;
    }
}

const FLEX_MIN = "18rem";

/**
 * The research table's grid: a selection rail, the paper, the year and one
 * column per question, rows of one height set by the density.
 *
 * Every question cell is a button onto the inspector. Its text is clamped to
 * the row height; when the clamp cuts it, hovering floats the whole cell over
 * the rows below (the peek) and nothing in the grid moves.
 */
export function ResearchGrid({
    table,
    state,
    columns,
    renderText,
    documents,
    selected,
    onSelectCell,
    rowMenuItems,
    virtualize = false,
    emptyText,
    filteredEmptyText,
}: ResearchGridProps): React.ReactElement {
    const rootRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLTableSectionElement>(null);
    const questions = useMemo(
        () => columns.questions.filter((column) => !state.hiddenColumns.has(column.id)),
        [columns.questions, state.hiddenColumns],
    );
    const badges = useMemo(
        () => new Map(questions.map((column) => [column.id, columnBadges(table, column)])),
        [table, questions],
    );
    const newRows = useMemo(
        () => new Set(table.rows.filter((row) => isNewRow(table, row)).map((row) => row.id)),
        [table],
    );
    const rowWindow = useRowWindow({
        enabled: virtualize,
        rows: state.rows,
        expandedRows: EMPTY,
        rootRef,
        bodyRef,
        layoutKey: `${state.density}|${questions.map((column) => column.id).join(",")}`,
    });
    const windowRows = virtualize ? state.rows.slice(rowWindow.start, rowWindow.end) : state.rows;
    const minWidth = `calc(2.75rem + 20rem + ${columns.year ? "4.5rem + " : ""}${questions
        .map((column) => questionWidth(column) ?? FLEX_MIN)
        .join(" + ") || "0px"})`;
    const columnCount = 2 + (columns.year ? 1 : 0) + questions.length;
    const selectable = table.rows.length > 0;

    return (
        <div ref={rootRef} className="rt-grid" data-density={state.density} data-table-id={table.id}>
            <table className="bt-table rt-table" style={{ minWidth }}>
                <colgroup>
                    <col style={{ width: "2.75rem" }} />
                    <col style={{ width: "20rem" }} />
                    {columns.year ? <col style={{ width: "4.5rem" }} /> : null}
                    {questions.map((column) => (
                        <col key={column.id} style={{ width: questionWidth(column) }} />
                    ))}
                </colgroup>
                <thead>
                    <tr className="rt-head-row">
                        <th className="rt-th rt-th-rail" scope="col">
                            {selectable ? (
                                <SelectBox
                                    checked={state.allInViewSelected}
                                    label={state.allInViewSelected ? "Clear selection" : "Select all rows"}
                                    onToggle={state.toggleSelectAll}
                                />
                            ) : null}
                        </th>
                        <th className="rt-th rt-th-paper" scope="col">
                            <span className="rt-th-label">Paper</span>
                        </th>
                        {columns.year ? (
                            <th className="rt-th rt-th-year" scope="col">
                                <span className="rt-th-label">{columns.year.header}</span>
                            </th>
                        ) : null}
                        {questions.map((column) => (
                            <QuestionHeader key={column.id} column={column} badges={badges.get(column.id)!} />
                        ))}
                    </tr>
                </thead>
                <tbody ref={bodyRef}>
                    {rowWindow.padTop > 0 ? <Spacer height={rowWindow.padTop} /> : null}
                    {windowRows.map((row) => (
                        <ResearchRow
                            key={row.id}
                            table={table}
                            row={row}
                            paperColumnId={columns.paper?.id}
                            questions={questions}
                            showYear={!!columns.year}
                            yearColumnId={columns.year?.id}
                            renderText={renderText}
                            documents={documents}
                            isNew={newRows.has(row.id)}
                            isSelected={state.selectedRows.has(row.id)}
                            selectedColumn={selected?.rowId === row.id ? selected.columnId : undefined}
                            onToggleSelect={state.toggleRowSelection}
                            onSelectCell={onSelectCell}
                            menuItems={rowMenuItems}
                        />
                    ))}
                    {rowWindow.padBottom > 0 ? <Spacer height={rowWindow.padBottom} /> : null}
                    {state.rows.length === 0 ? (
                        <tr>
                            <SpanningCell colSpan={columnCount} className="rt-empty">
                                {table.rows.length === 0 ? emptyText : filteredEmptyText}
                            </SpanningCell>
                        </tr>
                    ) : null}
                </tbody>
            </table>
        </div>
    );
}

const EMPTY: ReadonlySet<string> = new Set();

function Spacer({ height }: { height: number }): React.ReactElement {
    return (
        <tr className="bt-spacer-row" aria-hidden="true" style={{ height }}>
            <td />
        </tr>
    );
}

/**
 * A `<td>` spanning columns, its `colspan` set through the IDL property: the
 * separate Beaver window is XHTML, where React's `colSpan` attribute is not
 * the `colspan` the table reads.
 */
function SpanningCell({
    colSpan,
    className,
    children,
}: {
    colSpan: number;
    className?: string;
    children: React.ReactNode;
}): React.ReactElement {
    const ref = useCallback(
        (el: HTMLTableCellElement | null) => {
            if (el) el.colSpan = colSpan;
        },
        [colSpan],
    );
    return (
        <td ref={ref} className={className}>
            {children}
        </td>
    );
}

function SelectBox({
    checked,
    label,
    onToggle,
}: {
    checked: boolean;
    label: string;
    onToggle(): void;
}): React.ReactElement {
    return (
        <button
            type="button"
            className={`rt-checkbox${checked ? " rt-checked" : ""}`}
            role="checkbox"
            aria-checked={checked}
            aria-label={label}
            onClick={(event) => {
                event.stopPropagation();
                onToggle();
            }}
        >
            <Icon icon={TickIcon} size={10} />
        </button>
    );
}

/** A question column's header: its name and badges over its question. */
function QuestionHeader({
    column,
    badges,
}: {
    column: Column;
    badges: ReturnType<typeof columnBadges>;
}): React.ReactElement {
    return (
        <th className="rt-th rt-th-question" scope="col" data-column-id={column.id}>
            <div className="rt-th-top">
                <span className="rt-th-label">{column.header}</span>
                {badges.staleCells > 0 ? (
                    <Badge
                        className="rt-badge rt-badge-stale"
                        text={staleBadgeText(badges.staleCells, badges.staleReason)}
                    >
                        <Icon icon={RepeatIcon} size={10} />
                        {badges.staleCells}
                    </Badge>
                ) : null}
                {badges.newCells > 0 ? (
                    <Badge className="rt-badge rt-badge-new" text={newBadgeText(badges.newCells)}>
                        New
                    </Badge>
                ) : null}
            </div>
            {column.description ? (
                <div className="rt-th-question-text" title={column.description}>
                    {column.description}
                </div>
            ) : null}
        </th>
    );
}

function Badge({
    className,
    text,
    children,
}: {
    className: string;
    text: string;
    children: React.ReactNode;
}): React.ReactElement {
    const hover = useHoverAnchor({ slot: "card", variant: "tip", width: 260, render: () => text });
    return (
        <span className={className} tabIndex={0} aria-label={text} {...hover}>
            {children}
        </span>
    );
}

interface ResearchRowProps {
    table: TableSpec;
    row: Row;
    paperColumnId?: string;
    questions: Column[];
    showYear: boolean;
    yearColumnId?: string;
    renderText: TextRenderer;
    documents?: TableDocuments;
    isNew: boolean;
    isSelected: boolean;
    selectedColumn?: string;
    onToggleSelect(rowId: string): void;
    onSelectCell(address: CellAddress): void;
    menuItems(row: Row): MenuItem[];
}

const ResearchRow = React.memo(function ResearchRow({
    table,
    row,
    paperColumnId,
    questions,
    showYear,
    yearColumnId,
    renderText,
    documents,
    isNew,
    isSelected,
    selectedColumn,
    onToggleSelect,
    onSelectCell,
    menuItems,
}: ResearchRowProps): React.ReactElement {
    return (
        <tr
            className={["rt-row", isSelected ? "rt-row-selected" : "", row.failure ? "rt-row-failed" : ""]
                .filter(Boolean)
                .join(" ")}
            data-row-id={row.id}
        >
            <td className="rt-td rt-td-rail">
                <span className={`rt-rail${isSelected ? " rt-rail-on" : ""}`}>
                    <SelectBox
                        checked={isSelected}
                        label={isSelected ? "Deselect row" : "Select row"}
                        onToggle={() => onToggleSelect(row.id)}
                    />
                </span>
            </td>
            <td className="rt-td rt-td-paper">
                <PaperCell table={table} row={row} anchorColumnId={paperColumnId} isNew={isNew} documents={documents} menuItems={menuItems(row)} />
            </td>
            {showYear ? (
                <td className="rt-td rt-td-year">
                    {cellValueText(yearColumnId ? row.cells[yearColumnId]?.value : undefined)}
                </td>
            ) : null}
            {questions.map((column) => (
                <QuestionCell
                    key={column.id}
                    row={row}
                    column={column}
                    renderText={renderText}
                    documents={documents}
                    selected={selectedColumn === column.id}
                    onSelect={onSelectCell}
                />
            ))}
        </tr>
    );
});

/** A cell's value as the grid draws it: prose, a Choice pill, Yes / No or a date. */
export function CellValue({
    cell,
    column,
    renderText,
}: {
    cell: Cell | undefined;
    column: Column;
    renderText: TextRenderer;
}): React.ReactElement | null {
    const value = cell?.value;
    if (!value) return null;
    switch (value.kind) {
        case "select": {
            const option = selectOption(column, value.label);
            return (
                <span
                    className={`bt-pill bt-pill-${option?.color ?? "gray"}`}
                    title={option?.description || undefined}
                >
                    {value.label}
                </span>
            );
        }
        case "boolean":
            return <span className="rt-bool">{value.value ? "Yes" : "No"}</span>;
        case "text":
            return <>{renderText(value.text)}</>;
        default:
            return <>{cellValueText(value)}</>;
    }
}

/**
 * The cell's body: the answer (or "Not reported", the pending "—", a cleared
 * or failed cell) followed by its tags. `full` drops the clamp, for the peek
 * and the inspector's whole-paper list.
 */
export function CellBody({
    row,
    cell,
    column,
    renderText,
    documents,
    full = false,
}: {
    row: Row;
    cell: Cell | undefined;
    column: Column;
    renderText: TextRenderer;
    documents?: TableDocuments;
    full?: boolean;
}): React.ReactElement {
    const state = cellState(cell);
    const stale = !!staleReason(row, cell);
    let text: React.ReactNode;
    switch (state) {
        case "pending":
            text = <span className="rt-pending">—</span>;
            break;
        case "not_reported":
            text = <span className="rt-muted">Not reported</span>;
            break;
        case "cleared":
            text = <span className="rt-muted">Cleared</span>;
            break;
        case "failed":
            text = <span className="rt-failed">{cell?.outcome === "failed" ? cell.error : ""}</span>;
            break;
        default:
            text =
                column.type === "select" ? (
                    <CellValue cell={cell} column={column} renderText={renderText} />
                ) : (
                    <div className={`rt-text${full ? "" : " rt-clamp"}${stale ? " rt-stale-text" : ""}`}>
                        <CellValue cell={cell} column={column} renderText={renderText} />
                    </div>
                );
    }
    return (
        <>
            {text}
            <CellTags row={row} cell={cell} documents={documents} className={full ? "rt-tags-wrap" : undefined} />
        </>
    );
}

/** Whether the clamp cut the cell's text or its tags. */
function isTruncated(anchor: HTMLElement): boolean {
    const text = anchor.querySelector<HTMLElement>(".rt-clamp");
    const tags = anchor.querySelector<HTMLElement>(".rt-tags");
    return (
        (!!text && text.scrollHeight > text.clientHeight + 1) ||
        (!!tags && tags.scrollWidth > tags.clientWidth + 1)
    );
}

function QuestionCell({
    row,
    column,
    renderText,
    documents,
    selected,
    onSelect,
}: {
    row: Row;
    column: Column;
    renderText: TextRenderer;
    documents?: TableDocuments;
    selected: boolean;
    onSelect(address: CellAddress): void;
}): React.ReactElement {
    const cell = row.cells[column.id];
    const select = () => onSelect({ rowId: row.id, columnId: column.id });
    const layers = useHoverLayer();
    const peek = useHoverAnchor({
        slot: "peek",
        variant: "peek",
        delayMs: 450,
        shouldOpen: isTruncated,
        render: () => (
            <div
                className="rt-peek"
                role="button"
                tabIndex={-1}
                onClick={() => {
                    // The inspector narrows the grid: the peek would float over
                    // where the cell was.
                    layers?.hide();
                    select();
                }}
            >
                <div className="rt-peek-body">
                    <CellBody row={row} cell={cell} column={column} renderText={renderText} documents={documents} full />
                </div>
                <div className="rt-peek-footer">Click for evidence</div>
            </div>
        ),
    });
    return (
        <td
            id={cellIdFor(row.id, column.id)}
            className={[
                "rt-td",
                "rt-cell",
                `rt-kind-${column.type}`,
                `bt-align-${columnAlign(column)}`,
                selected ? "rt-cell-selected" : "",
            ]
                .filter(Boolean)
                .join(" ")}
            data-column-id={column.id}
            data-cell-state={cellState(cell)}
            tabIndex={0}
            aria-label={`${column.header}: open details`}
            onClick={select}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select();
                }
            }}
            onMouseEnter={peek.onMouseEnter}
            onMouseLeave={peek.onMouseLeave}
            onMouseDown={peek.onMouseDown}
        >
            <div className="rt-cell-body">
                <CellBody row={row} cell={cell} column={column} renderText={renderText} documents={documents} />
            </div>
        </td>
    );
}
