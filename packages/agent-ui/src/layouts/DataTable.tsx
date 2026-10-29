import React, {
    useCallback,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    anchorColumn,
    cellExpandedFields,
    cellIdFor,
    columnAlign,
    evidenceHeading,
    isColumnFilterable,
    isColumnSortable,
    isTitleAbstractOnly,
    type Column,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { citationForEvidence } from "@beaver/agent-core/layouts/tableCitations";
import Citation from "../chat/Citation";
import { ArrowRightIcon, Icon, TickIcon } from "../icons";
import type { MenuItem } from "../primitives/ContextMenu";
import { CellView, DetailsView, rowFailureLabel } from "./cells";
import { ColumnHeaderCell } from "./columnHeader";
import { RowActionsView } from "./rowActions";
import {
    defaultColumnWidth,
    fitColumns,
    fitsToWidth,
    renderPlainText,
    tableMinWidth,
    type TextRenderer,
} from "./tableView";
import { useOptionalTableState, type TableState } from "./useTableState";
import { useRowWindow } from "./useRowWindow";

export type { TableDensity } from "./tableView";

export interface DataTableProps {
    table: TableSpec;
    /**
     * The view state. Pass the surface's own instance so the chrome and the
     * grid agree on sort, filters and selection; omit it and the grid keeps a
     * private one, which is what a bare embedded table wants.
     */
    state?: TableState;
    /**
     * Show only the anchor and `priority: "primary"` columns, listing the rest
     * in the row detail. This is a question about how much room the surface
     * has — the ~350px sidebar — and is deliberately not tied to the row-height
     * control, which the viewer moves for their own reasons.
     */
    primaryColumnsOnly?: boolean;
    /** Renders cell text — inject the client's markdown + citation renderer. */
    renderText?: TextRenderer;
    /** Row-level detail, appended under the expanded row's own fields. */
    renderRowDetail?: (row: Row) => React.ReactNode;
    /** When it returns items, that column's header gains a menu. */
    columnMenuItems?: (column: Column) => MenuItem[];
    /** Offered beside a cell error; absent ⇒ no retry control. */
    onRetryCell?: (row: Row, column: Column) => void;
    /**
     * Rows answered from title and abstract whose item has since gained a
     * document, worked out by the host when the table is shown; a fill now
     * would answer them from it. Marked "Can be improved" beside the anchor.
     */
    improvableRows?: ReadonlySet<string>;
    /** Shown when the table has no rows at all. */
    emptyText?: string;
    /** Shown when filters hide every row. */
    filteredEmptyText?: string;
    /**
     * Put only the rows near the viewport in the DOM. Needs a `.bt-scroll`
     * ancestor (the surface's scroll container) to measure against; without
     * one every row renders.
     */
    virtualize?: boolean;
    /**
     * Never scroll sideways: the table takes the surface's width, and columns
     * that would overflow it are listed in the expanded row instead.
     */
    fitWidth?: boolean;
    className?: string;
}

/**
 * The grid: everything that renders a `TableSpec`, and nothing that surrounds
 * one. Title, toolbar, footer and dialogs are the surface's job (`TableSurface`)
 * because they differ per kind of table while this does not.
 *
 * Three decisions carry the layout:
 *
 * 1. **Every row is the same height**, set by the density, with each cell's
 *    line clamp derived from the same line box. A table of abstracts whose rows
 *    grow to their tallest cell stops reading as a table, and comparison is the
 *    whole point of it. Density moves the row height and nothing else — which
 *    columns are columns is `primaryColumnsOnly`, a question about the surface.
 * 2. **One expansion affordance per row**, in the left rail. The expanded row
 *    shows every field in full, so no cell needs a chevron of its own.
 * 3. **The anchor column is sticky**, together with the rail, so the row keeps
 *    its identity while the value columns scroll horizontally — and it carries
 *    the row's verbs (`rowActions.tsx`), so they never scroll away either.
 *
 * Nothing here reads a global store and nothing queries the client at render
 * time: the spec is self-contained, and client behaviour arrives through
 * `getHost()` in `cells.tsx` / `rowActions.tsx`.
 */
export function DataTable({
    table,
    state: externalState,
    primaryColumnsOnly = false,
    renderText = renderPlainText,
    renderRowDetail,
    columnMenuItems,
    onRetryCell,
    improvableRows,
    emptyText = "No rows",
    filteredEmptyText = "No rows match these filters",
    virtualize = false,
    fitWidth: fitWidthRequested = false,
    className,
}: DataTableProps): React.ReactElement {
    const state = useOptionalTableState(table, externalState);
    const rootRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLTableSectionElement>(null);

    const capabilities = table.capabilities ?? {};
    const fitWidth = fitsToWidth(table, fitWidthRequested);
    const availableWidth = useAvailableWidth(rootRef, fitWidth);
    const sortable = capabilities.sortable ?? true;
    const filterable = capabilities.filterable ?? true;
    const density = state.density;

    const anchor = anchorColumn(table);
    const selectable = table.rows.length > 0;
    const expandable = capabilities.expandable_rows ?? true;
    // One column with a question gives every header the same reserved block, so
    // the titles share a baseline instead of each sitting on its own.
    const hasQuestions = table.columns.some((c) => !!c.description);
    const hasProgress = table.columns.some((c) => c.status === "filling");

    // A narrow surface carries only the primary columns; the rest are listed in
    // the row detail rather than dropped, so nothing becomes unreachable.
    const split = useMemo(
        () =>
            splitColumns(
                table.columns,
                primaryColumnsOnly,
                anchor,
                state.hiddenColumns,
            ),
        [table.columns, primaryColumnsOnly, anchor, state.hiddenColumns],
    );
    // On a surface that never scrolls sideways, the columns past its width
    // move into the expanded row with the others that are not columns here.
    const { visibleColumns, hiddenColumns, overflowColumns } = useMemo(() => {
        if (!fitWidth || !availableWidth)
            return { ...split, overflowColumns: [] as Column[] };
        const { fit, overflow } = fitColumns(
            split.visibleColumns,
            anchor?.id,
            availableWidth.width,
            availableWidth.remPx,
        );
        return {
            visibleColumns: fit,
            hiddenColumns: [...split.hiddenColumns, ...overflow],
            overflowColumns: overflow,
        };
    }, [split, fitWidth, availableWidth, anchor]);

    // How many cells of each column were answered from title and abstract
    // alone, for the header. Over the whole table, not the filtered view: it
    // describes the column.
    const titleAbstractCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const row of table.rows)
            for (const column of table.columns)
                if (
                    row.cells[column.id]?.outcome === "answered" &&
                    isTitleAbstractOnly(row.cells[column.id])
                )
                    counts.set(column.id, (counts.get(column.id) ?? 0) + 1);
        return counts;
    }, [table.rows, table.columns]);

    const rowWindow = useRowWindow({
        enabled: virtualize,
        rows: state.rows,
        expandedRows: state.expandedRows,
        rootRef,
        bodyRef,
        layoutKey: `${density}|${visibleColumns.map((column) => column.id).join(",")}`,
    });
    const windowRows = virtualize
        ? state.rows.slice(rowWindow.start, rowWindow.end)
        : state.rows;

    const columnCount = visibleColumns.length + 1;
    const minWidth = useMemo(
        () => tableMinWidth(visibleColumns, anchor?.id),
        [visibleColumns, anchor],
    );

    // Stable across renders that change nothing it reads, so a row whose own
    // props did not change skips rendering (`TableRow` is memoised) — which is
    // what keeps a windowed scroll to the rows entering the window.
    const toggleSelectFilter = state.toggleSelectFilter;
    const selectClickFor = useCallback(
        (column: Column) =>
            filterable && isColumnFilterable(column)
                ? (label: string) => toggleSelectFilter(column.id, label)
                : undefined,
        [filterable, toggleSelectFilter],
    );

    return (
        <div
            ref={rootRef}
            className={`bt${fitWidth ? " bt-fit" : ""}${className ? ` ${className}` : ""}`}
            data-density={density}
            data-table-id={table.id}
        >
            {overflowColumns.length > 0 ? (
                <div className="bt-fit-note" role="note">
                    {overflowColumns.length === 1
                        ? `${overflowColumns[0].header} does not fit beside the other columns; expand a row to read it, or hide a column to make room.`
                        : `${overflowColumns.length} columns do not fit beside the others (${overflowColumns
                              .map((c) => c.header)
                              .join(
                                  ", ",
                              )}); expand a row to read them, or hide columns to make room.`}
                </div>
            ) : null}
            <table
                className="bt-table"
                style={fitWidth ? undefined : { minWidth }}
            >
                <colgroup>
                    <col className="bt-col-rail" />
                    {visibleColumns.map((column) => (
                        <col
                            key={column.id}
                            style={{
                                width: defaultColumnWidth(
                                    column,
                                    column.id === anchor?.id,
                                ),
                            }}
                        />
                    ))}
                </colgroup>

                <thead>
                    <tr className="bt-head-row">
                        <th className="bt-th bt-th-rail" scope="col">
                            {selectable ? (
                                <SelectionBox
                                    checked={state.allInViewSelected}
                                    label={
                                        state.allInViewSelected
                                            ? "Clear selection"
                                            : "Select all rows"
                                    }
                                    onToggle={state.toggleSelectAll}
                                />
                            ) : null}
                        </th>
                        {visibleColumns.map((column) => (
                            <ColumnHeaderCell
                                key={column.id}
                                column={column}
                                isAnchor={column.id === anchor?.id}
                                sort={state.sort}
                                sortable={sortable}
                                onSort={state.toggleSort}
                                showDescription={hasQuestions}
                                showProgress={hasProgress}
                                menuItems={columnMenuItems?.(column)}
                                titleAbstractCount={titleAbstractCounts.get(column.id)}
                            />
                        ))}
                    </tr>
                </thead>

                <tbody ref={bodyRef}>
                    {rowWindow.padTop > 0 ? (
                        <SpacerRow height={rowWindow.padTop} />
                    ) : null}
                    {windowRows.map((row) => (
                        <TableRow
                            key={row.id}
                            table={table}
                            row={row}
                            columns={visibleColumns}
                            hiddenColumns={hiddenColumns}
                            anchorId={anchor?.id}
                            state={state}
                            renderText={renderText}
                            renderRowDetail={renderRowDetail}
                            selectClickFor={selectClickFor}
                            onRetryCell={onRetryCell}
                            improvable={improvableRows?.has(row.id) ?? false}
                            expandable={expandable}
                            sortable={sortable}
                            columnCount={columnCount}
                        />
                    ))}
                    {rowWindow.padBottom > 0 ? (
                        <SpacerRow height={rowWindow.padBottom} />
                    ) : null}

                    {state.rows.length === 0 ? (
                        <tr>
                            <SpanningCell
                                className="bt-empty-table"
                                colSpan={columnCount}
                            >
                                {table.rows.length === 0
                                    ? emptyText
                                    : filteredEmptyText}
                            </SpanningCell>
                        </tr>
                    ) : null}
                </tbody>
            </table>
        </div>
    );
}

