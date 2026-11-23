import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
    exportTable,
    revertFailureMessage,
    tableActionErrorMessage,
} from "../../../src/ui/tableDocumentActions";
import {
    getTableLocalCommands,
    tableLocalCommands,
    type TableLocalCommands,
} from "../../../src/services/artifacts/tablesApi";

const ref = { libraryID: 1, key: "TABLE001" };
const spec = {
    id: "table",
    title: "Comparison",
    columns: [{ id: "a", header: "Answer", type: "text" as const }],
    rows: [
        {
            id: "r",
            cells: {
                a: {
                    outcome: "answered" as const,
                    provenance: "model" as const,
                    documents: ["u-ATTACH01"],
                    confidence: "high" as const,
                    value: { kind: "text" as const, text: "Fresh answer" },
                    evidence: [
                        {
                            document: "u-ATTACH01",
                            locator: "s3",
                            quote: 'Evidence, with "quotes"',
                            page: 1,
                        },
                    ],
                },
            },
        },
    ],
};
const read = vi.fn();
const commands = () => ({ read }) as unknown as TableLocalCommands;
const init = vi.fn();
const show = vi.fn();
const win = { closed: false } as Window;
const savedBeaver = (Zotero as any).Beaver;

beforeEach(() => {
    vi.clearAllMocks();
    read.mockResolvedValue({ spec, version: 2 });
    show.mockResolvedValue(0);
    vi.stubGlobal("ChromeUtils", {
        importESModule: () => ({
            FilePicker: class {
                init = init;
                show = show;
                modeSave = 1;
                returnCancel = 2;
                file = "/tmp/comparison.csv";
                appendFilter() {}
            },
        }),
    });
    vi.stubGlobal("IOUtils", {
        writeUTF8: vi.fn().mockResolvedValue(undefined),
    });
    vi.stubGlobal("PathUtils", {
        filename: (path: string) => path.split("/").pop(),
    });
});
afterEach(() => {
    (Zotero as any).Beaver = savedBeaver;
    tableLocalCommands().clear();
    vi.unstubAllGlobals();
});

it("exports the spec read after the picker returns, in the originating window", async () => {
    read.mockResolvedValueOnce({ spec: { ...spec, rows: [] }, version: 1 });
    const file = await exportTable(win, ref, commands, "csv");
    expect(init).toHaveBeenCalledWith(win, "Export table", 1);
    expect(read).toHaveBeenCalledTimes(2);
    // Values only: no evidence, reasoning, confidence or state companions.
    expect(IOUtils.writeUTF8).toHaveBeenCalledWith(
        "/tmp/comparison.csv",
        "Answer\r\nFresh answer",
    );
    expect(file).toBe("comparison.csv");
});

it("exports an Excel workbook through the plugin-realm exporter", async () => {
    const writeTableWorkbook = vi.fn().mockResolvedValue(undefined);
    (Zotero as any).Beaver = { ...savedBeaver, exporter: { writeTableWorkbook } };
    await exportTable(win, ref, commands, "xlsx");
    expect(writeTableWorkbook).toHaveBeenCalledWith("/tmp/comparison.csv", spec, spec.rows);
    expect(IOUtils.writeUTF8).not.toHaveBeenCalled();
});

it("refuses an Excel export when the exporter is absent", async () => {
    (Zotero as any).Beaver = { ...savedBeaver, exporter: undefined };
    await expect(exportTable(win, ref, commands, "xlsx")).rejects.toThrow("Excel export is unavailable");
    expect(show).not.toHaveBeenCalled();
});

it("treats cancellation as no action", async () => {
    show.mockResolvedValue(2);
    expect(await exportTable(win, ref, commands, "csv")).toBeNull();
    expect(IOUtils.writeUTF8).not.toHaveBeenCalled();
});

it("surfaces missing-file and write failures", async () => {
    read.mockRejectedValueOnce(new Error("Missing local snapshot"));
    await expect(exportTable(win, ref, commands, "csv")).rejects.toThrow("Missing local snapshot");
    expect(show).not.toHaveBeenCalled();
    vi.mocked(IOUtils.writeUTF8).mockRejectedValueOnce(new Error("Disk full"));
    await expect(exportTable(win, ref, commands, "csv")).rejects.toThrow("Disk full");
});

it("selects a live renderer for a standalone reader and never calls a closed owner", () => {
    const entries = tableLocalCommands();
    const closed = { closed: true } as Window;
    const live = { closed: false } as Window;
    const origin = { closed: false } as Window;
    const first = { read } as any;
    const second = { read } as any;
    entries.set(closed, first);
    entries.set(live, second);
    expect(getTableLocalCommands(origin)).toBe(second);
    entries.delete(live);
    expect(() => getTableLocalCommands(origin)).toThrow("unavailable");
});

it("says plainly that a revert waits for a running fill", () => {
    const message = revertFailureMessage(
        { code: "fill_running", message: "A fill of this table is running. Try again when it ends." },
        ref,
    );
    expect(message).toBe("A fill of this table is running. Try again when it ends.");
});

it("asks for a check after a revert that may have landed", () => {
    const message = revertFailureMessage(new Error("Connection interrupted"), ref);
    expect(message).toContain("Connection interrupted");
    expect(message).toContain("Check the current table before trying again");
});

it("addresses exclusion errors to the user", () => {
    const message = tableActionErrorMessage(
        { code: "library_excluded", message: "Tell the user to re-enable access." },
        ref,
    );
    expect(message).toContain("You can re-enable access");
    expect(message).not.toContain("Tell the user");
});
