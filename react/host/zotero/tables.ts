import type { TableDisplay } from "@beaver/agent-ui/host/types";
import type { TableFillViewRequest } from "@beaver/agent-core/protocol/tableFillProtocol";
import { logger } from "@beaver/agent-core/platform/logger";
import { getPref } from "../../../src/utils/prefs";
import {
    parseItemReference,
    resolveLibraryRef,
} from "../../../src/utils/libraryIdentity";
import { isFillableColumn, type TableSpec } from "@beaver/agent-core/layouts/table";
import { pendingWork } from "@beaver/agent-core/layouts/tableFill";
import { fillButtonRows } from "@beaver/agent-core/run-state/tableFillCopy";
import {
    missingTableFileMessage,
    readTableItemSpec,
    tableFilesDownloadable,
    tableFilesEditable,
    type TableRef,
} from "../../../src/services/artifacts/tableItemIdentity";
import { isLibrarySearchable } from "../../../src/services/agentDataProvider/utils";
import type { TableReceiptLive } from "./components/reviewChanges/tableReceipt";
import { getTablesApi } from "../../../src/services/artifacts/tablesApi";
import type { OpenTableOptions, OpenTableOutcome } from "../../../src/ui/openTable";
import { tryGetWindowRuntime } from "../../runtime/windowRuntime";
import { notifyReferenceUnavailable, notifyTableOpenFailed } from "./sourceActions";

/** The local table a portable table key names, or null when its library is not on this device. */
export function resolveTableRef(key: string): TableRef | null {
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

const creationOpens = new WeakMap<Window, { runId: string; toolCallIds: Set<string> }>();

/** Open once per creation, whether the fill starts or the tool returns first. */
export async function openCreatedTable(
    key: string,
    origin: Window,
    runId: string,
    toolCallId: string,
): Promise<void> {
    if (getPref("tables.openAfterCreate") === false) return;
    let opens = creationOpens.get(origin);
    if (opens?.runId !== runId) {
        opens = { runId, toolCallIds: new Set() };
        creationOpens.set(origin, opens);
    }
    if (opens.toolCallIds.has(toolCallId)) return;
    // Claim before awaiting: fill snapshots and tool returns can arrive together.
    opens.toolCallIds.add(toolCallId);
    try {
        const outcome = await openStoredTable(key, origin);
        if ("error" in outcome) throw new Error(outcome.error);
    } catch (error) {
        opens.toolCallIds.delete(toolCallId);
        logger(`Opening the new table failed: ${String(error)}`, 1);
    }
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

type DisplayedTable =
    /** `openable`: the files are not here yet, and opening the table downloads them. */
    | { status: "unavailable"; reason: string; openable?: boolean }
    | { status: "read"; ref: TableRef; title: string; spec: TableSpec };

/** Reads a table for local display, or says why it cannot be shown. */
async function readDisplayedTable(key: string): Promise<DisplayedTable> {
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
            return result.code === "no_file"
                ? {
                      status: "unavailable",
                      reason: missingTableFileMessage(item),
                      ...(tableFilesDownloadable(item) ? { openable: true } : {}),
                  }
                : { status: "unavailable", reason: "Table document is unavailable." };
        return {
            status: "read",
            ref,
            title: String(
                item.getField("title") || result.spec.title || "Untitled table",
            ),
            spec: result.spec,
        };
    } catch {
        return { status: "unavailable", reason: "Table provider unavailable." };
    }
}

/** Local display only; submission validates access through the provider separately. */
export async function resolveTableDisplay(key: string): Promise<TableDisplay> {
    const read = await readDisplayedTable(key);
    if (read.status === "unavailable") return { status: "unavailable", reason: read.reason };
    return {
        status: "available",
        title: read.title,
        rows: read.spec.rows.length,
        columns: read.spec.columns.length,
        contentColumns: read.spec.columns.filter((column) => !column.system).length,
    };
}

/**
 * The table as an answer's receipt shows it: its size, how much of it has
 * been read, what the table's own Fill would fill, and whether Beaver may
 * fill it. Local display only; a fill plans and checks access itself.
 */
export async function resolveTableReceipt(key: string): Promise<TableReceiptLive> {
    const read = await readDisplayedTable(key);
    if (read.status === "unavailable") return read;
    const { ref, spec } = read;
    const questions = spec.columns.filter(isFillableColumn);
    let readRows = 0;
    let failedRows = 0;
    for (const row of spec.rows) {
        if (row.failure) failedRows += 1;
        else if (questions.some((column) => {
            const cell = row.cells[column.id];
            return cell !== undefined && cell.provenance !== "user";
        })) readRows += 1;
    }
    const pending = pendingWork(spec);
    // Nothing is blamed on an exclusion before the library scope has loaded.
    const scopeKnown = !!Zotero.Beaver?.libraryScopeInitialized;
    const blocked = scopeKnown && !isLibrarySearchable(ref.libraryID)
        ? "library_excluded" as const
        : !tableFilesEditable(Zotero.Libraries.get(ref.libraryID))
          ? "read_only" as const
          : null;
    return {
        status: "available",
        title: read.title,
        rows: spec.rows.length,
        columns: spec.columns.filter((column) => !column.system).length,
        questions: questions.length,
        readRows,
        failedRows,
        fillRows: fillButtonRows(pending),
        emptyCells: pending.cells,
        version: spec.version ?? 0,
        blocked,
    };
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
