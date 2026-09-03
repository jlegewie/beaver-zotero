import { useCallback, useMemo, useState } from "react";
import {
    cellValueText,
    defaultHiddenColumnIds,
    filterRows,
    isColumnFilterable,
    sortRows,
    toCsv,
    type Filter,
    type Row,
    type TableSort,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import type { TableDensity } from "./tableView";

/**
 * View state of a rendered table: sort, filters, density, and what is expanded
 * or selected.
 *
 * All of it is ephemeral and local to the component — the spec is never
 * mutated, and nothing here reads a global store, so the same hook serves the
 * sidebar, the window and an isolated render root alike. The grid and the
 * chrome around it share one instance, which is why this is a hook the surface
 * owns rather than state hidden inside `DataTable`.
 */
export interface TableState {
    sort: TableSort | undefined;
    /** asc → desc → none on repeated calls for the same column. */
    toggleSort(columnId: string): void;

    density: TableDensity;
    setDensity(density: TableDensity): void;

    /** Substring match across every filterable column (OR), case-insensitive. */
    quickFilter: string;
    setQuickFilter(text: string): void;
    /** Per-column filters (AND). Setting a filter replaces the column's previous one. */
    filters: Filter[];
    setFilter(filter: Filter): void;
    clearFilter(columnId: string): void;
    clearFilters(): void;
    /** Toggle membership of one select label in the column's `in` filter. */
    toggleSelectFilter(columnId: string, label: string): void;
    /** Toggle a boolean column's `equals` filter; passing the active value clears it. */
    toggleBooleanFilter(columnId: string, value: boolean): void;
    /** True when anything narrows the view — what the Filter control lights up on. */
    hasFilters: boolean;

    /** Rows after filtering and sorting, in display order. */
    rows: Row[];

    /**
     * Columns the viewer has hidden. The spec is untouched — hiding is a view
     * preference, so a hidden column keeps its data and comes back on request.
     */
    hiddenColumns: ReadonlySet<string>;
    toggleColumn(columnId: string): void;
    showAllColumns(): void;

    expandedRows: ReadonlySet<string>;
    toggleRow(rowId: string): void;

    /**
     * Selected row ids. Selection drives bulk verbs in the chrome (import the
     * selection, export it), so it lives here rather than in a surface.
     */
    selectedRows: ReadonlySet<string>;
    toggleRowSelection(rowId: string): void;
    /** Selects every row currently in view, or clears when all of them already are. */
    toggleSelectAll(): void;
    clearSelection(): void;
    allInViewSelected: boolean;
}

export interface UseTableStateOptions {
    /** Initial density. The chrome's density control moves it from there. */
    density?: TableDensity;
}

/** The table a hidden-column set was seeded for. */
interface TableIdentity {
    key?: string;
    id: string;
}

/**
 * Whether two specs are the same table. Stored keys settle it — except that a
 * table gaining its first key (an unsaved table just persisted) is still the
 * table it was, so a missing previous key defers to the render id.
 *
 * Two *unstored* tables sharing a render id cannot be told apart from their
 * specs at all. A surface that shows unstored tables in turn must remount for
 * each (a React `key` on the showing, as the Beaver window does), which resets
 * every part of this state and not just the columns.
 */
function isSameTable(a: TableIdentity, b: TableIdentity): boolean {
    if (a.key !== undefined && b.key !== undefined) return a.key === b.key;
    if (a.key !== undefined && b.key === undefined) return false;
    return a.id === b.id;
}

function toggleInSet(set: ReadonlySet<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
}

function matchesQuickFilter(spec: TableSpec, row: Row, query: string): boolean {
    const needle = query.toLocaleLowerCase();
    return spec.columns.some((column) => {
        if (!isColumnFilterable(column)) return false;
        return cellValueText(row.cells[column.id]?.value)
            .toLocaleLowerCase()
            .includes(needle);
    });
}

/** Stands in for the spec when the caller owns the state — see {@link useOptionalTableState}. */
const EMPTY_TABLE: TableSpec = { id: "", columns: [], rows: [] };

/**
 * {@link useTableState}, or the caller's instance when one was passed.
 *
 * Hooks cannot be conditional, so the spare {@link useTableState} still runs.
 * Running it against the real spec would repeat the filter and sort passes on
 * every render, so it runs against an empty spec instead.
 */
export function useOptionalTableState(
    spec: TableSpec,
    external: TableState | undefined,
    options: UseTableStateOptions = {},
): TableState {
    const internal = useTableState(external ? EMPTY_TABLE : spec, options);
    return external ?? internal;
}

export function useTableState(
    spec: TableSpec,
    options: UseTableStateOptions = {},
): TableState {
    const [sort, setSort] = useState<TableSort | undefined>(spec.sort);
    const [density, setDensity] = useState<TableDensity>(
        options.density ?? "cozy",
    );
    const [quickFilter, setQuickFilter] = useState("");
    const [filters, setFilters] = useState<Filter[]>([]);
    const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const [selectedRows, setSelectedRows] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    // Which columns are hidden is derived, not stored: the spec's defaults
    // (system columns hidden, the row-type column shown once the table mixes
    // kinds) overlaid with the columns the viewer has explicitly toggled. So a
    // table that gains its first annotation row shows its type column at once,
    // while a column the viewer hid stays hidden. The overrides last as long
    // as the table does; a different table starts with none.
    const [columnOverrides, setColumnOverrides] = useState<
        ReadonlyMap<string, boolean>
    >(() => new Map());
    const identity: TableIdentity = { key: spec.key, id: spec.id };
    const [hiddenFor, setHiddenFor] = useState(identity);
    if (!isSameTable(hiddenFor, identity)) {
        setHiddenFor(identity);
        setColumnOverrides(new Map());
    } else if (hiddenFor.key !== identity.key) {
        // Same table, now stored: remember the key so a later table with the
        // same render id is not mistaken for it.
        setHiddenFor(identity);
    }
    const hiddenColumns = useMemo<ReadonlySet<string>>(() => {
        const hidden = new Set(defaultHiddenColumnIds(spec));
        for (const [id, isHidden] of columnOverrides) {
            if (isHidden) hidden.add(id);
            else hidden.delete(id);
        }
        return hidden;
    }, [spec, columnOverrides]);

    const toggleSort = useCallback((columnId: string) => {
        setSort((current) => {
            if (current?.column_id !== columnId)
                return { column_id: columnId, direction: "asc" };
            if (current.direction === "asc")
                return { column_id: columnId, direction: "desc" };
            return undefined;
        });
    }, []);

    const setFilter = useCallback((filter: Filter) => {
        setFilters((current) => [
            ...current.filter((f) => f.column_id !== filter.column_id),
            filter,
        ]);
    }, []);

    const clearFilter = useCallback((columnId: string) => {
        setFilters((current) =>
            current.filter((f) => f.column_id !== columnId),
        );
    }, []);

    const clearFilters = useCallback(() => {
        setFilters([]);
        setQuickFilter("");
    }, []);

    const toggleSelectFilter = useCallback(
        (columnId: string, label: string) => {
            setFilters((current) => {
                const existing = current.find((f) => f.column_id === columnId);
                const labels = existing?.kind === "in" ? existing.labels : [];
                const next = labels.includes(label)
                    ? labels.filter((l) => l !== label)
                    : [...labels, label];
                const rest = current.filter((f) => f.column_id !== columnId);
                return next.length
                    ? [
                          ...rest,
                          { column_id: columnId, kind: "in", labels: next },
                      ]
                    : rest;
            });
        },
        [],
    );

    const toggleBooleanFilter = useCallback(
        (columnId: string, value: boolean) => {
            setFilters((current) => {
                const existing = current.find((f) => f.column_id === columnId);
                const rest = current.filter((f) => f.column_id !== columnId);
                // Picking the value that is already active means "stop
                // filtering by it", so one control both sets and clears.
                if (existing?.kind === "equals" && existing.value === value)
                    return rest;
                return [
                    ...rest,
                    { column_id: columnId, kind: "equals", value },
                ];
            });
        },
        [],
    );

    const rows = useMemo(() => {
        const filtered = filterRows(spec, filters);
        const quick = quickFilter.trim();
        const searched = quick
            ? filtered.filter((row) => matchesQuickFilter(spec, row, quick))
            : filtered;
        return sortRows({ ...spec, rows: searched }, sort);
    }, [spec, filters, quickFilter, sort]);

    const toggleRow = useCallback(
        (rowId: string) => setExpandedRows((s) => toggleInSet(s, rowId)),
        [],
    );
    const toggleRowSelection = useCallback(
        (rowId: string) => setSelectedRows((s) => toggleInSet(s, rowId)),
        [],
    );
    const clearSelection = useCallback(() => setSelectedRows(new Set()), []);
    const toggleColumn = useCallback(
        (columnId: string) =>
            setColumnOverrides((current) =>
                new Map(current).set(columnId, !hiddenColumns.has(columnId)),
            ),
        [hiddenColumns],
    );
    const showAllColumns = useCallback(
        () =>
            setColumnOverrides(
                new Map(spec.columns.map((column) => [column.id, false])),
            ),
        [spec.columns],
    );

    const allInViewSelected =
        rows.length > 0 && rows.every((row) => selectedRows.has(row.id));

    const toggleSelectAll = useCallback(() => {
        setSelectedRows((current) => {
            const all =
                rows.length > 0 && rows.every((row) => current.has(row.id));
            return all ? new Set() : new Set(rows.map((row) => row.id));
        });
    }, [rows]);

    return {
        sort,
        toggleSort,
        density,
        setDensity,
        quickFilter,
        setQuickFilter,
        filters,
        setFilter,
        clearFilter,
        clearFilters,
        toggleSelectFilter,
        toggleBooleanFilter,
        hasFilters: filters.length > 0 || quickFilter.trim().length > 0,
        rows,
        hiddenColumns,
        toggleColumn,
        showAllColumns,
        expandedRows,
        toggleRow,
        selectedRows,
        toggleRowSelection,
        toggleSelectAll,
        clearSelection,
        allInViewSelected,
    };
}

/**
 * CSV of the current view — filtered and sorted, not the whole spec.
 * Exporting the unfiltered table after the viewer narrowed it hands them the
 * wrong file.
 */
export function csvForCurrentView(table: TableSpec, state: TableState): string {
    return toCsv(table, state.rows);
}
