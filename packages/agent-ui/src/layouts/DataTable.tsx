import React, { useCallback, useMemo } from "react";
import {
    anchorColumn,
    cellIdFor,
    isColumnFilterable,
    type Column,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { ArrowRightIcon, Icon, TickIcon } from "../icons";
import type { MenuItem } from "../primitives/ContextMenu";
import { CellView, DetailsView } from "./cells";
import { ColumnHeaderCell } from "./columnHeader";
import { RowActionsView, tableHasRowActions } from "./rowActions";
import {
    cellAlign,
    defaultColumnWidth,
    renderPlainText,
    tableMinWidth,
    type TextRenderer,
} from "./tableView";
import { useTableState, type TableState } from "./useTableState";

export type { TableDensity } from "./tableView";

/** Stands in for the spec when the surface owns the state — see `DataTable`. */
const EMPTY_TABLE: TableSpec = { id: "", columns: [], rows: [] };

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
    /** Shown when the table has no rows at all. */
    emptyText?: string;
    /** Shown when filters hide every row. */
    filteredEmptyText?: string;
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
 *    its identity while the value columns scroll horizontally.
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
    emptyText = "No rows",
    filteredEmptyText = "No rows match these filters",
    className,
}: DataTableProps): React.ReactElement {
    // Hooks cannot be conditional, but the derivation can be: when the surface
    // owns the state, this instance runs against an empty spec so the filter
    // and sort passes are not repeated on every render.
    const internalState = useTableState(externalState ? EMPTY_TABLE : table);
    const state = externalState ?? internalState;

    const capabilities = table.capabilities ?? {};
    const sortable = capabilities.sortable ?? true;
    const filterable = capabilities.filterable ?? true;
    const density = state.density;

    const anchor = anchorColumn(table);
    const hasRowActions = tableHasRowActions(table);
    const selectable = table.rows.length > 0;
    const expandable = capabilities.expandable_rows ?? true;

    // A narrow surface carries only the primary columns; the rest are listed in
    // the row detail rather than dropped, so nothing becomes unreachable.
    const { visibleColumns, hiddenColumns } = useMemo(
        () =>
            splitColumns(
                table.columns,
                primaryColumnsOnly,
                anchor,
                state.hiddenColumns,
            ),
        [table.columns, primaryColumnsOnly, anchor, state.hiddenColumns],
    );

    const columnCount = visibleColumns.length + 1 + (hasRowActions ? 1 : 0);
    const minWidth = useMemo(
        () => tableMinWidth(visibleColumns, anchor?.id, hasRowActions),
        [visibleColumns, anchor, hasRowActions],
    );

    const selectClickFor = (column: Column) =>
        filterable && isColumnFilterable(column)
            ? (label: string) => state.toggleSelectFilter(column.id, label)
            : undefined;

    return (
        <div
            className={`bt${className ? ` ${className}` : ""}`}
            data-density={density}
            data-table-id={table.id}
        >
            <table className="bt-table" style={{ minWidth }}>
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
                    {hasRowActions ? <col className="bt-col-actions" /> : null}
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
                                showDescription={density !== "compact"}
                                menuItems={columnMenuItems?.(column)}
                            />
                        ))}
                        {hasRowActions ? (
                            <th className="bt-th bt-th-actions" scope="col">
                                <span className="bt-visually-hidden">
                                    Actions
                                </span>
                            </th>
                        ) : null}
                    </tr>
                </thead>

                <tbody>
                    {state.rows.map((row, index) => (
                        <TableRow
                            key={row.id}
                            table={table}
                            row={row}
                            index={index}
                            columns={visibleColumns}
                            hiddenColumns={hiddenColumns}
                            anchorId={anchor?.id}
                            state={state}
                            renderText={renderText}
                            renderRowDetail={renderRowDetail}
                            selectClickFor={selectClickFor}
                            onRetryCell={onRetryCell}
                            hasRowActions={hasRowActions}
                            expandable={expandable}
                            columnCount={columnCount}
                        />
                    ))}

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
    index: number;
    columns: Column[];
    hiddenColumns: Column[];
    anchorId: string | undefined;
    state: TableState;
    renderText: TextRenderer;
    renderRowDetail?: (row: Row) => React.ReactNode;
    selectClickFor: (column: Column) => ((label: string) => void) | undefined;
    onRetryCell?: (row: Row, column: Column) => void;
    hasRowActions: boolean;
    expandable: boolean;
    columnCount: number;
}

function TableRow({
    table,
    row,
    index,
    columns,
    hiddenColumns,
    anchorId,
    state,
    renderText,
    renderRowDetail,
    selectClickFor,
    onRetryCell,
    hasRowActions,
    expandable,
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
                    row.status === "error" ? "bt-row-error" : "",
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
                            `bt-align-${cellAlign(column)}`,
                            `bt-kind-${column.type}`,
                            column.id === anchorId ? "bt-td-anchor" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                    >
                        <CellView
                            cell={row.cells[column.id]}
                            column={column}
                            row={row}
                            renderText={renderText}
                            onSelectClick={selectClickFor(column)}
                            onRetry={
                                onRetryCell
                                    ? () => onRetryCell(row, column)
                                    : undefined
                            }
                        />
                    </td>
                ))}

                {hasRowActions ? (
                    <td className="bt-td bt-td-actions">
                        <span className="bt-actions">
                            <RowActionsView table={table} row={row} />
                        </span>
                    </td>
                ) : null}
            </tr>

            {expanded ? (
                <tr className="bt-detail-row" id={detailId}>
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
}

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
    // A column that failed or is still filling is exactly what the reader
    // expanded the row to look at, so a status counts as content here.
    const fields = table.columns.filter((column) => {
        const cell = row.cells[column.id];
        return (
            !!cell?.value ||
            !!cell?.details ||
            !!cell?.status ||
            hiddenColumns.includes(column)
        );
    });

    return (
        <div className="bt-detail">
            {row.status === "error" && row.error ? (
                <div className="bt-detail-error">{row.error}</div>
            ) : null}

            <dl className="bt-detail-fields">
                {fields.map((column) => (
                    <React.Fragment key={column.id}>
                        <dt>{column.header}</dt>
                        <dd>
                            <CellView
                                cell={row.cells[column.id]}
                                column={column}
                                row={row}
                                renderText={renderText}
                                onRetry={
                                    onRetryCell
                                        ? () => onRetryCell(row, column)
                                        : undefined
                                }
                            />
                            {row.cells[column.id]?.details ? (
                                <DetailsView
                                    details={row.cells[column.id]!.details!}
                                    renderText={renderText}
                                />
                            ) : null}
                        </dd>
                    </React.Fragment>
                ))}
            </dl>

            {extra ? <div className="bt-detail-extra">{extra}</div> : null}
        </div>
    );
}

export default DataTable;
