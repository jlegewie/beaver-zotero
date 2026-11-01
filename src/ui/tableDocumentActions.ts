/** Local snapshot actions. Store callbacks cross the bundle seam; dialogs use this document. */
import { toCsv } from "@beaver/agent-core/layouts/table";
import { getTablesApi, type TableLocalCommands } from "../services/artifacts/tablesApi";
import {
    TABLE_REPAIR_SKIPPED,
    tableFilesEditable,
    tableRepairAllowed,
    type TableRef,
} from "../services/artifacts/tableItemIdentity";

import { excludedLibraryUserMessage } from "../utils/libraryMessages";

/** Structural error codes survive the boundary between renderer bundles. */
export function tableActionErrorMessage(error: unknown, ref: TableRef): string {
    const failure = error as { code?: string; message?: string; error?: string } | null;
    if (failure?.code === "library_excluded") {
        return excludedLibraryUserMessage(ref.libraryID);
    }
    return String(failure?.message ?? failure?.error ?? error);
}

/**
 * Asks where to save and writes the table as CSV, with its evidence and reasoning
 * columns. Reads the table again after the picker closes, so a write that lands
 * while it is open is exported rather than the version the user first saw.
 * Resolves the file's name, or null when the user cancelled.
 */
export async function exportTableCsv(
    win: Window,
    ref: TableRef,
    commands: () => TableLocalCommands,
): Promise<string | null> {
    const current = await commands().read(ref);
    const { FilePicker } = ChromeUtils.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs",
    );
    const picker = new FilePicker();
    picker.init(win, "Export table", picker.modeSave);
    picker.defaultString = `${(current.spec.title || "Table").replace(/[\\/:*?"<>|]/g, "_")}.csv`;
    picker.appendFilter("CSV", "*.csv");
    if ((await picker.show()) === picker.returnCancel) return null;
    const latest = await commands().read(ref);
    await IOUtils.writeUTF8(picker.file, toCsv(latest.spec));
    return PathUtils.filename(picker.file);
}

/**
 * The table's local actions: Export CSV, Version history (the retained
 * versions, and restoring one), and Check / repair. `historyOnly` renders the
 * version history alone and loads it at once, for the table tab's Version
 * history panel.
 */
export function renderTableDocumentActions(
    doc: Document,
    ref: TableRef,
    options: { historyOnly?: boolean } = {},
): HTMLElement {
    const root = doc.createElement("div");
    const status = doc.createElement("div");
    status.setAttribute("role", "status");
    const win = doc.defaultView as Window | null;
    const commands = () => {
        if (!win || win.closed)
            throw new Error("The originating window is closed.");
        const api = getTablesApi();
        if (!api) throw new Error("Table document actions are unavailable.");
        return api.local.commands(win);
    };
    let busy = false;
    const controls: HTMLButtonElement[] = [];
    const run = async (operation: () => Promise<void>, restoring = false) => {
        if (busy) return;
        busy = true;
        controls.forEach((control) => {
            control.disabled = true;
        });
        status.textContent = "";
        try {
            await operation();
        } catch (error) {
            status.textContent = `${tableActionErrorMessage(error, ref)}${restoring ? " Restore was not confirmed. Check the current table before trying again." : ""}`;
        } finally {
            busy = false;
            controls.forEach((control) => {
                control.disabled = false;
            });
            restore.disabled = !versions.value;
        }
    };
    const action = (
        name: string,
        text: string,
        operation: () => Promise<void>,
        restoring = false,
    ) => {
        const button = doc.createElement("button");
        button.className = "beaver-table-section-action";
        button.dataset.beaverAction = name;
        button.textContent = text;
        button.addEventListener("click", () => {
            void run(operation, restoring);
        });
        controls.push(button);
        return button;
    };
    const exportButton = action("export-csv", "Export CSV", async () => {
        if (!win) throw new Error("The originating window is closed.");
        if (!(await exportTableCsv(win, ref, commands))) return;
        status.textContent = "CSV exported with evidence and reasoning columns.";
    });
    const versions = doc.createElement("select");
    versions.setAttribute("aria-label", "Retained version");
    versions.hidden = true;
    const loadHistory = async () => {
        const entries = await commands().history(ref);
        versions.replaceChildren();
        const choose = doc.createElement("option");
        choose.value = "";
        choose.textContent = "Choose retained version";
        versions.append(choose);
        for (const entry of [...entries].reverse()) {
            const option = doc.createElement("option");
            option.value = String(entry.version);
            option.textContent = `Version ${entry.version} · ${entry.change || entry.actor} · ${entry.at}`;
            versions.append(option);
        }
        versions.hidden = false;
        // A revert writes a new version, which a read-only library refuses.
        const writable = tableFilesEditable(Zotero.Libraries.get(ref.libraryID));
        restore.hidden = !writable;
        status.textContent = !entries.length
            ? "No retained versions are available."
            : writable
              ? "Restoring a retained version creates a new current version."
              : "This library is read-only, so a retained version cannot be restored here.";
    };
    const history = action("history", "Version history", loadHistory);
    const restore = action(
        "restore-version",
        "Restore selected version",
        async () => {
            const version = Number(versions.value);
            if (!Number.isInteger(version) || version < 1) return;
            const result = await commands().revert(ref, version);
            if (!result.ok) {
                status.textContent =
                    "The table changed. Reload version history before restoring. No automatic retry was made.";
                return;
            }
            versions.value = "";
            status.textContent = `Restored version ${version} as version ${result.version}. ${
                result.saved
                    ? "Close and reopen any open snapshot to see the current table."
                    : "The content is saved, but bookkeeping is incomplete. Reopen the table to repair it; do not repeat the restore."
            }`;
        },
        true,
    );
    restore.hidden = true;
    restore.disabled = true;
    versions.addEventListener("change", () => {
        restore.disabled = busy || !versions.value;
    });
    const repair = action("repair", "Check / repair table", async () => {
        const current = await commands().read(ref);
        status.textContent = !current.recovered?.some((entry) => entry.kind === 'bookkeeping_pending')
            ? "Table bookkeeping is up to date."
            : tableRepairAllowed(ref.libraryID)
              ? "Content is committed, but local bookkeeping still needs repair. Try again after resolving storage or sync errors."
              : TABLE_REPAIR_SKIPPED;
    });
    if (options.historyOnly) {
        root.append(versions, restore, status);
        void run(loadHistory);
        return root;
    }
    root.append(exportButton, history, versions, restore, repair, status);
    return root;
}
