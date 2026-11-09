import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    cellIdFor,
    cellValueText,
    columnAlign,
    selectOption,
    staleReason,
    type Cell,
    type Column,
    type Row,
    type TableSort,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { FindHighlight } from "../../chat/highlightText";
import { ArrowDownIcon, ArrowUpLineIcon, CancelIcon, CopyIcon, EditIcon, Icon, PlusSignIcon, RepeatIcon, TickIcon } from "../../icons";
import type { MenuItem } from "../../primitives/ContextMenu";
import MenuButton from "../../primitives/MenuButton";
import { selectionWithin, useHoverAnchor, useHoverLayer } from "../../primitives/HoverLayer";
import type { TextRenderer } from "../tableView";
import type { TableState } from "../useTableState";
import { useRowWindow } from "../useRowWindow";
import { CellTags } from "./CellTags";
import {
    cellFill,
    cellState,
    columnBadges,
    isNewRow,
    newBadgeText,
    PAPER_HEADER,
    sortOrderLabel,
    staleBadgeText,
    type CellFill,
    type ResearchColumns,
    type RowFill,
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
    /** A column's menu (on hover over its header); an empty one shows no button. */
    columnMenuItems?(column: Column): MenuItem[];
    /** The (+) after the last column; absent, no add column. */
    onAddColumn?(): void;
    /** Why the (+) is disabled (a read-only library, the table's limits). */
    addColumnDisabledReason?: string;
    /** Window the rows, for a long table. */
    virtualize?: boolean;
    emptyText: string;
    filteredEmptyText: string;
    /**
     * Shown under the header in place of `emptyText`: the empty table's guide,
     * passed only while the table has no rows. It stays in view as the grid
     * scrolls sideways.
     */
    emptyContent?: React.ReactNode;
    /**
     * Opens the cell editor: the Edit in a cell's expansion. Absent, cells
     * are not editable here.
     */
    onEditCell?(address: CellAddress): void;
    /** Why cells cannot be edited (a read-only library); the Edit shows it. */
    cellEditDisabledReason?: string;
    /** Copies a cell's answer: the Copy in its expansion. Absent, no Copy. */
    onCopyCell?(text: string): void;
    /** The open cell editor, floated over its cell and the rows below. */
    cellEditor?: { address: CellAddress; content: React.ReactNode; list: boolean } | null;
    /** A running fill's cells, by row ({@link rowFills}). */
    fills?: ReadonlyMap<string, RowFill>;
    /** Rows the user just added, highlighted briefly. */
    addedRows?: ReadonlySet<string>;
    /** Columns the user just added, highlighted briefly. */
    addedColumns?: ReadonlySet<string>;
}

/** A question column's width: prose shares what is left; short types are fixed. */
function questionWidth(column: Column): string | undefined {
    if (typeof column.width === "number") return `${column.width}px`;
    switch (column.type) {
        case "select":
            return selectWidth(column);
        case "boolean":
            return "8.5rem";
        default:
            return undefined;
    }
}

/**
 * A Category column wide enough for its longest category on one line, within
 * bounds; a longer one wraps in its pill. Estimated from the labels' length:
 * about 0.46rem a character at the pill's size, plus the pill's and the
 * cell's padding.
 */
function selectWidth(column: Column): string {
    const longest = Math.max(0, ...(column.options ?? []).map((option) => option.label.length));
    const rem = Math.min(SELECT_MAX_REM, Math.max(SELECT_MIN_REM, longest * 0.46 + 3.4));
    return `${Math.round(rem * 10) / 10}rem`;
}

const SELECT_MIN_REM = 9;
const SELECT_MAX_REM = 16;

