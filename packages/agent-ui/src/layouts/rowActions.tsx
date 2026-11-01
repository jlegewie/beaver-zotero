import React from "react";
import {
    rowActionTarget,
    rowActions,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { getHost } from "../host";

/**
 * The host's Add control for a row the table lets the user import (an
 * external work not yet in the library), or nothing. Importing is a library
 * write that runs through the host's approval and undo, so the control is the
 * host's own. It keeps a reveal glyph: once the import lands, that component
 * is what flips from "Add" to "Reveal" until the stored row catches up.
 */
export function RowImportAction({
    table,
    row,
}: {
    table: TableSpec;
    row: Row;
}): React.ReactElement | null {
    if (!rowActions(table, row).includes("import")) return null;
    const target = rowActionTarget(row, "import");
    const host = getHost();
    if (target?.kind !== "import_reference" || !host.components) return null;
    return (
        <>
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
        </>
    );
}
