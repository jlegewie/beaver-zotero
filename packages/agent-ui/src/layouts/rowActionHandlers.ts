import {
    rowActionTarget,
    rowActions,
    rowPrimaryAction,
    type Row,
    type RowAction,
    type RowActionTarget,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { getHost, type ClientHost } from "../host";

/**
 * Turns a row verb into a host call.
 *
 * Which verbs a row has, and where they point, is a fact about the data and is
 * decided in agent-core (`rowActionTarget`). This is the one place that maps a
 * target onto the host's navigation slice, so a new row kind that reuses an
 * existing target needs no change here, and a new target needs exactly one.
 *
 * Returns `undefined` when the host cannot perform the target — an absent
 * control beats a dead one. Import is not a click handler: adding an item to the
 * library is a write the host carries through its own approval / undo UI, so
 * `RowActionsView` renders that control from the target instead.
 */
export function rowActionHandler(
    row: Row,
    action: RowAction,
    host: ClientHost = getHost(),
): (() => void) | undefined {
    const target = rowActionTarget(row, action);
    return target ? handlerForTarget(target, host) : undefined;
}

/**
 * The handler behind the row's anchor cell: its kind's primary verb — reveal
 * for a paper, open for an annotation or a file — so the row's commonest action
 * is on its title rather than in a column to hunt through. Only when the table
 * (or the row) declares that verb: the anchor is a placement of a row action,
 * not a way around `capabilities.row_actions`.
 */
export function anchorActionHandler(
    table: TableSpec,
    row: Row,
    host: ClientHost = getHost(),
): (() => void) | undefined {
    const action = rowPrimaryAction(row);
    if (!action || !rowActions(table, row).includes(action)) return undefined;
    return rowActionHandler(row, action, host);
}

function handlerForTarget(
    target: RowActionTarget,
    host: ClientHost,
): (() => void) | undefined {
    const navigation = host.navigation;
    if (!navigation) return undefined;
    switch (target.kind) {
        case "reveal_item":
            return () => navigation.revealInLibrary(target.ref);
        case "open_file":
        case "open_item":
            return () => void navigation.openSource(target.ref);
        case "open_annotation":
            return () => void navigation.openAnnotation(target.ref);
        case "open_external_file":
            return () => void navigation.launchExternalFile(target.ext_key);
        case "import_reference":
            return undefined;
    }
}
