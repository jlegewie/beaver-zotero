import React from "react";
import {
    anchorColumn,
    rowActionTarget,
    rowActions,
    rowPrimaryAction,
    type Row,
    type RowAction,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { getHost, type ClientHost } from "../host";
import { anchorActionHandler, rowActionHandler } from "./rowActionHandlers";
import { ArrowUpRightIcon, FileViewIcon } from "../icons";
import IconButton from "../primitives/IconButton";

type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;

/**
 * The row's verbs, resolved and rendered.
 *
 * Which verbs a row offers is a fact about the data, decided in agent-core
 * (`rowActions`), and how each is performed is the host's (`rowActionHandler`).
 * This component only turns those answers into controls, and it renders
 * **nothing** when the host provides no slice for them — an absent control
 * beats a dead one.
 */
export function RowActionsView({
    table,
    row,
}: {
    table: TableSpec;
    row: Row;
}): React.ReactElement | null {
    const controls = rowActionControls(table, row, getHost());
    if (controls.length === 0) return null;
    return <>{controls}</>;
}

/** Glyph and label for each verb that renders as a plain button. */
const ACTION_BUTTONS: Record<
    Exclude<RowAction, "import">,
    { icon: IconComponent; label: string }
> = {
    reveal: { icon: ArrowUpRightIcon, label: "Reveal in library" },
    open: { icon: FileViewIcon, label: "Open" },
};

function rowActionControls(
    table: TableSpec,
    row: Row,
    host: ClientHost,
): React.ReactElement[] {
    const controls: React.ReactElement[] = [];
    for (const action of visibleRowActions(table, row)) {
        if (action === "import") {
            const target = rowActionTarget(row, action);
            if (target?.kind !== "import_reference" || !host.components)
                continue;
            // Import is a library write, so the host's own component carries
            // it through approval and undo. It keeps the reveal glyph too: once
            // the import lands, that component is what flips the control from
            // "Add" to "Reveal" until the stored row catches up.
            controls.push(
                <React.Fragment key={action}>
                    {host.components.externalReferenceActions({
                        item: target.reference,
                        buttonVariant: "surface",
                        importButtonMode: "full",
                        revealButtonMode: "icon-only",
                        pdfButtonMode: "none",
                        detailsButtonMode: "none",
                        webButtonMode: "none",
                        showCitationCount: false,
                    })}
                </React.Fragment>,
            );
            continue;
        }
        const handler = rowActionHandler(row, action, host);
        if (!handler) continue;
        const { icon, label } = ACTION_BUTTONS[action];
        controls.push(
            <IconButton
                key={action}
                icon={icon}
                variant="ghost-secondary"
                ariaLabel={label}
                title={label}
                onClick={(e) => {
                    e.stopPropagation();
                    handler();
                }}
            />,
        );
    }
    return controls;
}

/**
 * The verbs this row draws in the actions column, which is not quite
 * {@link rowActions}: the kind's primary verb is omitted when the anchor cell
 * already carries it (`anchorActionHandler` in `cells.tsx`), because drawing it
 * again is the same control twice on one row. The anchor is never hidden by
 * density or the viewer's column choices, so this cannot drop the only copy.
 */
function visibleRowActions(table: TableSpec, row: Row): RowAction[] {
    const actions = rowActions(table, row);
    const primary = rowPrimaryAction(row);
    if (
        !primary ||
        !actions.includes(primary) ||
        !anchorCarriesAction(table, row)
    )
        return actions;
    return actions.filter((action) => action !== primary);
}

/** Whether the row's anchor cell draws the primary verb: it has a subject value and a handler. */
function anchorCarriesAction(table: TableSpec, row: Row): boolean {
    const anchor = anchorColumn(table);
    if (!anchor) return false;
    const kind = row.cells[anchor.id]?.value?.kind;
    return (
        (kind === "reference" || kind === "annotation") &&
        !!anchorActionHandler(table, row)
    );
}

/**
 * Whether any row would render an action — i.e. whether the actions column
 * earns its width. A rendering with no host draws no column at all rather than
 * an empty one.
 */
export function tableHasRowActions(table: TableSpec): boolean {
    const host = getHost();
    return table.rows.some(
        (row) => rowActionControls(table, row, host).length > 0,
    );
}
