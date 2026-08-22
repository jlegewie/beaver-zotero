import React from "react";
import {
    columnAlign,
    isColumnSortable,
    type Column,
    type TableSort,
} from "@beaver/agent-core/layouts/table";
import {
    ArrowDownIcon,
    ArrowUpIcon,
    Icon,
    InformationCircleIcon,
    MoreHorizontalIcon,
    SortIcon,
} from "../icons";
import MenuButton from "../primitives/MenuButton";
import type { MenuItem } from "../primitives/ContextMenu";
import { columnTypeIcon } from "./tableView";

export interface ColumnHeaderCellProps {
    column: Column;
    isAnchor: boolean;
    sort: TableSort | undefined;
    sortable: boolean;
    onSort(columnId: string): void;
    /** Full density shows the column's question under its name; compact has no room. */
    showDescription: boolean;
    /** When it returns items, the header gains a menu (edit / re-run / remove a column). */
    menuItems?: MenuItem[];
}

/**
 * A column header, which in this table is more than a label.
 *
 * `Column.description` is the column's question and is rendered as a second
 * line rather than a tooltip — for an extraction column it *is* the extraction
 * prompt, so the header states the contract the cells were filled against.
 * A column being populated carries its own progress, so the header can say
 * "6 of 9" without anyone counting pending cells.
 *
 * Every column sorts. The affordance appears on hover so a resting header row
 * stays quiet; the active column keeps a solid arrow.
 */
export function ColumnHeaderCell({
    column,
    isAnchor,
    sort,
    sortable,
    onSort,
    showDescription,
    menuItems,
}: ColumnHeaderCellProps): React.ReactElement {
    const canSort = sortable && isColumnSortable(column);
    const direction =
        sort?.column_id === column.id ? sort.direction : undefined;
    const align = columnAlign(column);
    const progress = column.progress;
    const details = detailsText(column);

    const label = (
        <>
            <span className="bt-th-glyph" aria-hidden="true">
                <Icon icon={columnTypeIcon(column.type)} size={12} />
            </span>
            <span className="bt-th-label">{column.header}</span>
            {canSort ? (
                <span
                    className={`bt-th-sort${direction ? ` bt-th-sort-${direction}` : ""}`}
                    aria-hidden="true"
                >
                    <Icon
                        icon={
                            direction === "asc"
                                ? ArrowUpIcon
                                : direction === "desc"
                                  ? ArrowDownIcon
                                  : SortIcon
                        }
                        size={12}
                    />
                </span>
            ) : null}
        </>
    );

    return (
        <th
            // `Column.details` rides on the native `title`. A custom tooltip
            // cannot work here: `.bt-th` is `position: sticky`, which creates a
            // stacking context, so a popup rendered inside it can never paint
            // over the sticky rail, the anchor header or the dialog overlay —
            // and portalling out of it crashes in a Zotero chrome document.
            title={details}
            className={[
                "bt-th",
                `bt-align-${align}`,
                isAnchor ? "bt-th-anchor" : "",
                canSort ? "bt-th-sortable" : "",
            ]
                .filter(Boolean)
                .join(" ")}
            aria-sort={
                direction
                    ? direction === "asc"
                        ? "ascending"
                        : "descending"
                    : undefined
            }
            scope="col"
        >
            <div className="bt-th-inner">
                <div className="bt-th-top">
                    {canSort ? (
                        <button
                            type="button"
                            className="bt-th-button"
                            onClick={() => onSort(column.id)}
                        >
                            {label}
                        </button>
                    ) : (
                        <span className="bt-th-button bt-th-static">
                            {label}
                        </span>
                    )}
                    {details ? (
                        <span className="bt-th-info" aria-hidden="true">
                            <Icon icon={InformationCircleIcon} size={12} />
                        </span>
                    ) : null}
                    {menuItems && menuItems.length > 0 ? (
                        <MenuButton
                            menuItems={menuItems}
                            variant="ghost-secondary"
                            icon={MoreHorizontalIcon}
                            className="bt-th-menu"
                            ariaLabel={`${column.header} column options`}
                        />
                    ) : null}
                </div>

                {showDescription && column.description ? (
                    <div
                        className="bt-th-description"
                        title={column.description}
                    >
                        {column.description}
                    </div>
                ) : null}

                {column.status === "filling" ? (
                    <div className="bt-th-progress">
                        <span className="bt-progress-track">
                            <span
                                className="bt-progress-fill"
                                style={{
                                    width:
                                        progress && progress.total > 0
                                            ? `${Math.round((progress.done / progress.total) * 100)}%`
                                            : "0%",
                                }}
                            />
                        </span>
                        {progress ? (
                            <span className="bt-progress-label">
                                {progress.done} of {progress.total}
                            </span>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </th>
    );
}

/**
 * `Column.details` as one string: the long form behind the header line — the
 * full prompt where the line is clamped, the coding rules, the unit
 * convention. Flattened because it is delivered through `title`, which the
 * platform also exposes as the header's accessible description.
 */
function detailsText(column: Column): string | undefined {
    const details = column.details;
    if (!details) return undefined;
    return details.kind === "text" ? details.text : details.items.join("\n");
}
