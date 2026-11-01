import { useCallback, useMemo, useState } from "react";
import {
    cellValueText,
    defaultHiddenColumnIds,
    filterRows,
    isColumnFilterable,
    sortRows,
    type Filter,
    type Row,
    type TableSort,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import type { TableDensity } from "./tableView";

/**
 * View state of a rendered table: sort, filters, density, hidden columns and
 * selected rows.
 *
 * All of it is ephemeral and local to the component — the spec is never
 * mutated, and nothing here reads a global store. The grid and the toolbar
 * around it share one instance, owned by the table component.
 */
export interface TableState {
    sort: TableSort | undefined;
    /** Replaces the sort; `undefined` restores the table's own order. */
    setSort(sort: TableSort | undefined): void;

    density: TableDensity;
    setDensity(density: TableDensity): void;

    /** Substring match across every filterable column (OR), case-insensitive. */
    quickFilter: string;
    setQuickFilter(text: string): void;
    /** Per-column filters (AND). Setting a filter replaces the column's previous one. */
    filters: Filter[];
    clearFilter(columnId: string): void;
    clearFilters(): void;
    /** Toggle membership of one select label in the column's `in` filter. */
    toggleSelectFilter(columnId: string, label: string): void;
    /** Toggle a boolean column's `equals` filter; passing the active value clears it. */
    toggleBooleanFilter(columnId: string, value: boolean): void;
    /**
     * Toggle a column's `empty` filter: rows without a value (`true`) or with
     * one (`false`). Passing the active choice clears it.
     */
    toggleEmptyFilter(columnId: string, empty: boolean): void;
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
    /**
     * Show only these rows, on top of the viewer's own filters — a surface
     * pointing at a set of rows ("Show" the rows a fill could not read).
     */
    onlyRows?: ReadonlySet<string> | null;
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
    const [selectedRows, setSelectedRows] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    // Which columns are hidden is derived, not stored: the spec's defaults
    // (system columns hidden) overlaid with the columns the viewer has
    // explicitly toggled. The overrides last as long as the table does; a
    // different table starts with none.
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

    const toggleEmptyFilter = useCallback(
        (columnId: string, empty: boolean) => {
            setFilters((current) => {
                const existing = current.find((f) => f.column_id === columnId);
                const rest = current.filter((f) => f.column_id !== columnId);
                if (existing?.kind === "empty" && existing.empty === empty)
                    return rest;
                return [...rest, { column_id: columnId, kind: "empty", empty }];
            });
        },
        [],
    );

    const onlyRows = options.onlyRows ?? null;
    const rows = useMemo(() => {
        const narrowed = onlyRows
            ? { ...spec, rows: spec.rows.filter((row) => onlyRows.has(row.id)) }
            : spec;
        const filtered = filterRows(narrowed, filters);
        const quick = quickFilter.trim();
        const searched = quick
            ? filtered.filter((row) => matchesQuickFilter(spec, row, quick))
            : filtered;
        return sortRows({ ...spec, rows: searched }, sort);
    }, [spec, filters, quickFilter, sort, onlyRows]);

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
        setSort,
        density,
        setDensity,
        quickFilter,
        setQuickFilter,
        filters,
        clearFilter,
        clearFilters,
        toggleSelectFilter,
        toggleBooleanFilter,
        toggleEmptyFilter,
        hasFilters: filters.length > 0 || quickFilter.trim().length > 0,
        rows,
        hiddenColumns,
        toggleColumn,
        selectedRows,
        toggleRowSelection,
        toggleSelectAll,
        clearSelection,
        allInViewSelected,
    };
}
