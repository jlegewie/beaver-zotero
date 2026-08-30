import React from "react";
import {
    rowActions,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { getHost, type ClientHost } from "../host";
import { ArrowUpRightIcon, FileViewIcon } from "../icons";
import IconButton from "../primitives/IconButton";

/**
 * The row's verbs, resolved and rendered.
 *
 * Which verbs a row offers is a fact about the data, so it is decided in
 * agent-core (`rowActions`): import only off-library, reveal and open only
 * in-library, nothing without a `ref`. This component only turns that answer
 * into controls, and it renders **nothing** when the host provides no slice for
 * them — an absent control beats a dead one.
 *
 * Import is deliberately delegated to the host's `externalReferenceActions`
 * rather than reimplemented: adding an item to the library is a mutation, and
 * that component is what carries it through the approval / undo pipeline.
 */
export function RowActionsView({
    table,
    row,
}: {
    table: TableSpec;
    row: Row;
}): React.ReactElement | null {
    const host = getHost();
    const actions = rowActions(table, row);
    const ref = row.ref;
    if (!ref || !canRender(host, row)) return null;

    if (ref.kind === "external") {
        // `canRender` already established both; repeated for narrowing.
        if (!ref.reference || !host.components) return null;
        // A row that is not in the library gets a labelled Add — the verb, not
        // a glyph to decode — and one already in it gets the reveal arrow.
        // Import stays the host's to render: it is a library write, and that
        // component is what carries it through approval and undo.
        return (
            <>
                {host.components.externalReferenceActions({
                    item: ref.reference,
                    buttonVariant: "surface",
                    importButtonMode: actions.includes("import")
                        ? "full"
                        : "none",
                    revealButtonMode: actions.includes("reveal")
                        ? "icon-only"
                        : "none",
                    pdfButtonMode: actions.includes("open")
                        ? "icon-only"
                        : "none",
                    detailsButtonMode: "none",
                    webButtonMode: "none",
                    showCitationCount: false,
                })}
            </>
        );
    }

    // A context-file row has no library identity, so there is nothing to reveal
    // or open — `rowActions` resolves no verbs for it, and `canRender` keeps
    // it out of the column count.
    if (ref.kind !== "item") return null;

    const navigation = host.navigation;
    if (!navigation) return null;
    const itemRef = {
        library_id: ref.library_id,
        zotero_key: ref.zotero_key,
        library_ref: ref.library_ref,
    };

    return (
        <>
            {actions.includes("reveal") ? (
                <IconButton
                    icon={ArrowUpRightIcon}
                    variant="ghost-secondary"
                    ariaLabel="Reveal in library"
                    title="Reveal in library"
                    onClick={(e) => {
                        e.stopPropagation();
                        navigation.revealInLibrary(itemRef);
                    }}
                />
            ) : null}
            {actions.includes("open") ? (
                <IconButton
                    icon={FileViewIcon}
                    variant="ghost-secondary"
                    ariaLabel="Open"
                    title="Open"
                    onClick={(e) => {
                        e.stopPropagation();
                        void navigation.openSource(itemRef);
                    }}
                />
            ) : null}
        </>
    );
}

/**
 * Whether the row's verbs can actually be drawn here: an external row needs the
 * bibliographic payload and the host's action component, a library row needs the
 * navigation slice, and a context file has no verbs at all. Split out so the
 * column's existence and the buttons in it can never disagree.
 */
function canRender(host: ClientHost, row: Row): boolean {
    const ref = row.ref;
    if (!ref) return false;
    if (ref.kind === "external") return !!ref.reference && !!host.components;
    if (ref.kind === "file") return false;
    return !!host.navigation;
}

/**
 * Whether any row would render an action — i.e. whether the actions column
 * earns its width. A rendering with no host draws no column at all rather than
 * an empty one.
 */
export function tableHasRowActions(table: TableSpec): boolean {
    const host = getHost();
    return table.rows.some(
        (row) => rowActions(table, row).length > 0 && canRender(host, row),
    );
}