/** The narrowest expansion of a Category or Yes / no cell, whose column is narrow. */
const SHORT_PEEK_PX = 224;

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
    addColumnDisabledReason,
    virtualize = false,
    emptyText,
    filteredEmptyText,
    emptyContent,
    onEditCell,
    cellEditDisabledReason,
    onCopyCell,
    cellEditor,
    fills,
    addedRows,
    addedColumns,
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
    const minWidth = `calc(2.75rem + 20rem + ${columns.year ? `${YEAR_WIDTH} + ` : ""}${addColumn ? `${ADD_WIDTH} + ` : ""}${questions
        .map((column) => questionWidth(column) ?? FLEX_MIN)
        .join(" + ") || "0px"})`;
    const columnCount = 2 + (columns.year ? 1 : 0) + questions.length + (addColumn ? 1 : 0);
    const selectable = table.rows.length > 0;
    // With every column at a fixed width (no question, or only Yes / no and
    // Category ones), a fixed-layout table would spread the leftover width
    // over all of them. The last column takes it instead: the (+) column,
    // whose button then sits right after the last column, else the paper.
    const flexTail = !questions.some((column) => questionWidth(column) === undefined);
    const paperWidth = flexTail && !addColumn ? undefined : "20rem";
    // Before the first question column, the (+) says what it adds.
    const labelAdd = columns.questions.length === 0;

    return (
        <div ref={rootRef} className="rt-grid" data-density={state.density} data-table-id={table.id}>
            <table className="bt-table rt-table" style={{ minWidth }}>
                <colgroup>
                    <col style={{ width: "2.75rem" }} />
                    <col style={{ width: paperWidth }} />
                    {columns.year ? <col style={{ width: YEAR_WIDTH }} /> : null}
                    {questions.map((column) => (
                        <col
                            key={column.id}
                            className={addedColumns?.has(column.id) ? "rt-col-added" : undefined}
                            style={{ width: questionWidth(column) }}
                        />
                    ))}
                    {addColumn ? <col style={{ width: flexTail ? undefined : ADD_WIDTH }} /> : null}
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
                        {columns.paper ? (
                            <ColumnHeader
                                column={columns.paper}
                                kind="paper"
                                sort={state.sort}
                                menuItems={columnMenuItems}
                            />
                        ) : (
                            <th className="rt-th rt-th-paper" scope="col">
                                <div className="rt-th-top">
                                    <span className="rt-th-label">{PAPER_HEADER}</span>
                                </div>
                            </th>
                        )}
                        {columns.year ? (
                            <ColumnHeader
                                column={columns.year}
                                kind="year"
                                sort={state.sort}
                                menuItems={columnMenuItems}
                            />
                        ) : null}
                        {questions.map((column) => (
                            <ColumnHeader
                                key={column.id}
                                column={column}
                                kind="question"
                                sort={state.sort}
                                badges={badges.get(column.id)!}
                                menuItems={columnMenuItems}
                                isAdded={!!addedColumns?.has(column.id)}
                            />
                        ))}
                        {addColumn ? (
                            // The reason sits on the cell too: a disabled button shows no tooltip of its own.
                            <th
                                className={`rt-th rt-th-add${flexTail ? " rt-th-add-tail" : ""}`}
                                scope="col"
                                title={addColumnDisabledReason}
                            >
                                <button
                                    type="button"
                                    className={labelAdd ? "rt-add-column rt-add-column-labeled" : "rt-icon-button rt-add-column"}
                                    aria-label="Add column"
                                    title={addColumnDisabledReason ?? "Add column"}
                                    disabled={!!addColumnDisabledReason}
                                    onClick={onAddColumn}
                                >
                                    <Icon icon={PlusSignIcon} size={14} />
                                    {labelAdd ? <span>Add column</span> : null}
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
                            onCopyCell={onCopyCell}
                            fill={fills?.get(row.id)}
                            isAdded={!!addedRows?.has(row.id)}
                        />
                    ))}
                    {rowWindow.padBottom > 0 ? <Spacer height={rowWindow.padBottom} /> : null}
                    {state.rows.length === 0 && !emptyContent ? (
                        <tr>
                            <SpanningCell colSpan={columnCount} className="rt-empty">
                                {table.rows.length === 0 ? emptyText : filteredEmptyText}
                            </SpanningCell>
                        </tr>
                    ) : null}
                </tbody>
            </table>
            {emptyContent}
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
/** Room for "Year", its sort mark and the column menu's button. */
const YEAR_WIDTH = "5.5rem";

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
 * A column's header: its name, the sort mark when the view is sorted by it,
 * and the column menu's button on hover. A question's header adds its badges
 * and, under the name, its question.
 */
