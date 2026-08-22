import React, { useMemo } from "react";
import {
    cellIdFor,
    columnAlign,
    isColumnFilterable,
    isColumnSortable,
    type Column,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import {
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpIcon,
    CancelIcon,
    Icon,
} from "../icons";
import IconButton from "../primitives/IconButton";
import {
    CellDetailsView,
    CellView,
    RowActionsView,
    renderPlainText,
    type TextRenderer,
} from "./cells";
import { useTableState, type TableState } from "./useTableState";

export type TableDensity = "compact" | "full";

export interface DataTableProps {
    table: TableSpec;
    /**
     * `compact` (sidebar): only `priority: 'primary'` columns are columns; the
     * rest are listed when a row is expanded. `full` (window / tab): every column.
     */
    density?: TableDensity;
    /** Renders cell text — inject the client's markdown + citation renderer. Plain text by default. */
    renderText?: TextRenderer;
    /** Show the quick-filter box and active-filter chips. Default true when the table is filterable. */
    showToolbar?: boolean;
    className?: string;
    /** Shown when the table has no rows at all. */
    emptyText?: string;
}

function SortIndicator({
    column,
    state,
}: {
    column: Column;
    state: TableState;
}): React.ReactElement | null {
    if (state.sort?.column_id !== column.id) return null;
    return (
        <Icon
            icon={state.sort.direction === "asc" ? ArrowUpIcon : ArrowDownIcon}
            size={12}
            className="bt-sort-icon"
            aria-hidden="true"
        />
    );
}

/**
 * The shared table renderer. One component serves the compact sidebar and
 * the full-width window: the spec is self-contained, the state is local, and
 * everything client-specific (item icons, reveal / import / open) reaches the
 * host through `getHost()`.
 */
export function DataTable({
    table,
    density = "full",
    renderText = renderPlainText,
    showToolbar,
    className,
    emptyText = "No rows",
}: DataTableProps): React.ReactElement {
    const state = useTableState(table);
    const capabilities = table.capabilities ?? {};
    const sortable = capabilities.sortable ?? true;
    const filterable = capabilities.filterable ?? true;
    const toolbar = showToolbar ?? filterable;
    const rowActions = capabilities.row_actions ?? [];
    const hasRowActions =
        rowActions.length > 0 && table.rows.some((r) => r.ref);

    const { visibleColumns, hiddenColumns } = useMemo(() => {
        if (density === "full")
            return {
                visibleColumns: table.columns,
                hiddenColumns: [] as Column[],
            };
        const primary = table.columns.filter((c) => c.priority === "primary");
        // A table without any primary column shows its first column rather than nothing.
        const visible = primary.length ? primary : table.columns.slice(0, 1);
        const hidden = table.columns.filter((c) => !visible.includes(c));
        return { visibleColumns: visible, hiddenColumns: hidden };
    }, [table.columns, density]);

    // Select pills filter by click only where both the table and the column allow it.
    const selectClickFor = (column: Column) =>
        filterable && isColumnFilterable(column)
            ? (label: string) => state.toggleSelectFilter(column.id, label)
            : undefined;

    const canExpandRows =
        hiddenColumns.length > 0 && (capabilities.expandable_rows ?? true);
    const columnCount =
        visibleColumns.length +
        (canExpandRows ? 1 : 0) +
        (hasRowActions ? 1 : 0);

    const activeFilterChips = state.filters.flatMap((filter) => {
        const column = table.columns.find((c) => c.id === filter.column_id);
        if (!column) return [];
        const text =
            filter.kind === "in"
                ? filter.labels.join(", ")
                : filter.kind === "contains"
                  ? `"${filter.text}"`
                  : filter.kind === "equals"
                    ? String(filter.value)
                    : filter.kind === "empty"
                      ? filter.empty
                          ? "empty"
                          : "not empty"
                      : [filter.min, filter.max]
                            .filter((v) => v != null)
                            .join(" – ");
        return [{ column, text }];
    });

    const renderDetailRow = (row: Row): React.ReactElement | null => {
        const rowExpanded = canExpandRows && state.expandedRows.has(row.id);
        const expandedCells = table.columns.filter(
            (c) =>
                row.cells[c.id]?.details &&
                state.expandedCells.has(cellIdFor(row.id, c.id)),
        );
        if (!rowExpanded && expandedCells.length === 0) return null;
        return (
            <tr className="bt-detail-row" key={`${row.id}/details`}>
                <td colSpan={columnCount}>
                    {rowExpanded ? (
                        <dl className="bt-hidden-columns">
                            {hiddenColumns.map((column) => (
                                <React.Fragment key={column.id}>
                                    <dt>{column.header}</dt>
                                    <dd>
                                        <CellView
                                            cell={row.cells[column.id]}
                                            column={column}
                                            row={row}
                                            renderText={renderText}
                                            expanded={state.expandedCells.has(
                                                cellIdFor(row.id, column.id),
                                            )}
                                            onToggleExpand={state.toggleCell}
                                            onSelectClick={selectClickFor(
                                                column,
                                            )}
                                        />
                                    </dd>
                                </React.Fragment>
                            ))}
                        </dl>
                    ) : null}
                    {expandedCells.map((column) => (
                        <CellDetailsView
                            key={column.id}
                            details={row.cells[column.id]!.details!}
                            column={column}
                            renderText={renderText}
                        />
                    ))}
                </td>
            </tr>
        );
    };

    return (
        <div
            className={`bt bt-${density}${className ? ` ${className}` : ""}`}
            data-table-id={table.id}
        >
            {table.title ? <div className="bt-title">{table.title}</div> : null}
            {toolbar ? (
                <div className="bt-toolbar">
                    <input
                        type="search"
                        className="bt-quick-filter"
                        placeholder="Filter…"
                        aria-label="Filter rows"
                        value={state.quickFilter}
                        onChange={(e) => state.setQuickFilter(e.target.value)}
                    />
                    {activeFilterChips.map(({ column, text }) => (
                        <button
                            key={column.id}
                            type="button"
                            className="bt-filter-chip"
                            onClick={() => state.clearFilter(column.id)}
                            title={`Remove filter on ${column.header}`}
                        >
                            <span className="bt-filter-chip-column">
                                {column.header}:
                            </span>{" "}
                            {text}
                            <Icon
                                icon={CancelIcon}
                                size={10}
                                className="bt-filter-chip-x"
                                aria-hidden="true"
                            />
                        </button>
                    ))}
                    <span className="bt-row-count" aria-live="polite">
                        {state.rows.length === table.rows.length
                            ? `${table.rows.length} rows`
                            : `${state.rows.length} of ${table.rows.length} rows`}
                    </span>
                </div>
            ) : null}
            <div className="bt-scroll">
                <table className="bt-table">
                    <thead>
                        <tr>
                            {canExpandRows ? (
                                <th
                                    className="bt-th-expand"
                                    aria-label="Expand"
                                />
                            ) : null}
                            {visibleColumns.map((column) => {
                                const canSort =
                                    sortable && isColumnSortable(column);
                                const sorted =
                                    state.sort?.column_id === column.id
                                        ? state.sort.direction
                                        : undefined;
                                return (
                                    <th
                                        key={column.id}
                                        className={`bt-th bt-align-${columnAlign(column)} bt-w-${column.width ?? "auto"}${canSort ? " bt-th-sortable" : ""}`}
                                        aria-sort={
                                            sorted
                                                ? sorted === "asc"
                                                    ? "ascending"
                                                    : "descending"
                                                : undefined
                                        }
                                        title={column.description}
                                        scope="col"
                                    >
                                        {canSort ? (
                                            <button
                                                type="button"
                                                className="bt-th-button"
                                                onClick={() =>
                                                    state.toggleSort(column.id)
                                                }
                                            >
                                                <span className="bt-th-label">
                                                    {column.header}
                                                </span>
                                                <SortIndicator
                                                    column={column}
                                                    state={state}
                                                />
                                            </button>
                                        ) : (
                                            <span className="bt-th-label">
                                                {column.header}
                                            </span>
                                        )}
                                    </th>
                                );
                            })}
                            {hasRowActions ? (
                                <th
                                    className="bt-th-actions"
                                    aria-label="Actions"
                                />
                            ) : null}
                        </tr>
                    </thead>
                    <tbody>
                        {table.rows.length === 0 ? (
                            <tr>
                                <td
                                    className="bt-empty-table"
                                    colSpan={Math.max(columnCount, 1)}
                                >
                                    {emptyText}
                                </td>
                            </tr>
                        ) : null}
                        {state.rows.map((row) => {
                            const rowExpanded = state.expandedRows.has(row.id);
                            return (
                                <React.Fragment key={row.id}>
                                    <tr
                                        className={`bt-row${row.status === "error" ? " bt-row-error" : ""}${rowExpanded ? " bt-row-open" : ""}`}
                                        data-row-id={row.id}
                                        title={
                                            row.status === "error"
                                                ? row.error
                                                : undefined
                                        }
                                    >
                                        {canExpandRows ? (
                                            <td className="bt-td-expand">
                                                <IconButton
                                                    icon={ArrowRightIcon}
                                                    variant="ghost-secondary"
                                                    className={`bt-expand${rowExpanded ? " bt-expand-open" : ""}`}
                                                    ariaLabel={
                                                        rowExpanded
                                                            ? "Collapse row"
                                                            : "Expand row"
                                                    }
                                                    ariaPressed={rowExpanded}
                                                    onClick={() =>
                                                        state.toggleRow(row.id)
                                                    }
                                                />
                                            </td>
                                        ) : null}
                                        {visibleColumns.map((column) => (
                                            <td
                                                key={column.id}
                                                className={`bt-td bt-align-${columnAlign(column)} bt-kind-${column.type}`}
                                                id={cellIdFor(
                                                    row.id,
                                                    column.id,
                                                )}
                                            >
                                                <CellView
                                                    cell={row.cells[column.id]}
                                                    column={column}
                                                    row={row}
                                                    renderText={renderText}
                                                    expanded={state.expandedCells.has(
                                                        cellIdFor(
                                                            row.id,
                                                            column.id,
                                                        ),
                                                    )}
                                                    onToggleExpand={
                                                        state.toggleCell
                                                    }
                                                    onSelectClick={selectClickFor(
                                                        column,
                                                    )}
                                                />
                                            </td>
                                        ))}
                                        {hasRowActions ? (
                                            <td className="bt-td-actions">
                                                <span className="bt-actions">
                                                    <RowActionsView
                                                        rowRef={row.ref}
                                                        actions={rowActions}
                                                    />
                                                </span>
                                            </td>
                                        ) : null}
                                    </tr>
                                    {renderDetailRow(row)}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {table.caption ? (
                <div className="bt-caption">{table.caption}</div>
            ) : null}
        </div>
    );
}

export default DataTable;
