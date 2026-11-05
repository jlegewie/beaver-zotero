import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { ArrowDownIcon, CancelIcon, EditIcon, Icon, PlusSignIcon, RepeatIcon, TickIcon } from "../../icons";
import type { MenuItem } from "../../primitives/ContextMenu";
import MenuButton from "../../primitives/MenuButton";
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
import { PaperActions, PaperCell } from "./PaperCell";

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
    /** A question column's menu (on hover over its header). */
    columnMenuItems?(column: Column): MenuItem[];
    /** The (+) after the last column; absent, no add column. */
    onAddColumn?(): void;
    /** Why the (+) is disabled (a read-only library). */
    editDisabledReason?: string;
    /** Window the rows, for a long table. */
    virtualize?: boolean;
    emptyText: string;
    filteredEmptyText: string;
    /**
     * Opens the cell editor: the Edit in a cell's expansion. Absent, cells
     * are not editable here.
     */
    onEditCell?(address: CellAddress): void;
    /** Why cells cannot be edited (a read-only library); the Edit shows it. */
    cellEditDisabledReason?: string;
    /** The open cell editor, floated over its cell and the rows below. */
    cellEditor?: { address: CellAddress; content: React.ReactNode; list: boolean } | null;
}

/** A question column's width: prose shares what is left; short types are fixed. */
function questionWidth(column: Column): string | undefined {
    if (typeof column.width === "number") return `${column.width}px`;
    switch (column.type) {
        case "select":
            return "11.5rem";
        case "boolean":
            return "8.5rem";
        default:
            return undefined;
    }
}

const FLEX_MIN = "18rem";

/**
 * The research table's grid: a selection rail, the paper, the year and one
 * column per question, rows of one height set by the density.
 *
 * Every question cell, and the Paper cell when the table has a paper column,
 * is a button onto the inspector. Its text is clamped to the row height.
 * Hovering any of them floats the whole cell over the rows below (the peek,
 * its expansion), with the cell's actions in its footer; nothing in the grid
 * moves.
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
    columnMenuItems,
    onAddColumn,
    editDisabledReason,
    virtualize = false,
    emptyText,
    filteredEmptyText,
    onEditCell,
    cellEditDisabledReason,
    cellEditor,
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
        rootRef,
        bodyRef,
        layoutKey: `${state.density}|${questions.map((column) => column.id).join(",")}`,
    });
    const windowRows = virtualize ? state.rows.slice(rowWindow.start, rowWindow.end) : state.rows;
    const addColumn = !!onAddColumn;
    const minWidth = `calc(2.75rem + 20rem + ${columns.year ? "4.5rem + " : ""}${addColumn ? `${ADD_WIDTH} + ` : ""}${questions
        .map((column) => questionWidth(column) ?? FLEX_MIN)
        .join(" + ") || "0px"})`;
    const columnCount = 2 + (columns.year ? 1 : 0) + questions.length + (addColumn ? 1 : 0);
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
                    {addColumn ? <col style={{ width: ADD_WIDTH }} /> : null}
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
                            <QuestionHeader
                                key={column.id}
                                column={column}
                                badges={badges.get(column.id)!}
                                menuItems={columnMenuItems}
                            />
                        ))}
                        {addColumn ? (
                            <th className="rt-th rt-th-add" scope="col">
                                <button
                                    type="button"
                                    className="rt-icon-button rt-add-column"
                                    aria-label="Add column"
                                    title={editDisabledReason ?? "Add column"}
                                    disabled={!!editDisabledReason}
                                    onClick={onAddColumn}
                                >
                                    <Icon icon={PlusSignIcon} size={14} />
                                </button>
                            </th>
                        ) : null}
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
                            addColumn={addColumn}
                            onEditCell={onEditCell}
                            editDisabledReason={cellEditDisabledReason}
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
            {cellEditor ? <CellEditorLayer rootRef={rootRef} {...cellEditor} /> : null}
        </div>
    );
}

/**
 * The cell editor, floated over the grid at its cell: a text editor covers
 * the cell and grows over the rows below; an option list opens under the
 * cell's first line. Placed within the grid, so it scrolls with the rows.
 * The cell itself clips its content, so the editor cannot live inside it.
 */
