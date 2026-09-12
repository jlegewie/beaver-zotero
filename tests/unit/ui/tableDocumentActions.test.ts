// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { renderTableDocumentActions } from "../../../src/ui/tableDocumentActions";
import {
    getTableLocalCommands,
    setTablesApi,
    tableLocalCommands,
    type TablesApi,
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
                    value: { kind: "text" as const, text: "Fresh answer" },
                    details: {
                        kind: "text" as const,
                        text: 'Evidence, with "quotes"',
                    },
                },
            },
        },
    ],
};
const read = vi.fn();
const history = vi.fn();
const revert = vi.fn();
const commands = vi.fn();
const init = vi.fn();
const show = vi.fn();
let root: HTMLElement;
let origin: Window;

beforeEach(() => {
    vi.clearAllMocks();
    read.mockResolvedValue({ spec, version: 2 });
    history.mockResolvedValue([
        {
            version: 1,
            actor: "user",
            change: "Initial comparison",
            at: "2026-09-11T12:00:00Z",
        },
    ]);
    revert.mockResolvedValue({ ok: true, version: 3, saved: true });
    commands.mockReturnValue({ read, history, revert });
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
    setTablesApi({ local: { commands } } as unknown as TablesApi);
    // A separate document catches accidental use of the global/main window.
    const frame = document.createElement("iframe");
    document.body.append(frame);
    origin = frame.contentWindow! as unknown as Window;
    root = renderTableDocumentActions(frame.contentDocument!, ref);
    frame.contentDocument!.body.append(root);
});
afterEach(() => {
    document.body.replaceChildren();
    setTablesApi(null);
    tableLocalCommands().clear();
    vi.unstubAllGlobals();
});
async function click(action: string) {
    root.querySelector<HTMLButtonElement>(
        `[data-beaver-action="${action}"]`,
    )!.click();
    await vi.waitFor(() =>
        expect(
            root.querySelector<HTMLButtonElement>(
                '[data-beaver-action="export-csv"]',
            )!.disabled,
        ).toBe(false),
    );
}
async function selectVersion() {
    await click("history");
    const select = root.querySelector("select")!;
    select.value = "1";
    select.dispatchEvent(new Event("change"));
}
it("exports a fresh persisted spec after the originating window picker returns", async () => {
    read.mockResolvedValueOnce({ spec: { ...spec, rows: [] }, version: 1 });
    await click("export-csv");
    expect(commands).toHaveBeenCalledWith(origin);
    expect(init).toHaveBeenCalledWith(origin, "Export table", 1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(IOUtils.writeUTF8).toHaveBeenCalledWith(
        "/tmp/comparison.csv",
        expect.stringContaining("Fresh answer"),
    );
    expect(IOUtils.writeUTF8).toHaveBeenCalledWith(
        "/tmp/comparison.csv",
        expect.stringContaining('"Evidence, with ""quotes"""'),
    );
    expect(root.textContent).toContain("source and evidence columns");
});
it("treats cancellation as no action", async () => {
    show.mockResolvedValue(2);
    await click("export-csv");
    expect(IOUtils.writeUTF8).not.toHaveBeenCalled();
    expect(root.querySelector('[role="status"]')!.textContent).toBe("");
});
it("reports missing-file and write failures", async () => {
    read.mockRejectedValueOnce(new Error("Missing local snapshot"));
    await click("export-csv");
    expect(root.textContent).toContain("Missing local snapshot");
    expect(show).not.toHaveBeenCalled();
    vi.mocked(IOUtils.writeUTF8).mockRejectedValueOnce(new Error("Disk full"));
    await click("export-csv");
    expect(root.textContent).toContain("Disk full");
});
it("loads retained versions on request and restores only the explicit selection", async () => {
    expect(history).not.toHaveBeenCalled();
    await selectVersion();
    expect(root.textContent).toContain("Version 1 · Initial comparison");
    expect(root.textContent).toContain("creates a new current version");
    expect(revert).not.toHaveBeenCalled();
    await click("restore-version");
    expect(revert).toHaveBeenCalledExactlyOnceWith(ref, 1);
    expect(root.textContent).toContain("Restored version 1 as version 3");
});
it.each([
    "Version is unavailable",
    "Library is read-only",
    "Connection interrupted",
])("reports %s without retrying an ambiguous restore", async (message) => {
    await selectVersion();
    revert.mockRejectedValueOnce(new Error(message));
    await click("restore-version");
    expect(root.textContent).toContain(message);
    expect(root.textContent).toContain(
        "Check the current table before trying again",
    );
    expect(revert).toHaveBeenCalledTimes(1);
});
it("reports committed content with incomplete bookkeeping as saved", async () => {
    await selectVersion();
    revert.mockResolvedValueOnce({ ok: true, saved: false, version: 3 });
    await click("restore-version");
    expect(root.textContent).toContain(
        "content is saved, but bookkeeping is incomplete",
    );
    expect(root.textContent).toContain("do not repeat the restore");
});
it("reports unavailable store/history instead of exposing an editor", async () => {
    history.mockRejectedValueOnce(new Error("History is unavailable"));
    await click("history");
    expect(root.textContent).toContain("History is unavailable");
    setTablesApi(null);
    await click("export-csv");
    expect(root.textContent).toContain("actions are unavailable");
    expect(root.querySelector("textarea, input")).toBeNull();
});
it("selects a live renderer for a standalone reader and never calls a closed owner", () => {
    const entries = tableLocalCommands();
    const closed = { closed: true } as Window;
    const live = { closed: false } as Window;
    const first = { read } as any;
    const second = { history } as any;
    entries.set(closed, first);
    entries.set(live, second);
    expect(getTableLocalCommands(origin)).toBe(second);
    entries.delete(live);
    expect(() => getTableLocalCommands(origin)).toThrow("unavailable");
});
