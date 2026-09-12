/** Local snapshot actions. Store callbacks cross the bundle seam; dialogs use this document. */
import { toCsv } from "@beaver/agent-core/layouts/table";
import { getTablesApi } from "../services/artifacts/tablesApi";
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

export function renderTableDocumentActions(
    doc: Document,
    ref: TableRef,
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
        const current = await commands().read(ref);
        const { FilePicker } = ChromeUtils.importESModule(
            "chrome://zotero/content/modules/filePicker.mjs",
        );
        const picker = new FilePicker();
        picker.init(win, "Export table", picker.modeSave);
        picker.defaultString = `${(current.spec.title || "Table").replace(/[\\/:*?"<>|]/g, "_")}.csv`;
        picker.appendFilter("CSV", "*.csv");
        if ((await picker.show()) === picker.returnCancel) return;
        const latest = await commands().read(ref);
        await IOUtils.writeUTF8(picker.file, toCsv(latest.spec));
        status.textContent = "CSV exported with source and evidence columns.";
    });
    const versions = doc.createElement("select");
    versions.setAttribute("aria-label", "Retained version");
    versions.hidden = true;
    const history = action("history", "Version history", async () => {
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
        restore.hidden = false;
        status.textContent = entries.length
            ? "Restoring a retained version creates a new current version."
            : "No retained versions are available.";
    });
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
    root.append(exportButton, history, versions, restore, status);
    return root;
}
