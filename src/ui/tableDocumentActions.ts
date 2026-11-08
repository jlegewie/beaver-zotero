/** Table export and the error wording shared by the table surfaces. */
import { sortRows, type TableSort } from "@beaver/agent-core/layouts/table";
import { toCsv } from "@beaver/agent-core/layouts/tableExport";
import type { TableLocalCommands } from "../services/artifacts/tablesApi";
import type { TableRef } from "../services/artifacts/tableItemIdentity";

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
