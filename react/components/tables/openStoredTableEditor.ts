import type { TableRef } from "../../../src/services/artifacts/tableItemIdentity";
import { BeaverUIFactory } from "../../../src/ui/ui";
import { getWindowRuntime } from "../../runtime/windowRuntime";
import { openBeaverWindow } from "../../ui/openBeaverWindow";
import { store } from "../../store";
import {
    showTableInWindowAtom,
    windowSurfaceAtom,
} from "../../atoms/windowSurface";

/** Route to the existing borrowed window's renderer so only one editor exists. */
export async function openStoredTableEditor(ref: TableRef): Promise<void> {
    const runtime = getWindowRuntime();
    const existing = BeaverUIFactory.findBeaverWindow();
    const owner = existing?.__beaverOwnerWindowRef?.deref();
    if (owner && owner !== runtime.contextWindow) {
        if (!owner.__beaverEditTable)
            throw new Error("Table editor unavailable.");
        return owner.__beaverEditTable(ref);
    }
    const current = store.get(windowSurfaceAtom);
    if (
        current.kind === "table" &&
        current.ref?.key === ref.key &&
        current.ref.libraryID === ref.libraryID
    ) {
        openBeaverWindow({ width: 1100, height: 780 });
        return;
    }
    if (runtime.status === "closing") return;
    store.set(showTableInWindowAtom, {
        variant: "extraction",
        table: { id: "stored-table", columns: [], rows: [] },
        ref,
    });
    openBeaverWindow({ width: 1100, height: 780 });
}
