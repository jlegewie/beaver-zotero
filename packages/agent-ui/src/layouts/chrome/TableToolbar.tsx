import React from "react";
import {
    anchorColumn,
    isColumnFilterable,
    selectLabelsInColumn,
    type Column,
    type Filter,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import {
    CancelIcon,
    FilterIcon,
    Icon,
    LayersIcon,
    TickIcon,
} from "../../icons";
import MenuButton from "../../primitives/MenuButton";
import type { MenuItem } from "../../primitives/ContextMenu";
import {
    DENSITY_LABELS,
    TABLE_DENSITIES,
    type TableDensity,
} from "../tableView";
import type { TableState } from "../useTableState";

export interface TableToolbarProps {
    table: TableSpec;
    state: TableState;
    /** Rows in view / rows in total, rendered on the right. */
    shown: number;
    total: number;
    /** Surface-specific controls, placed before the view controls (e.g. "Add column"). */
    actions?: React.ReactNode;
    /**
     * Opt-in free-text filter. Off by default: for a table of a few dozen rows
     * the filter menu is both faster and more precise, and a search box that
     * only matches visible text sets the wrong expectation.
     */
    showSearch?: boolean;
    searchPlaceholder?: string;
}

/**
 * The view controls: filter, active-filter chips, row height, column
 * visibility. Everything here narrows or reshapes what the grid shows and
 * nothing here mutates the spec, which is why it can be the same toolbar for
 * every kind of table.
 */
export function TableToolbar({
    table,
    state,
    shown,
    total,
    actions,
    showSearch = false,
    searchPlaceholder = "Filter rows",
}: TableToolbarProps): React.ReactElement {
    const filterable = table.capabilities?.filterable ?? true;
    const filterItems = filterable ? buildFilterMenu(table, state) : [];

    return (
        <div className="bt-toolbar">
            {filterItems.length > 0 ? (
                <MenuButton
                    menuItems={filterItems}
                    variant={state.hasFilters ? "surface" : "ghost-secondary"}
                    icon={FilterIcon}
                    buttonLabel="Filter"
                    className={`bt-toolbar-button${state.hasFilters ? " bt-active" : ""}`}
                    ariaLabel="Filter rows"
                    maxHeight="24rem"
                    width="16rem"
                />
            ) : null}

            {showSearch ? (
                <input
                    type="search"
                    className="bt-search"
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                    value={state.quickFilter}
                    onChange={(e) => state.setQuickFilter(e.target.value)}
                />
            ) : null}

            <FilterChips table={table} state={state} />

            <span className="bt-spacer" />

            <span className="bt-rowcount" aria-live="polite">
                {shown === total
                    ? `${total} ${total === 1 ? "row" : "rows"}`
                    : `${shown} of ${total}`}
            </span>

            {actions}

            <DensityControl
                density={state.density}
                onChange={state.setDensity}
            />

            <ColumnsMenu table={table} state={state} />
        </div>
    );
}

/**
 * One chip per active filter, each removing its own. Chips are what keep a
 * narrowed table honest: the menu is out of sight once it closes, and a table
 * silently showing three of forty rows is how people misread a result set.
 */
function FilterChips({
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
            return filter.empty ? "empty" : "not empty";
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
function buildFilterMenu(table: TableSpec, state: TableState): MenuItem[] {
    const items: MenuItem[] = [];

    for (const column of table.columns) {
        if (!isColumnFilterable(column)) continue;

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
                    checkItem(label, active, () =>
                        state.toggleSelectFilter(column.id, label),
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
): MenuItem {
    return {
        label,
        onClick,
        customContent: (
            <div className={`bt-menu-check${active ? " bt-checked" : ""}`}>
                <span className="bt-menu-tick" aria-hidden="true">
                    <Icon icon={TickIcon} size={12} />
                </span>
                <span>{label}</span>
            </div>
        ),
    };
}

function DensityControl({
    density,
    onChange,
}: {
    density: TableDensity;
    onChange(next: TableDensity): void;
}): React.ReactElement {
    return (
        <div className="bt-density" role="group" aria-label="Row height">
            {TABLE_DENSITIES.map((option) => (
                <button
                    key={option}
                    type="button"
                    className={`bt-density-option${density === option ? " bt-active" : ""}`}
                    aria-pressed={density === option}
                    title={DENSITY_LABELS[option]}
                    onClick={() => onChange(option)}
                >
                    <span className={`bt-density-glyph bt-density-${option}`} />
                </button>
            ))}
        </div>
    );
}

function ColumnsMenu({
    table,
    state,
}: {
    table: TableSpec;
    state: TableState;
}): React.ReactElement | null {
    // The anchor is exempt: it carries row identity, and `DataTable` keeps it
    // visible regardless — offering it here would leave a checkbox that lies.
    const anchorId = anchorColumn(table)?.id;
    const hideable = table.columns.filter((c: Column) => c.id !== anchorId);
    // A single hideable column earns no menu — unless it started hidden (a
    // lone system column), in which case the menu is the only way back.
    if (hideable.length < 2 && state.hiddenColumns.size === 0) return null;

    const items: MenuItem[] = hideable.map((column) =>
        checkItem(column.header, !state.hiddenColumns.has(column.id), () =>
            state.toggleColumn(column.id),
        ),
    );
    if (state.hiddenColumns.size > 0)
        items.push({
            label: "Show all columns",
            onClick: state.showAllColumns,
        });

    return (
        <MenuButton
            menuItems={items}
            variant="ghost-secondary"
            icon={LayersIcon}
            className="bt-toolbar-button"
            ariaLabel="Show and hide columns"
            tooltipContent="Columns"
            maxHeight="24rem"
            width="14rem"
        />
    );
}
