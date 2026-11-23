import {
    rowActionTarget,
    type Row,
    type RowAction,
} from "@beaver/agent-core/layouts/table";
import { getHost, type ClientHost } from "../host";

/**
 * Turns a row verb into a host call.
 *
 * Which verbs a row has, and where they point, is a fact about the data and is
 * decided in agent-core (`rowActionTarget`). This maps a target onto the
 * host's navigation slice.
 *
 * Returns `undefined` when the host cannot perform the target — an absent
 * control beats a dead one. Import is not a click handler: adding an item to
 * the library is a write the host carries through its own approval / undo UI,
 * so `RowImportAction` renders that control from the target instead.
 */
export function rowActionHandler(
    row: Row,
    action: RowAction,
    host: ClientHost = getHost(),
): (() => void) | undefined {
    const target = rowActionTarget(row, action);
    const navigation = host.navigation;
    if (!target || !navigation) return undefined;
    switch (target.kind) {
        case "reveal_item":
            return () => navigation.revealInLibrary(target.ref);
        case "open_file":
        case "open_item":
            return () => void navigation.openSource(target.ref);
        case "import_reference":
            return undefined;
    }
}
