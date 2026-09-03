import React from "react";
import {
    rowActionTarget,
    rowActions,
    rowPrimaryAction,
    type Row,
    type RowAction,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { getHost, type ClientHost } from "../host";
import { anchorActionHandler, rowActionHandler } from "./rowActionHandlers";
import { ArrowUpRightIcon, FileViewIcon, MoreHorizontalIcon } from "../icons";
import IconButton from "../primitives/IconButton";
import MenuButton from "../primitives/MenuButton";
import type { MenuItem } from "../primitives/ContextMenu";

type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;

/** Glyph and label for each verb, as a control or a menu entry. */
const ACTION_UI: Record<
    Exclude<RowAction, "import">,
    { icon: IconComponent; label: string }
> = {
    reveal: { icon: ArrowUpRightIcon, label: "Reveal in library" },
    open: { icon: FileViewIcon, label: "Open" },
};

/**
 * The row's verbs, rendered at the edge of its anchor cell.
 *
 * The anchor is sticky, so this is the one place on a row that never scrolls
 * away — an action as common as "go to this item" cannot live in a column that
 * is the first to vanish on a narrow surface. The kind's primary verb, which the
 * title also carries, gets a glyph; the rest go behind a small menu; an
 * off-library external row gets the host's own Add control, because importing
 * is a library write that runs through the host's approval and undo.
 *
 * Mounted by the grid on the anchor `<td>`, not by the anchor's value: a row
 * whose anchor cell is still filling, failed or empty keeps its verbs, and a
 * second reference-valued column does not grow a copy of them.
 *
 * Which verbs a row offers is a fact about the data, decided in agent-core
 * (`rowActions`); how each is performed is the host's (`rowActionHandler`).
 * This only turns those answers into controls, and renders **nothing** when
 * the host has no slice for them — an absent control beats a dead one.
 */
export function RowActionsView({
    table,
    row,
}: {
    table: TableSpec;
    row: Row;
}): React.ReactElement | null {
    const host = getHost();
    const controls: React.ReactElement[] = [];
    const declared = rowActions(table, row);

    const importControl = declared.includes("import")
        ? importAction(row, host)
        : null;
    if (importControl) controls.push(importControl);

    const primary = rowPrimaryAction(row);
    const primaryHandler = anchorActionHandler(table, row, host);
    if (primary && primary !== "import" && primaryHandler) {
        const { icon, label } = ACTION_UI[primary];
        controls.push(
            <IconButton
                key={primary}
                icon={icon}
                variant="ghost-secondary"
                ariaLabel={label}
                title={label}
                onClick={(e) => {
                    e.stopPropagation();
                    primaryHandler();
                }}
            />,
        );
    }

    const items: MenuItem[] = [];
    for (const action of declared) {
        if (action === "import" || action === primary) continue;
        const handler = rowActionHandler(row, action, host);
        if (!handler) continue;
        const { icon, label } = ACTION_UI[action];
        items.push({ label, icon, onClick: handler });
    }
    if (items.length > 0)
        controls.push(
            <MenuButton
                key="more"
                menuItems={items}
                variant="ghost-secondary"
                icon={MoreHorizontalIcon}
                className="bt-ref-more"
                ariaLabel="More actions"
            />,
        );

    if (controls.length === 0) return null;
    return <span className="bt-ref-actions">{controls}</span>;
}

/**
 * The host's Add control for a row that can be imported. It keeps a reveal
 * glyph of its own: once the import lands, that component is what flips from
 * "Add" to "Reveal" until the stored row catches up.
 */
function importAction(row: Row, host: ClientHost): React.ReactElement | null {
    const target = rowActionTarget(row, "import");
    if (target?.kind !== "import_reference" || !host.components) return null;
    return (
        <React.Fragment key="import">
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
        </React.Fragment>
    );
}