function CellEditorLayer({
    rootRef,
    address,
    content,
    list,
}: {
    rootRef: React.RefObject<HTMLDivElement>;
    address: CellAddress;
    content: React.ReactNode;
    list: boolean;
}): React.ReactElement | null {
    const [place, setPlace] = useState<{ top: number; left: number; width: number } | null>(null);
    // A windowed row scrolled into view is drawn a frame or two later.
    const [attempt, setAttempt] = useState(0);
    useLayoutEffect(() => {
        const root = rootRef.current;
        const id = cellIdFor(address.rowId, address.columnId).replace(/["\\]/g, "\\$&");
        const cell = root?.querySelector<HTMLElement>(`[id="${id}"]`);
        if (!root || !cell) {
            setPlace(null);
            if (!root || attempt >= 5) return;
            const frame = root.ownerDocument.defaultView?.requestAnimationFrame(() => setAttempt((n) => n + 1));
            return () => {
                if (frame != null) root.ownerDocument.defaultView?.cancelAnimationFrame(frame);
            };
        }
        const rootBox = root.getBoundingClientRect();
        const box = cell.getBoundingClientRect();
        setPlace({
            top: box.top - rootBox.top + (list ? Math.min(box.height, 40) : 0),
            left: box.left - rootBox.left,
            width: box.width,
        });
    }, [rootRef, address.rowId, address.columnId, list, attempt]);
    if (!place) return null;
    return (
        <div
            className={`rt-cell-editor-layer${list ? " rt-cell-editor-layer-list" : ""}`}
            style={{ top: place.top, left: place.left, width: list ? undefined : place.width, minWidth: list ? undefined : 320 }}
        >
            {content}
        </div>
    );
}

const ADD_WIDTH = "3.25rem";

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

/**
 * A question column's header: its name and badges over its question, and the
 * column menu's button on hover.
 */
function QuestionHeader({
    column,
    badges,
    menuItems,
}: {
    column: Column;
    badges: ReturnType<typeof columnBadges>;
    menuItems?(column: Column): MenuItem[];
}): React.ReactElement {
    // The menu renders inside this sticky cell, which stacks on its own: while
    // it is open the cell is raised over its neighbours, or the next header
    // would paint over the menu and take its clicks.
    const [menuOpen, setMenuOpen] = React.useState(false);
    return (
        <th
            className={`rt-th rt-th-question${menuOpen ? " rt-th-menu-open" : ""}`}
            scope="col"
            data-column-id={column.id}
        >
            {menuItems ? (
                <span className="rt-column-menu">
                    <MenuButton
                        menuItems={menuItems(column)}
                        variant="ghost-secondary"
                        icon={ArrowDownIcon}
                        ariaLabel={`Column menu: ${column.header}`}
                        width="13rem"
                        toggleCallback={setMenuOpen}
                    />
                </span>
            ) : null}
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
    addColumn: boolean;
    onEditCell?(address: CellAddress): void;
    editDisabledReason?: string;
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
    addColumn,
    onEditCell,
    editDisabledReason,
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
            <PaperGridCell
                table={table}
                row={row}
                paperColumnId={paperColumnId}
                isNew={isNew}
                documents={documents}
                selected={!!paperColumnId && selectedColumn === paperColumnId}
                onSelect={onSelectCell}
                menuItems={menuItems}
            />
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
                    onEdit={onEditCell}
                    editDisabledReason={editDisabledReason}
                />
            ))}
            {addColumn ? <td className="rt-td rt-td-add" aria-hidden="true" /> : null}
        </tr>
    );
});

/**
 * The Paper cell. With a paper column it opens the row's paper view (click,
 * Enter or Space); without one it is not selectable. Hovering shows its
 * expansion: the full title, authors, year and venue, with the row's actions
 * in the footer.
 */
function PaperGridCell({
    table,
    row,
    paperColumnId,
    isNew,
    documents,
    selected,
    onSelect,
    menuItems,
}: {
    table: TableSpec;
    row: Row;
    paperColumnId?: string;
    isNew: boolean;
    documents?: TableDocuments;
    selected: boolean;
    onSelect(address: CellAddress): void;
    menuItems(row: Row): MenuItem[];
}): React.ReactElement {
    const select = paperColumnId ? () => onSelect({ rowId: row.id, columnId: paperColumnId }) : undefined;
    const anchor = useCellPeek((hide) => (
        <CellPeek
            onSelect={select}
            hide={hide}
            footer={
                <PaperActions
                    table={table}
                    row={row}
                    documents={documents}
                    menuItems={menuItems(row)}
                    onAction={hide}
                    className="rt-peek-footer"
                    buttonClassName="rt-peek-action"
                />
            }
        >
            <PaperCell row={row} anchorColumnId={paperColumnId} isNew={isNew} full />
        </CellPeek>
    ));
    return (
        <td
            className={["rt-td", "rt-td-paper", select ? "rt-td-selectable" : "", selected ? "rt-cell-selected" : ""]
                .filter(Boolean)
                .join(" ")}
            data-column-id={paperColumnId}
            tabIndex={select ? 0 : undefined}
            onClick={select}
            onKeyDown={select ? (event) => onCellKey(event, select) : undefined}
            {...anchor}
        >
            <PaperCell row={row} anchorColumnId={paperColumnId} isNew={isNew} />
        </td>
    );
}

