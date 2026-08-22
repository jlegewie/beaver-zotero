import { useCallback, useMemo, useState } from "react";
import {
    cellValueText,
    filterRows,
    isColumnFilterable,
    sortRows,
    type Filter,
    type Row,
    type TableSort,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";

/**
 * View state of a rendered table: sort, filters and what is expanded.
 *
 * All of it is ephemeral and local to the component — the spec is never
 * mutated, and nothing here reads a global store, so the same hook serves the
 * sidebar, the window and an isolated render root alike.
 */
export interface TableState {
    sort: TableSort | undefined;
    /** asc → desc → none on repeated calls for the same column. */
    toggleSort(columnId: string): void;
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
    /** Rows after filtering and sorting, in display order. */
    rows: Row[];
    expandedRows: ReadonlySet<string>;
    toggleRow(rowId: string): void;
    expandedCells: ReadonlySet<string>;
    toggleCell(cellId: string): void;
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

export function useTableState(spec: TableSpec): TableState {
    const [sort, setSort] = useState<TableSort | undefined>(spec.sort);
    const [quickFilter, setQuickFilter] = useState("");
    const [filters, setFilters] = useState<Filter[]>([]);
    const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const [expandedCells, setExpandedCells] = useState<ReadonlySet<string>>(
        () => new Set(),
    );

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
    const toggleCell = useCallback(
        (cellId: string) => setExpandedCells((s) => toggleInSet(s, cellId)),
        [],
    );

    return {
        sort,
        toggleSort,
        quickFilter,
        setQuickFilter,
        filters,
        setFilter,
        clearFilter,
        clearFilters,
        toggleSelectFilter,
        rows,
        expandedRows,
        toggleRow,
        expandedCells,
        toggleCell,
    };
}
