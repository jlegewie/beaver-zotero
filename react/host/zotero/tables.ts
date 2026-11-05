import type { TableDisplay } from "@beaver/agent-ui/host/types";
import type { TableFillViewRequest } from "@beaver/agent-core/protocol/tableFillProtocol";
import {
    parseItemReference,
    resolveLibraryRef,
} from "../../../src/utils/libraryIdentity";
import { missingTableFileMessage, readTableItemSpec, type TableRef } from "../../../src/services/artifacts/tableItemIdentity";
import { getTablesApi } from "../../../src/services/artifacts/tablesApi";
import type { OpenTableOptions, OpenTableOutcome } from "../../../src/ui/openTable";
import { tryGetWindowRuntime } from "../../runtime/windowRuntime";
import { notifyReferenceUnavailable, notifyTableOpenFailed } from "./sourceActions";

function resolveTableRef(key: string) {
    const parsed = parseItemReference(key);
    const libraryID = parsed && resolveLibraryRef(parsed);
    return parsed && libraryID ? { libraryID, key: parsed.zotero_key } : null;
}

/**
 * Opens a stored table in the Beaver tab of `origin`'s main window, without
 * telling the user when it fails: for opens the user did not click. With
 * `background`, the tab opens behind the selected one, so the chat stays in view.
 * `onDownload` fires when the table's files must be downloaded first. `focus`
 * brings a row or cell into view; `request` asks the tab to show a fill's failed rows.
 */
export async function openStoredTable(
    key: string,
    origin?: Window | null,
    options: {
        background?: boolean;
        onDownload?: () => void;
        focus?: { rowId: string; columnId?: string };
        request?: TableFillViewRequest;
    } = {},
) {
    const api = getTablesApi();
    const ref = resolveTableRef(key);
    if (!api) return { error: "Table provider unavailable." };
    if (!ref) return { error: "Table library unavailable on this device." };
    return api.openTable(ref, {
        window: origin ?? null,
        ...(options.background ? { background: true } : {}),
        ...(options.onDownload ? { onDownload: options.onDownload } : {}),
        ...(options.focus ? { focus: options.focus } : {}),
        ...(options.request ? { request: options.request } : {}),
    });
}

/**
 * Opens a table the user asked for and reports a failure in a popup: a table
 * deleted or moved to the trash gets the same "not available" notice as any
 * other missing item, and a table that exists but could not be opened gets
 * the reason.
 */
export async function openTableForUser(
    ref: TableRef,
    origin: Window | null | undefined,
    options: Omit<OpenTableOptions, "window"> = {},
): Promise<OpenTableOutcome> {
    const api = getTablesApi();
    if (!api) {
        notifyTableOpenFailed("Table provider unavailable.");
        return { error: "Table provider unavailable." };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.libraryID, ref.key).catch(() => false as const);
    if (!item || item.deleted) {
        notifyReferenceUnavailable("table");
        return { error: item ? `Table ${ref.key} is in the trash.` : `Table ${ref.key} is missing.` };
    }
    const outcome = await api.openTable(ref, { ...options, window: origin ?? null });
    if ("error" in outcome) notifyTableOpenFailed(outcome.error);
    return outcome;
}

/**
 * The host's `openTable`: {@link openTableForUser} for a table item reference.
 * Failures are shown to the user here, so callers need not display them.
 */
export async function openStoredTableForUser(
    key: string,
    origin?: Window | null,
    options: Omit<OpenTableOptions, "window" | "background" | "index"> = {},
): Promise<OpenTableOutcome> {
    const ref = resolveTableRef(key);
    if (!ref) {
        notifyReferenceUnavailable("table", "library_unavailable");
        return { error: "Table library unavailable on this device." };
    }
    return openTableForUser(ref, origin, options);
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