function ColumnHeader({
    column,
    kind,
    sort,
    badges,
    menuItems,
    isAdded = false,
}: {
    column: Column;
    /** Just added by the user: highlighted briefly. */
    isAdded?: boolean;
    kind: "paper" | "year" | "question";
    sort: TableSort | undefined;
    badges?: ReturnType<typeof columnBadges>;
    menuItems?(column: Column): MenuItem[];
}): React.ReactElement {
    // The menu renders inside this sticky cell, which stacks on its own: while
    // it is open the cell is raised over its neighbours, or the next header
    // would paint over the menu and take its clicks.
    const [menuOpen, setMenuOpen] = React.useState(false);
    const label = kind === "paper" ? PAPER_HEADER : column.header;
    const items = menuItems?.(column) ?? [];
    const direction = sort?.column_id === column.id ? sort.direction : undefined;
    return (
        <th
            className={`rt-th rt-th-${kind}${items.length ? " rt-th-has-menu" : ""}${menuOpen ? " rt-th-menu-open" : ""}${isAdded ? " rt-th-added" : ""}`}
            scope="col"
            data-column-id={column.id}
            aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : undefined}
        >
            {items.length ? (
                <span className="rt-column-menu">
                    <MenuButton
                        menuItems={items}
                        variant="ghost-secondary"
                        icon={ArrowDownIcon}
                        ariaLabel={`Column menu: ${label}`}
                        width="13rem"
                        toggleCallback={setMenuOpen}
                    />
                </span>
            ) : null}
            <div className="rt-th-top">
                <span className="rt-th-label">{label}</span>
                {direction ? <SortMark direction={direction} year={kind === "year"} /> : null}
                {badges && badges.staleCells > 0 ? (
                    <Badge
                        className="rt-badge rt-badge-stale"
                        text={staleBadgeText(badges.staleCells, badges.staleReason)}
                    >
                        <Icon icon={RepeatIcon} size={10} />
                        {badges.staleCells}
                    </Badge>
                ) : null}
                {badges && badges.newCells > 0 ? (
                    <Badge className="rt-badge rt-badge-new" text={newBadgeText(badges.newCells)}>
                        New
                    </Badge>
                ) : null}
            </div>
            {kind === "question" && column.description ? (
                <div className="rt-th-question-text" title={column.description}>
                    {column.description}
                </div>
            ) : null}
        </th>
    );
}

/**
 * The quiet arrow after a header's name while the view is sorted by that
 * column: up for A → Z (oldest first), down for Z → A. A full arrow rather
 * than a chevron, which is the column menu's button.
 */
