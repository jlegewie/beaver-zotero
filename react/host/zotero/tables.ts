import type { TableDisplay } from "@beaver/agent-ui/host/types";
import {
    parseItemReference,
    resolveLibraryRef,
} from "../../../src/utils/libraryIdentity";
import { missingTableFileMessage, readTableItemSpec } from "../../../src/services/artifacts/tableItemIdentity";
import { getTablesApi } from "../../../src/services/artifacts/tablesApi";
import { tryGetWindowRuntime } from "../../runtime/windowRuntime";

function resolveTableRef(key: string) {
    const parsed = parseItemReference(key);
    const libraryID = parsed && resolveLibraryRef(parsed);
    return parsed && libraryID ? { libraryID, key: parsed.zotero_key } : null;
}

/**
 * Opens a stored table in the Beaver tab of `origin`'s main window. With
 * `background`, the tab opens behind the selected one, so the chat stays in view.
 * `onDownload` fires when the table's files must be downloaded first.
 */
export async function openStoredTable(
    key: string,
    origin?: Window | null,
    options: { background?: boolean; onDownload?: () => void } = {},
) {
    const api = getTablesApi();
    const ref = resolveTableRef(key);
    if (!api) return { error: "Table provider unavailable." };
    if (!ref) return { error: "Table library unavailable on this device." };
    return api.openTable(ref, {
        window: origin ?? null,
        ...(options.background ? { background: true } : {}),
        ...(options.onDownload ? { onDownload: options.onDownload } : {}),
    });
}

/**
 * Undo of one `edit_table` call, through the renderer's table commands: the
 * store restores the version before it while the table is as the edit left
 * it, and refuses otherwise.
 */
export async function undoStoredTableEdit(
    key: string,
    edit: { version: number; runId: string },
    origin?: Window | null,
): Promise<{ ok: true } | { error: string }> {
    const api = getTablesApi();
    const ref = resolveTableRef(key);
    const runtime = tryGetWindowRuntime();
    const win = origin ?? runtime?.hostWindow ?? null;
    if (!api || !win) return { error: "Table provider unavailable." };
    if (!ref) return { error: "Table library unavailable on this device." };
    // A fill changes the table with every commit: Undo waits for it to end,
    // and then works only if the fill touched nothing.
    const fill = Zotero.Beaver.tableFills?.jobForTable(ref);
    if (fill && fill.state !== "done") return { error: "Undo is available when the fill ends." };
    try {
        const result = await api.local.commands(win).undo(ref, { version: edit.version, run_id: edit.runId });
        return result.ok ? { ok: true } : { error: result.message };
    } catch (error) {
        return { error: String((error as Error)?.message ?? error) };
    }
}

/** Local display only; submission validates access through the provider separately. */
export async function resolveTableDisplay(key: string): Promise<TableDisplay> {
    if (!getTablesApi())
        return { status: "unavailable", reason: "Table provider unavailable." };
    const ref = resolveTableRef(key);
    if (!ref)
        return {
            status: "unavailable",
            reason: "Table library unavailable on this device.",
        };
    try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
            ref.libraryID,
            ref.key,
        );
        if (!item)
            return { status: "unavailable", reason: "Table item is missing." };
        if (item.deleted)
            return { status: "unavailable", reason: "Table is in the trash." };
        const result = await readTableItemSpec(item);
        if (!result.ok)
            return {
                status: "unavailable",
                reason:
                    result.code === "no_file"
                        ? missingTableFileMessage(item)
                        : "Table document is unavailable.",
            };
        return {
            status: "available",
            title: String(
                item.getField("title") || result.spec.title || "Untitled table",
            ),
            rows: result.spec.rows.length,
            columns: result.spec.columns.length,
            contentColumns: result.spec.columns.filter((column) => !column.system).length,
        };
    } catch {
        return { status: "unavailable", reason: "Table provider unavailable." };
    }
}

export function subscribeTableChanges(
    key: string,
    changed: () => void,
): () => void {
    const runtime = tryGetWindowRuntime();
    const ref = resolveTableRef(key);
    if (!runtime || !ref) return () => {};
    const unsubscribe = Zotero.Beaver.runtime.subscribeWindow(
        runtime,
        "beaverTableUpdated",
        (detail) => {
            if (detail.libraryID === ref.libraryID && detail.key === ref.key)
                changed();
        },
    );
    let itemID = Zotero.Items.getIDFromLibraryAndKey(ref.libraryID, ref.key);
    const observer = Zotero.Notifier.registerObserver(
        {
            notify: (_event, _type, ids) => {
                itemID ||= Zotero.Items.getIDFromLibraryAndKey(
                    ref.libraryID,
                    ref.key,
                );
                if (itemID && ids.some((id) => id === itemID)) changed();
            },
        },
        ["item"],
        "beaver-table-display",
    );
    let disposed = false;
    const cleanup = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        Zotero.Notifier.unregisterObserver(observer);
        runtime.hostWindow.removeEventListener("unload", cleanup);
    };
    runtime.hostWindow.addEventListener("unload", cleanup, { once: true });
    return cleanup;
}
