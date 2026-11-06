/** Local snapshot actions. Store callbacks cross the bundle seam; dialogs use this document. */
import { sortRows, type TableSort } from "@beaver/agent-core/layouts/table";
import { toCsv } from "@beaver/agent-core/layouts/tableExport";
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
 * A revert that threw may or may not have landed, so the message says to
 * check. A refusal (a fill is running) wrote nothing and needs no check.
 */
export function revertFailureMessage(error: unknown, ref: TableRef): string {
    const refused = (error as { code?: string } | null)?.code === "fill_running";
    const message = tableActionErrorMessage(error, ref);
    return refused ? message : `${message} Revert was not confirmed. Check the current table before trying again.`;
}

export type TableExportFormat = "xlsx" | "csv";

const EXPORT_FORMATS: Record<TableExportFormat, { extension: string; filter: string }> = {
    xlsx: { extension: "xlsx", filter: "Excel Workbook" },
    csv: { extension: "csv", filter: "CSV" },
};

/**
 * Asks where to save and writes the table as an Excel workbook or a CSV
 * file, its rows in the given sort order (the table's own order without one).
 * Reads the table again after the picker closes, so a write that lands while
 * it is open is exported rather than the version the user first saw.
 * Resolves the file's name, or null when the user cancelled.
 */
export async function exportTable(
    win: Window,
    ref: TableRef,
    commands: () => TableLocalCommands,
    format: TableExportFormat,
    sort?: TableSort,
): Promise<string | null> {
    const { extension, filter } = EXPORT_FORMATS[format];
    const exporter = Zotero.Beaver?.exporter;
    if (format === "xlsx" && !exporter) throw new Error("Excel export is unavailable right now.");
    const current = await commands().read(ref);
    const { FilePicker } = ChromeUtils.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs",
    );
    const picker = new FilePicker();
    picker.init(win, "Export table", picker.modeSave);
    picker.defaultString = `${(current.spec.title || "Table").replace(/[\\/:*?"<>|]/g, "_")}.${extension}`;
    picker.defaultExtension = extension;
    picker.appendFilter(filter, `*.${extension}`);
    if ((await picker.show()) === picker.returnCancel) return null;
    const latest = (await commands().read(ref)).spec;
    const rows = sort ? sortRows(latest, sort) : latest.rows;
    if (format === "xlsx") await exporter!.writeTableWorkbook(picker.file, latest, rows);
    else await IOUtils.writeUTF8(picker.file, toCsv(latest, rows));
    return PathUtils.filename(picker.file);
}

/**
 * The item pane's table actions: Export to Excel, Export CSV, Version history
 * (the retained versions, and reverting to one), and Check / repair.
 */
export function renderTableDocumentActions(doc: Document, ref: TableRef): HTMLElement {
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
            status.textContent = restoring ? revertFailureMessage(error, ref) : tableActionErrorMessage(error, ref);
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
    const exportAction = (format: TableExportFormat, text: string) =>
        action(`export-${format}`, text, async () => {
            if (!win) throw new Error("The originating window is closed.");
            const file = await exportTable(win, ref, commands, format);
            if (file) status.textContent = `Exported ${file}.`;
        });
    const exportButtons = [exportAction("xlsx", "Export to Excel"), exportAction("csv", "Export CSV")];
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
              ? "Reverting to a retained version saves it as a new current version."
              : "This library is read-only, so it cannot be reverted to a retained version here.";
    };
    const history = action("history", "Version history", loadHistory);
    const restore = action(
        "restore-version",
        "Revert to selected version",
        async () => {
            const version = Number(versions.value);
            if (!Number.isInteger(version) || version < 1) return;
            const result = await commands().revert(ref, version);
            if (!result.ok) {
                status.textContent =
                    "The table changed. Reload version history before reverting. No automatic retry was made.";
                return;
            }
            versions.value = "";
            status.textContent = `Reverted to version ${version}, saved as version ${result.version}. ${
                result.saved
                    ? "Close and reopen any open snapshot to see the current table."
                    : "The table is saved, but its version history could not be updated. Reopen the table to repair it; do not revert again."
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
            ? "The table needs no repair."
            : tableRepairAllowed(ref.libraryID)
              ? "The table is saved, but its version history still could not be updated. Try again after resolving storage or sync errors."
              : TABLE_REPAIR_SKIPPED;
    });
    root.append(...exportButtons, history, versions, restore, repair, status);
    return root;
}