/**
 * Stands in for the rows a windowed grid has not rendered, so the scroll
 * height is the table's.
 */
function SpacerRow({ height }: { height: number }): React.ReactElement {
    return (
        <tr className="bt-spacer-row" aria-hidden="true" style={{ height }}>
            <td />
        </tr>
    );
}

/**
 * The grid root's width and the document's rem, for a surface that fits its
 * columns to its width. Re-measured on resize; null until measured or when
 * fitting is off.
 */
function useAvailableWidth(
    rootRef: React.RefObject<HTMLDivElement | null>,
    enabled: boolean,
): { width: number; remPx: number } | null {
    const [measured, setMeasured] = useState<{
        width: number;
        remPx: number;
    } | null>(null);
    useLayoutEffect(() => {
        const root = rootRef.current;
        if (!enabled || !root) {
            setMeasured(null);
            return;
        }
        const doc = root.ownerDocument;
        const view = doc.defaultView;
        const measure = () => {
            const width = root.clientWidth;
            const rootElement = doc.documentElement ?? root;
            const remPx =
                parseFloat(
                    view?.getComputedStyle(rootElement)?.fontSize ?? "",
                ) || 13;
            if (width <= 0) return;
            setMeasured((current) =>
                current &&
                Math.abs(current.width - width) < 1 &&
                current.remPx === remPx
                    ? current
                    : { width, remPx },
            );
        };
        measure();
        view?.addEventListener("resize", measure);
        const Observer = (
            view as { ResizeObserver?: typeof ResizeObserver } | null
        )?.ResizeObserver;
        const observer = Observer ? new Observer(measure) : null;
        observer?.observe(root);
        return () => {
            view?.removeEventListener("resize", measure);
            observer?.disconnect();
        };
    }, [rootRef, enabled]);
    return enabled ? measured : null;
}