/**
 * A grid cell's expansion, opened by hovering the cell: what `render` draws,
 * given `hide` to close it. Returns the handlers to spread on the cell.
 */
function useCellPeek(
    render: (hide: () => void) => React.ReactNode,
): Pick<ReturnType<typeof useHoverAnchor>, "onMouseEnter" | "onMouseLeave" | "onMouseDown"> {
    const layers = useHoverLayer();
    const hide = () => layers?.hide();
    const { onMouseEnter, onMouseLeave, onMouseDown } = useHoverAnchor({
        slot: "peek",
        variant: "peek",
        delayMs: 450,
        render: () => render(hide),
    });
    return { onMouseEnter, onMouseLeave, onMouseDown };
}

/** Enter or Space on the cell itself (not a control in it) selects it. */
function onCellKey(event: React.KeyboardEvent<HTMLElement>, select: () => void): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
    }
}

/**
 * A cell's expansion: its whole content, and its actions in a footer. A click
 * on the content selects the cell, as a click on the cell does; the
 * expansion closes first, since the inspector narrows the grid and the peek
 * would float over where the cell was.
 */
function CellPeek({
    onSelect,
    hide,
    align = "start",
    footer,
    children,
}: {
    onSelect?: () => void;
    hide(): void;
    /** The column's alignment, as the cell draws its value. */
    align?: ReturnType<typeof columnAlign>;
    footer?: React.ReactNode;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <div
            className="rt-peek"
            role={onSelect ? "button" : undefined}
            tabIndex={onSelect ? -1 : undefined}
            onClick={
                onSelect
                    ? () => {
                          hide();
                          onSelect();
                      }
                    : undefined
            }
        >
            <div className={`rt-peek-body bt-align-${align}`}>{children}</div>
            {footer}
        </div>
    );
}

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
            return (
                <span className={`rt-bool rt-bool-${value.value ? "yes" : "no"}`}>
                    <Icon icon={value.value ? TickIcon : CancelIcon} size={9} />
                    {value.value ? "Yes" : "No"}
                </span>
            );
        case "text":
            return <>{renderText(value.text)}</>;
        default:
            return <>{cellValueText(value)}</>;
    }
}

/**
 * The cell's body: the answer (or "Not reported", a cleared or failed cell;
 * nothing for an unattempted one) followed by its tags. `full` drops the clamp, for the peek.
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
            // Unattempted: the cell is left blank; its expansion says so.
            text = full ? <span className="rt-muted">{row.failure ? "Not answered" : "Not filled yet"}</span> : null;
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

function QuestionCell({
    row,
    column,
    renderText,
    documents,
    selected,
    onSelect,
    onEdit,
    editDisabledReason,
}: {
    row: Row;
    column: Column;
    renderText: TextRenderer;
    documents?: TableDocuments;
    selected: boolean;
    onSelect(address: CellAddress): void;
    onEdit?(address: CellAddress): void;
    editDisabledReason?: string;
}): React.ReactElement {
    const cell = row.cells[column.id];
    const select = () => onSelect({ rowId: row.id, columnId: column.id });
    const anchor = useCellPeek((hide) => (
        <CellPeek
            onSelect={select}
            hide={hide}
            align={columnAlign(column)}
            footer={
                onEdit ? (
                    <div className="rt-peek-footer">
                        <button
                            type="button"
                            className="rt-peek-action"
                            aria-label={`Edit ${column.header}`}
                            title={editDisabledReason ?? "Edit answer"}
                            disabled={!!editDisabledReason}
                            onClick={(event) => {
                                event.stopPropagation();
                                hide();
                                onEdit({ rowId: row.id, columnId: column.id });
                            }}
                        >
                            <Icon icon={EditIcon} size={12} />
                            Edit
                        </button>
                    </div>
                ) : null
            }
        >
            <CellBody row={row} cell={cell} column={column} renderText={renderText} documents={documents} full />
        </CellPeek>
    ));
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
            onKeyDown={(event) => onCellKey(event, select)}
            {...anchor}
        >
            <div className="rt-cell-body">
                <CellBody row={row} cell={cell} column={column} renderText={renderText} documents={documents} />
            </div>
        </td>
    );
}