function SortMark({ direction, year }: { direction: TableSort["direction"]; year: boolean }): React.ReactElement {
    return (
        <span className="rt-th-sort" title={`Sorted ${sortOrderLabel(direction, year)}`}>
            <Icon
                icon={ArrowUpLineIcon}
                size={11}
                aria-hidden="true"
                style={direction === "desc" ? { transform: "rotate(180deg)" } : undefined}
            />
        </span>
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
    isAdded: boolean;
    isSelected: boolean;
    selectedColumn?: string;
    onToggleSelect(rowId: string): void;
    onSelectCell(address: CellAddress): void;
    menuItems(row: Row): MenuItem[];
    addColumn: boolean;
    onEditCell?(address: CellAddress): void;
    editDisabledReason?: string;
    onCopyCell?(text: string): void;
    fill?: RowFill;
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
    isAdded,
    isSelected,
    selectedColumn,
    onToggleSelect,
    onSelectCell,
    menuItems,
    addColumn,
    onEditCell,
    editDisabledReason,
    onCopyCell,
    fill,
}: ResearchRowProps): React.ReactElement {
    const lookOf = useRowFillLooks(fill, row);
    return (
        <tr
            className={[
                "rt-row",
                isSelected ? "rt-row-selected" : "",
                row.failure ? "rt-row-failed" : "",
                isAdded ? "rt-row-added" : "",
            ]
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
                    <FindHighlight text={cellValueText(yearColumnId ? row.cells[yearColumnId]?.value : undefined)} />
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
                    onCopy={onCopyCell}
                    fill={cellFill(fill, column.id)}
                    look={lookOf(column.id)}
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
            onClick={select ? (event) => onCellClick(event, select) : undefined}
            onKeyDown={select ? (event) => onCellKey(event, select) : undefined}
            {...anchor}
        >
            <PaperCell row={row} anchorColumnId={paperColumnId} isNew={isNew} />
        </td>
    );
}

/**
 * A grid cell's expansion, opened by hovering the cell: what `render` draws,
 * given `hide` to close it, at least `minWidth` px wide. Returns the handlers
 * to spread on the cell.
 */
function useCellPeek(
    render: (hide: () => void) => React.ReactNode,
    minWidth?: number,
): Pick<ReturnType<typeof useHoverAnchor>, "onMouseEnter" | "onMouseLeave" | "onMouseDown"> {
    const layers = useHoverLayer();
    const hide = () => layers?.hide();
    const { onMouseEnter, onMouseLeave, onMouseDown } = useHoverAnchor({
        slot: "peek",
        variant: "peek",
        delayMs: 450,
        width: minWidth,
        render: () => render(hide),
    });
    return { onMouseEnter, onMouseLeave, onMouseDown };
}

/** A click on the cell selects it, unless it ended a drag that selected its text. */
function onCellClick(event: React.MouseEvent<HTMLElement>, select: () => void): void {
    if (selectionWithin(event.currentTarget)) return;
    select();
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
 * on the content selects the cell, as a click on the cell does (not one that
 * ends selecting its text); the expansion closes first, since the inspector
 * narrows the grid and the peek would float over where the cell was.
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
                    ? (event) => {
                          if (selectionWithin(event.currentTarget)) return;
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
                    className={`bt-pill bt-pill-${option?.color ?? "gray"} rt-choice`}
                    title={option?.description || undefined}
                >
                    <FindHighlight text={value.label} />
                </span>
            );
        }
        case "boolean":
            return (
                <span className={`rt-bool rt-bool-${value.value ? "yes" : "no"}`}>
                    <Icon icon={value.value ? TickIcon : CancelIcon} size={9} />
                    <FindHighlight text={value.value ? "Yes" : "No"} />
                </span>
            );
        case "text":
            return <>{renderText(value.text)}</>;
        default:
            return <FindHighlight text={cellValueText(value)} />;
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
    onCopy,
    fill,
    look,
}: {
    row: Row;
    column: Column;
    renderText: TextRenderer;
    documents?: TableDocuments;
    selected: boolean;
    onSelect(address: CellAddress): void;
    onEdit?(address: CellAddress): void;
    editDisabledReason?: string;
    onCopy?(text: string): void;
    /** What the running fill does with the cell, as the job last said. */
    fill?: CellFill;
    /** How the grid shows it ({@link useRowFillLooks}). */
    look?: FillLook;
}): React.ReactElement {
    const cell = row.cells[column.id];
    const pending = cellState(cell) === "pending";
    // A cell waiting for its answer shows placeholder lines. An answer it
    // already holds stays readable in the expansion until the new one is saved.
    const placeholder = look === "queued" || look === "active";
    const select = () => onSelect({ rowId: row.id, columnId: column.id });
    // A narrow Category or Yes / no column gets a wider expansion.
    const peekWidth = column.type === "select" || column.type === "boolean" ? SHORT_PEEK_PX : undefined;
    const anchor = useCellPeek((hide) => {
        const copyText = onCopy ? answerText(cell) : "";
        return (
            <CellPeek
                onSelect={select}
                hide={hide}
                align={columnAlign(column)}
                footer={
                    onEdit || copyText ? (
                        <div className="rt-peek-footer">
                            {copyText ? <CopyAction text={copyText} onCopy={onCopy!} /> : null}
                            {onEdit ? (
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
                            ) : null}
                        </div>
                    ) : null
                }
            >
                {/* The expansion draws when the table does, so it follows the job, not the look. */}
                {fill ? <FillNote fill={fill} replacing={!pending} /> : null}
                {fill && pending ? null : (
                    <CellBody row={row} cell={cell} column={column} renderText={renderText} documents={documents} full />
                )}
            </CellPeek>
        );
    }, peekWidth);
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
            data-fill={look}
            aria-busy={look === "queued" || look === "active" ? true : undefined}
            tabIndex={0}
            aria-label={`${column.header}: open details`}
            onClick={(event) => onCellClick(event, select)}
            onKeyDown={(event) => onCellKey(event, select)}
            {...anchor}
        >
            <div className="rt-cell-body">
                {placeholder ? (
                    <FillLines short={column.type === "select" || column.type === "boolean"} />
                ) : (
                    <CellBody row={row} cell={cell} column={column} renderText={renderText} documents={documents} />
                )}
            </div>
        </td>
    );
}