/**
 * Which columns are columns here: the viewer's own hidden set, narrowed further
 * on a surface that has room for the primary ones only. The anchor survives
 * both — it carries row identity, so a rendering that hides it has nothing left
 * to expand from.
 */
function splitColumns(
    columns: Column[],
    primaryOnly: boolean,
    anchor: Column | undefined,
    hiddenByViewer: ReadonlySet<string>,
): { visibleColumns: Column[]; hiddenColumns: Column[] } {
    const keeps = (c: Column) =>
        c.id === anchor?.id ||
        (!hiddenByViewer.has(c.id) &&
            (!primaryOnly || c.priority === "primary"));

    const visible = columns.filter(keeps);
    if (visible.length === 0)
        return {
            visibleColumns: columns.slice(0, 1),
            hiddenColumns: columns.slice(1),
        };
    return {
        visibleColumns: visible,
        hiddenColumns: columns.filter((c) => !visible.includes(c)),
    };
}

interface TableRowProps {
    table: TableSpec;
    row: Row;
    columns: Column[];
    hiddenColumns: Column[];
    anchorId: string | undefined;
    state: TableState;
    renderText: TextRenderer;
    renderRowDetail?: (row: Row) => React.ReactNode;
    selectClickFor: (column: Column) => ((label: string) => void) | undefined;
    onRetryCell?: (row: Row, column: Column) => void;
    improvable: boolean;
    expandable: boolean;
    sortable: boolean;
    columnCount: number;
}

