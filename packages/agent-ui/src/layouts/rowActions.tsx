import React from "react";
import {
    rowActions,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { getHost, type ClientHost } from "../host";
import { FileViewIcon, LibraryIcon } from "../icons";
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
        const mode = (action: (typeof actions)[number]) =>
            actions.includes(action) ? "icon-only" : "none";
        return (
            <>
                {host.components.externalReferenceActions({
                    item: ref.reference,
                    buttonVariant: "ghost-secondary",
                    importButtonMode: mode("import"),
                    revealButtonMode: mode("reveal"),
                    pdfButtonMode: mode("open"),
                    detailsButtonMode: "none",
                    webButtonMode: "none",
                    showCitationCount: false,
                })}
            </>
        );
    }

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
                    icon={HostRevealIcon}
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
 * The client's own reveal glyph where it provides one, falling back to the
 * package's. A module-level component on purpose: building it inline would
 * mint a new component type on every render, and React would tear down and
 * remount every action button whenever the table sorted or filtered.
 */
function HostRevealIcon(
    props: React.SVGProps<SVGSVGElement>,
): React.ReactElement {
    const hostIcon = getHost().components?.revealInLibraryIcon({
        className: "bt-action-icon",
    });
    return <>{hostIcon ?? <LibraryIcon {...props} />}</>;
}

/**
 * Whether the row's verbs can actually be drawn here: an external row needs the
 * bibliographic payload and the host's action component, a library row needs the
 * navigation slice. Split out so the column's existence and the buttons in it
 * can never disagree.
 */
function canRender(host: ClientHost, row: Row): boolean {
    const ref = row.ref;
    if (!ref) return false;
    return ref.kind === "external"
        ? !!ref.reference && !!host.components
        : !!host.navigation;
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
