/**
 * The table's filter and sort menus, and the chips that show active filters.
 */
import React from "react";
import {
    anchorColumn,
    isColumnFilterable,
    isColumnSortable,
    selectLabelsInColumn,
    selectOption,
    type Filter,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import {
    ArrowDownIcon,
    ArrowUpIcon,
    CancelIcon,
    Icon,
    TickIcon,
} from "../icons";
import type { MenuItem } from "../primitives/ContextMenu";
import type { TableState } from "./useTableState";

/**
 * One chip per active filter, each removing its own. Chips are what keep a
 * narrowed table honest: the menu is out of sight once it closes, and a table
 * silently showing three of forty rows is how people misread a result set.
 */
export function FilterChips({
    table,
    state,
}: {
    table: TableSpec;
    state: TableState;
}): React.ReactElement | null {
    const chips = state.filters.flatMap((filter) => {
        const column = table.columns.find((c) => c.id === filter.column_id);
        if (!column) return [];
        return [{ column, text: describeFilter(filter) }];
    });
    if (chips.length === 0) return null;

    return (
        <>
            {chips.map(({ column, text }) => (
                <button
                    key={column.id}
                    type="button"
                    className="bt-chip"
                    title={`Remove the filter on ${column.header}`}
                    onClick={() => state.clearFilter(column.id)}
                >
                    <span className="bt-chip-column">{column.header}:</span>
                    <span className="bt-chip-value">{text}</span>
                    <Icon icon={CancelIcon} size={10} />
                </button>
            ))}
        </>
    );
}

function describeFilter(filter: Filter): string {
    switch (filter.kind) {
        case "in":
            return filter.labels.join(", ");
        case "contains":
            return `"${filter.text}"`;
        case "equals":
            return filter.value ? "yes" : "no";
        case "empty":
            return filter.empty ? "no value" : "has a value";
        case "range":
            return [filter.min, filter.max]
                .filter((v) => v != null)
                .join(" – ");
    }
}

/**
 * The filter menu is built from the spec, not configured per surface: a select
 * column offers its categories, a boolean column offers yes/no. Range filters
 * exist in the state hook but have no control yet — an honest gap rather than
 * a half-built one.
 */
export function buildFilterMenu(
    table: TableSpec,
    state: TableState,
): MenuItem[] {
    const items: MenuItem[] = [];
    const anchorId = anchorColumn(table)?.id;

    for (const column of table.columns) {
        if (!isColumnFilterable(column)) continue;

        if (
            column.id !== anchorId &&
            column.type !== "select" &&
            column.type !== "boolean" &&
            !state.hiddenColumns.has(column.id)
        ) {
            items.push(sectionItem(column.header));
            for (const [label, empty] of [
                ["Has a value", false],
                ["No value", true],
            ] as const) {
                const active = state.filters.some(
                    (f) =>
                        f.column_id === column.id &&
                        f.kind === "empty" &&
                        f.empty === empty,
                );
                items.push(
                    checkItem(label, active, () =>
                        state.toggleEmptyFilter(column.id, empty),
                    ),
                );
            }
            continue;
        }

        if (column.type === "select") {
            const labels = column.options?.length
                ? column.options.map((o) => o.label)
                : selectLabelsInColumn(table, column.id);
            if (labels.length === 0) continue;
            items.push(sectionItem(column.header));
            for (const label of labels) {
                const active = state.filters.some(
                    (f) =>
                        f.column_id === column.id &&
                        f.kind === "in" &&
                        f.labels.includes(label),
                );
                items.push(
                    checkItem(
                        label,
                        active,
                        () => state.toggleSelectFilter(column.id, label),
                        selectOption(column, label)?.description || undefined,
                    ),
                );
            }
        }

        if (column.type === "boolean") {
            items.push(sectionItem(column.header));
            for (const [label, value] of [
                ["Yes", true],
                ["No", false],
            ] as const) {
                const active = state.filters.some(
                    (f) =>
                        f.column_id === column.id &&
                        f.kind === "equals" &&
                        f.value === value,
                );
                items.push(
                    checkItem(label, active, () =>
                        state.toggleBooleanFilter(column.id, value),
                    ),
                );
            }
        }
    }

    if (items.length === 0) return [];
    if (state.hasFilters)
        items.push({
            label: "Clear all filters",
            onClick: () => state.clearFilters(),
        });
    return items;
}

/**
 * One entry per sortable column in view; picking the sorted column again
 * flips its direction, and "Original order" restores the table's own.
 */
export function buildSortMenu(table: TableSpec, state: TableState): MenuItem[] {
    const items: MenuItem[] = [];
    for (const column of table.columns) {
        if (!isColumnSortable(column) || state.hiddenColumns.has(column.id))
            continue;
        const direction =
            state.sort?.column_id === column.id
                ? state.sort.direction
                : undefined;
        items.push({
            label: column.header,
            onClick: () =>
                state.setSort({
                    column_id: column.id,
                    direction: direction === "asc" ? "desc" : "asc",
                }),
            customContent: (
                <div
                    className={`bt-menu-check${direction ? " bt-checked" : ""}`}
                >
                    <span className="bt-menu-tick" aria-hidden="true">
                        <Icon
                            icon={
                                direction === "desc"
                                    ? ArrowDownIcon
                                    : ArrowUpIcon
                            }
                            size={12}
                        />
                    </span>
                    <span>{column.header}</span>
                </div>
            ),
        });
    }
    if (items.length > 0 && state.sort)
        items.push({
            label: "Original order",
            onClick: () => state.setSort(undefined),
        });
    return items;
}

function sectionItem(label: string): MenuItem {
    return {
        label,
        onClick: () => {},
        disabled: true,
        customContent: <div className="bt-menu-section">{label}</div>,
    };
}

function checkItem(
    label: string,
    active: boolean,
    onClick: () => void,
    /** Shown on hover: what a select category means. */
    title?: string,
): MenuItem {
    return {
        label,
        onClick,
        customContent: (
            <div
                className={`bt-menu-check${active ? " bt-checked" : ""}`}
                title={title}
            >
                <span className="bt-menu-tick" aria-hidden="true">
                    <Icon icon={TickIcon} size={12} />
                </span>
                <span>{label}</span>
            </div>
        ),
    };
}
