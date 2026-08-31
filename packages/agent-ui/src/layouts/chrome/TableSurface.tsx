import React, { useMemo } from "react";
import {
    summarizeCoverage,
    type Column,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import type { MenuItem } from "../../primitives/ContextMenu";
import { DataTable } from "../DataTable";
import {
    renderPlainText,
    type TableDensity,
    type TextRenderer,
} from "../tableView";
import { useOptionalTableState, type TableState } from "../useTableState";
import { TableFooter, TableSelectionBar, TableTitleBar } from "./TableBars";
import { TableToolbar } from "./TableToolbar";

export interface TableSurfaceProps {
    table: TableSpec;

    /**
     * Share a state instance when the surface needs to read it — to label a
     * bulk verb with the selection, say. Omit it and the surface owns one.
     */
    state?: TableState;
    /** Initial row height, when the surface owns the state. */
    density?: TableDensity;

    /** Defaults to `table.title`; pass a node for anything richer. */
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;

    /** Whole-table verbs in the title bar (export, save to library). */
    headerActions?: React.ReactNode;
    /** Surface-specific toolbar controls, before the view controls. */
    toolbarActions?: React.ReactNode;
    /** Bulk verbs shown while rows are selected. Receives the selected ids in view order. */
    selectionActions?: (rowIds: string[], rows: Row[]) => React.ReactNode;
    /** What one row is called in the selection bar. */
    rowNoun?: string;

    /** Extra footer text — a schema hash, a last-updated stamp. */
    footerNote?: React.ReactNode;
    /**
     * Rendered after the grid, positioned against the surface. This is where a
     * dialog belongs (the add-column composer), so it can never be clipped by
     * the grid's own scroll container.
     */
    overlay?: React.ReactNode;

    /** Carry only the anchor and `priority: "primary"` columns — a narrow surface. */
    primaryColumnsOnly?: boolean;
    renderText?: TextRenderer;
    renderRowDetail?: (row: Row) => React.ReactNode;
    columnMenuItems?: (column: Column) => MenuItem[];
    onRetryCell?: (row: Row, column: Column) => void;

    showSearch?: boolean;
    searchPlaceholder?: string;
    emptyText?: string;
    filteredEmptyText?: string;
    className?: string;
}

/**
 * The frame around a table: title bar, toolbar, the grid, footer, and a slot
 * for dialogs.
 *
 * None of this is part of `TableSpec` — a spec says what the data is, not what
 * a window built around it offers — and all of it recurs, so it lives here
 * once and each kind of table (`SearchResultsTable`, `ExtractionTable`) fills
 * the slots rather than rebuilding the chrome. The grid stays free of it, so a
 * table embedded in a chat message can render `DataTable` alone.
 *
 * The surface owns the view state so the toolbar, the selection bar and the
 * grid all read the same sort, filters and selection.
 */
export function TableSurface({
    table,
    state: externalState,
    density,
    title,
    subtitle,
    icon,
    headerActions,
    toolbarActions,
    selectionActions,
    rowNoun = "row",
    footerNote,
    overlay,
    primaryColumnsOnly,
    renderText = renderPlainText,
    renderRowDetail,
    columnMenuItems,
    onRetryCell,
    showSearch,
    searchPlaceholder,
    emptyText,
    filteredEmptyText,
    className,
}: TableSurfaceProps): React.ReactElement {
    const state = useOptionalTableState(table, externalState, { density });

    const coverage = useMemo(
        () => summarizeCoverage(table, state.rows),
        [table, state.rows],
    );

    const selectedRows = useMemo(
        () => state.rows.filter((row) => state.selectedRows.has(row.id)),
        [state.rows, state.selectedRows],
    );
    const selectedIds = useMemo(
        () => selectedRows.map((row) => row.id),
        [selectedRows],
    );

    const sortLabel = useMemo(() => {
        if (!state.sort) return undefined;
        const column = table.columns.find(
            (c) => c.id === state.sort!.column_id,
        );
        if (!column) return undefined;
        return `sorted by ${column.header} ${state.sort.direction === "asc" ? "↑" : "↓"}`;
    }, [state.sort, table.columns]);

    const heading = title ?? table.title ?? "Table";

    return (
        <section className={`bt-surface${className ? ` ${className}` : ""}`}>
            <TableTitleBar
                title={heading}
                subtitle={subtitle ?? table.caption}
                icon={icon}
                actions={headerActions}
            />

            {selectedIds.length > 0 ? (
                <TableSelectionBar
                    count={selectedIds.length}
                    noun={rowNoun}
                    actions={selectionActions?.(selectedIds, selectedRows)}
                    onClear={state.clearSelection}
                />
            ) : (
                <TableToolbar
                    table={table}
                    state={state}
                    shown={state.rows.length}
                    total={table.rows.length}
                    actions={toolbarActions}
                    showSearch={showSearch}
                    searchPlaceholder={searchPlaceholder}
                />
            )}

            <div className="bt-scroll">
                <DataTable
                    table={table}
                    state={state}
                    primaryColumnsOnly={primaryColumnsOnly}
                    renderText={renderText}
                    renderRowDetail={renderRowDetail}
                    columnMenuItems={columnMenuItems}
                    onRetryCell={onRetryCell}
                    emptyText={emptyText}
                    filteredEmptyText={filteredEmptyText}
                />
            </div>

            <TableFooter
                shown={state.rows.length}
                total={table.rows.length}
                sortLabel={sortLabel}
                coverage={coverage}
                note={footerNote}
            />

            {overlay}
        </section>
    );
}

export default TableSurface;