const TableRow = React.memo(function TableRow({
    table,
    row,
    columns,
    hiddenColumns,
    anchorId,
    state,
    renderText,
    renderRowDetail,
    selectClickFor,
    onRetryCell,
    improvable,
    expandable,
    sortable,
    columnCount,
}: TableRowProps): React.ReactElement {
    const expanded = expandable && state.expandedRows.has(row.id);
    const selected = state.selectedRows.has(row.id);
    const detailId = `${row.id}/detail`;

    return (
        <>
            <tr
                className={[
                    "bt-row",
                    row.failure ? "bt-row-error" : "",
                    expanded ? "bt-row-open" : "",
                    selected ? "bt-row-selected" : "",
                ]
                    .filter(Boolean)
                    .join(" ")}
                data-row-id={row.id}
            >
                <td className="bt-td bt-td-rail">
                    <RowRail
                        expandable={expandable}
                        expanded={expanded}
                        detailId={detailId}
                        selected={selected}
                        onToggleExpand={() => state.toggleRow(row.id)}
                        onToggleSelect={() => state.toggleRowSelection(row.id)}
                    />
                </td>

                {columns.map((column) => (
                    <td
                        key={column.id}
                        id={cellIdFor(row.id, column.id)}
                        className={[
                            "bt-td",
                            isTitleAbstractOnly(row.cells[column.id])
                                ? "bt-td-title-abstract"
                                : "",
                            `bt-align-${columnAlign(column)}`,
                            `bt-kind-${column.type}`,
                            // The header's sort control sits after its label, so
                            // the values leave it the same gutter and line up
                            // with the label rather than with the control.
                            sortable && isColumnSortable(column)
                                ? "bt-sortable-col"
                                : "",
                            column.id === anchorId ? "bt-td-anchor" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                    >
                        {column.id === anchorId ? (
                            // The row's verbs ride on the anchor cell itself,
                            // in normal flow beside the value, so they are
                            // there whatever state the value is in and take
                            // the width they need rather than the title's.
                            <div className="bt-anchor-cell">
                                <CellView
                                    cell={row.cells[column.id]}
                                    column={column}
                                    row={row}
                                    table={table}
                                    renderText={renderText}
                                    onSelectClick={selectClickFor(column)}
                                    onRetry={
                                        onRetryCell
                                            ? () => onRetryCell(row, column)
                                            : undefined
                                    }
                                />
                                {improvable ? (
                                    <small
                                        className="bt-improvable"
                                        title="Some answers came from the title and abstract, and the item now has a document. Filling the table again answers them from it."
                                    >
                                        Can be improved
                                    </small>
                                ) : null}
                                <RowActionsView table={table} row={row} />
                            </div>
                        ) : (
                            <CellView
                                cell={row.cells[column.id]}
                                column={column}
                                row={row}
                                table={table}
                                renderText={renderText}
                                onSelectClick={selectClickFor(column)}
                                onRetry={
                                    onRetryCell
                                        ? () => onRetryCell(row, column)
                                        : undefined
                                }
                            />
                        )}
                    </td>
                ))}
            </tr>

            {expanded ? (
                <tr
                    className="bt-detail-row"
                    id={detailId}
                    data-detail-for={row.id}
                >
                    <SpanningCell colSpan={columnCount}>
                        <RowDetail
                            table={table}
                            row={row}
                            hiddenColumns={hiddenColumns}
                            renderText={renderText}
                            onRetryCell={onRetryCell}
                            extra={renderRowDetail?.(row)}
                        />
                    </SpanningCell>
                </tr>
            ) : null}
        </>
    );
});

/**
 * A `<td>` that spans columns, setting `colspan` through the IDL property
 * rather than the JSX attribute.
 *
 * The separate Beaver window is an XHTML document, where attribute names are
 * case-sensitive: the `colSpan` React writes survives verbatim, the cell never
 * sees a `colspan`, and it silently spans one column — the row detail then
 * renders squeezed inside the rail. Assigning the property reflects to the
 * correctly-cased attribute in an HTML and an XML document alike.
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

/**
 * The left rail: the expander, and a checkbox that fades in on hover. No row
 * number — in a table that sorts and filters, a position is not an identity,
 * and it competed with the chevron for the only column that is pure chrome.
 */
function RowRail({
    expandable,
    expanded,
    selected,
    detailId,
    onToggleExpand,
    onToggleSelect,
}: {
    expandable: boolean;
    expanded: boolean;
    selected: boolean;
    detailId: string;
    onToggleExpand(): void;
    onToggleSelect(): void;
}): React.ReactElement {
    return (
        <span className="bt-rail">
            {expandable ? (
                <button
                    type="button"
                    className={`bt-rail-chevron${expanded ? " bt-open" : ""}`}
                    aria-label={expanded ? "Collapse row" : "Expand row"}
                    aria-expanded={expanded}
                    aria-controls={expanded ? detailId : undefined}
                    onClick={onToggleExpand}
                >
                    <Icon icon={ArrowRightIcon} size={12} />
                </button>
            ) : (
                <span className="bt-rail-spacer" aria-hidden="true" />
            )}
            <span className={`bt-rail-mark${selected ? " bt-selected" : ""}`}>
                <SelectionBox
                    checked={selected}
                    label={selected ? "Deselect row" : "Select row"}
                    onToggle={onToggleSelect}
                />
            </span>
        </span>
    );
}

function SelectionBox({
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
            className={`bt-checkbox${checked ? " bt-checked" : ""}`}
            role="checkbox"
            aria-checked={checked}
            aria-label={label}
            onClick={(e) => {
                e.stopPropagation();
                onToggle();
            }}
        >
            <Icon icon={TickIcon} size={10} />
        </button>
    );
}

/**
 * The expanded row: every field in full, including the ones a clamp cut short
 * plus, on a narrow surface, the columns that are not columns here. This is what
 * makes clamping safe — nothing is unreachable, it is one click away.
 *
 * A field may bring fields of its own that exist only here: a labelled detail
 * such as an abstract, or an annotation's passage and comment. They follow the
 * cell they belong to, listed by name like any other field.
 */
function RowDetail({
    table,
    row,
    hiddenColumns,
    renderText,
    onRetryCell,
    extra,
}: {
    table: TableSpec;
    row: Row;
    hiddenColumns: Column[];
    renderText: TextRenderer;
    onRetryCell?: (row: Row, column: Column) => void;
    extra?: React.ReactNode;
}): React.ReactElement {
    // A failed cell is exactly what the reader expanded the row to look at,
    // so every written cell counts as content here.
    const fields = table.columns.filter(
        (column) => !!row.cells[column.id] || hiddenColumns.includes(column),
    );

    return (
        <div className="bt-detail">
            {row.failure ? (
                <div className="bt-detail-error">
                    <strong>{rowFailureLabel(row.failure)}.</strong>{" "}
                    {row.failure.message}
                </div>
            ) : null}

            <dl className="bt-detail-fields">
                {fields.map((column) => {
                    const cell = row.cells[column.id];
                    const expanded = cellExpandedFields(cell);
                    return (
                        <React.Fragment key={column.id}>
                            <dt>{column.header}</dt>
                            <dd>
                                <CellView
                                    cell={cell}
                                    column={column}
                                    row={row}
                                    table={table}
                                    variant="detail"
                                    renderText={renderText}
                                    onRetry={
                                        onRetryCell
                                            ? () => onRetryCell(row, column)
                                            : undefined
                                    }
                                />
                                {cell?.reasoning ? (
                                    <DetailsView
                                        details={{
                                            kind: "text",
                                            text: cell.reasoning,
                                        }}
                                        renderText={renderText}
                                    />
                                ) : null}
                                {cell?.evidence?.length ? (
                                    <EvidenceList row={row} column={column} />
                                ) : null}
                            </dd>
                            {expanded.map((field) => (
                                <React.Fragment
                                    key={`${column.id}/${field.label}`}
                                >
                                    <dt>{field.label}</dt>
                                    <dd>
                                        <DetailsView
                                            details={field.details}
                                            label=""
                                            renderText={renderText}
                                        />
                                    </dd>
                                </React.Fragment>
                            ))}
                        </React.Fragment>
                    );
                })}
            </dl>

            {extra ? <div className="bt-detail-extra">{extra}</div> : null}
        </div>
    );
}

/**
 * A cell's evidence: each quote with the citation assembled from it, handed to
 * the chat's `Citation` component directly. A tag names only a work and a
 * locator, so two quotes of one work could not be told apart through the
 * thread's citation store; the assembled citation carries its own quote,
 * page and highlight.
 *
 * The list is headed by what its passages are to the value
 * ({@link evidenceHeading}). A passage cited from a table carries the table's
 * caption and header rows, shown above it so the quote can be read.
 */
function EvidenceList({
    row,
    column,
}: {
    row: Row;
    column: Column;
}): React.ReactElement {
    const cell = row.cells[column.id];
    const evidence = cell?.evidence ?? [];
    return (
        <div className="bt-details">
            <div className="bt-details-label">
                {evidenceHeading(column, cell)}
            </div>
            <ul className="bt-details-list">
                {evidence.map((entry, index) => {
                    const citation = citationForEvidence(row, entry);
                    return (
                        <li key={index}>
                            {entry.context ? (
                                <span className="bt-evidence-context">
                                    {entry.context}
                                </span>
                            ) : null}
                            “{entry.quote.replace(/\s+/g, " ").trim()}”
                            {citation ? (
                                <span className="markdown">
                                    {" "}
                                    <Citation
                                        citation={citation}
                                        marker={String(index + 1)}
                                    />
                                </span>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

export default DataTable;