/**
 * A cell's answer as plain text, to copy: Yes / No as the grid shows it, text
 * without its citation tags. Empty when the cell holds no answer.
 */
function answerText(cell: Cell | undefined): string {
    if (cell?.outcome !== "answered" || !cell.value) return "";
    if (cell.value.kind === "boolean") return cell.value.value ? "Yes" : "No";
    return cellValueText(cell.value).trim();
}

/** How long the Copy shows that it copied. */
const COPIED_MS = 1400;

/** The Copy in a cell's expansion: an icon, a tick for a moment once it copied. */
function CopyAction({ text, onCopy }: { text: string; onCopy(text: string): void }): React.ReactElement {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => () => clearTimeout(timer.current), []);
    return (
        <button
            type="button"
            className="rt-peek-action rt-peek-copy"
            aria-label={copied ? "Copied" : "Copy answer"}
            title={copied ? "Copied" : "Copy answer"}
            onClick={(event) => {
                // The expansion stays open; its click would open the cell.
                event.stopPropagation();
                onCopy(text);
                setCopied(true);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), COPIED_MS);
            }}
        >
            <Icon icon={copied ? TickIcon : CopyIcon} size={12} />
        </button>
    );
}

/** How a cell shows a running fill: `landed` briefly marks an answer that just arrived. */
type FillLook = CellFill | "landed";

/** How long an answer that just arrived stays marked. */
const LANDED_MS = 1400;
/**
 * How long a row the fill let go keeps filling while it waits for the table
 * that holds its answers. The job's news and the table's reload race; the
 * reload almost always follows within moments.
 */
const SETTLE_MS = 3000;

interface RowFillTrack {
    /** What each cell the fill reached held then. */
    before: Map<string, Cell | undefined>;
    /** The row's failure then. */
    failure: string;
    /** The columns the fill last listed. */
    columns: readonly string[];
    active: boolean;
    /** Let go after starting; waiting for its answers. */
    settling: boolean;
    /** Its answers arrived while the fill still lists it. */
    done: boolean;
}

function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
    return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const failureKey = (row: Row) => JSON.stringify(row.failure ?? null);
const NO_COLUMNS: ReadonlySet<string> = new Set();

/**
 * How a row's cells show a running fill, by column. A fill writes a row's
 * answers (or its failure) in one commit, so the row lands as a whole: once
 * any cell the fill reached, or the row's failure, changes, the cells whose
 * content changed are marked `landed` for a moment and the rest stop filling,
 * whichever of the job's news and the table's reload comes first. A row the
 * job lets go after starting it keeps filling until that change arrives, or
 * for {@link SETTLE_MS}; one dropped from the queue (Stop) ends at once.
 */
function useRowFillLooks(fill: RowFill | undefined, row: Row): (columnId: string) => FillLook | undefined {
    const [landed, setLanded] = useState<ReadonlySet<string> | null>(null);
    const [settling, setSettling] = useState<RowFill | null>(null);
    const track = useRef<RowFillTrack | null>(null);
    const listed = useRef(fill);
    listed.current = fill;
    const timer = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => () => clearTimeout(timer.current), []);
    useLayoutEffect(() => {
        const later = (ms: number, then: () => void) => {
            clearTimeout(timer.current);
            timer.current = setTimeout(then, ms);
        };
        let current = track.current;
        if (!current) {
            if (!fill) return;
            // A new fill: an earlier one's landed mark gives way.
            clearTimeout(timer.current);
            setLanded(null);
            current = track.current = {
                before: new Map(),
                failure: failureKey(row),
                columns: fill.columns,
                active: false,
                settling: false,
                done: false,
            };
        }
        if (current.done) {
            if (fill) return;
            track.current = null;
            setLanded((now) => (now === NO_COLUMNS ? null : now));
            return;
        }
        if (fill) for (const id of fill.columns) if (!current.before.has(id)) current.before.set(id, row.cells[id]);
        const changed = [...current.before].filter(([id, cell]) => !sameCell(row.cells[id], cell)).map(([id]) => id);
        if (changed.length || failureKey(row) !== current.failure) {
            // The row's answers were saved.
            current.done = true;
            if (!fill) track.current = null;
            setSettling(null);
            setLanded(new Set(changed));
            // Kept empty while the job still lists the row, so it does not fill again.
            later(LANDED_MS, () => setLanded(listed.current ? NO_COLUMNS : null));
            return;
        }
        if (fill) {
            current.columns = fill.columns;
            current.active ||= fill.active;
            if (current.settling) {
                current.settling = false;
                clearTimeout(timer.current);
                setSettling(null);
            }
            return;
        }
        if (!current.active) {
            track.current = null;
            return;
        }
        if (current.settling) return;
        // Kept, so the change above is still seen when the table arrives.
        current.settling = true;
        const settled = current;
        setSettling({ columns: current.columns, active: true });
        later(SETTLE_MS, () => {
            if (track.current !== settled) return;
            track.current = null;
            setSettling(null);
        });
    }, [fill, row]);
    return (columnId) =>
        landed ? (landed.has(columnId) ? "landed" : undefined) : cellFill(fill ?? settling ?? undefined, columnId);
}

/** Placeholder lines where an answer is coming: still while queued, shimmering while answered. */
function FillLines({ short }: { short: boolean }): React.ReactElement {
    return (
        <span className={`rt-fill-lines${short ? " rt-fill-lines-short" : ""}`} aria-hidden="true">
            {Array.from({ length: short ? 1 : 3 }, (_, index) => (
                <span key={index} className="rt-fill-line" />
            ))}
        </span>
    );
}

/** What a running fill is doing with a cell, said in its expansion and the inspector. */
export function FillNote({ fill, replacing }: { fill: CellFill; replacing: boolean }): React.ReactElement {
    const text =
        fill === "active"
            ? replacing
                ? "Beaver is answering this again. This answer stays until the new one is saved."
                : "Beaver is answering this now."
            : replacing
              ? "Beaver answers this again later in this fill."
              : "Beaver answers this later in this fill.";
    return (
        <p className="rt-fill-note" data-fill={fill}>
            {text}
        </p>
    );
}
