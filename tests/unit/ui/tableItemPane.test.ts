// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const isTableItem = vi.hoisted(() => vi.fn());
const readSpec = vi.hoisted(() => vi.fn());
const readHistory = vi.hoisted(() => vi.fn());
vi.mock("../../../src/services/artifacts/recoveryShadow", () => ({ lastTableShadow: vi.fn().mockResolvedValue(null) }));
const load = vi.hoisted(() => vi.fn());
vi.mock("../../../src/services/artifacts/tableItemIdentity", () => ({
    isTableItem,
    loadTableItemFields: load,
    readTableHistory: readHistory,
    readTableItemSpec: readSpec,
}));
import {
    initTableItemPane,
    cleanupTableItemPane,
} from "../../../src/ui/tableItemPane";
import { setTablesApi } from "../../../src/services/artifacts/tablesApi";
let hooks: any;
let body: HTMLElement;
let args: any;
beforeEach(() => {
    vi.clearAllMocks();
    (Zotero as any).ItemPaneManager = {
        registerSection: vi.fn((options) => {
            hooks = options;
            return "table-pane";
        }),
        unregisterSection: vi.fn(),
    };
    (Zotero as any).Attachments = { LINK_MODE_IMPORTED_URL: 1 };
    initTableItemPane();
    body = document.createElement("div");
    document.body.append(body);
    args = {
        doc: document,
        body,
        item: {
            id: 7,
            libraryID: 1,
            key: "TABLE001",
            isAttachment: () => true,
            isTopLevelItem: () => true,
            attachmentLinkMode: 1,
            attachmentContentType: "text/html",
        },
        setEnabled: vi.fn(),
        setSectionSummary: vi.fn(),
    };
    isTableItem.mockReturnValue(false);
    load.mockResolvedValue(undefined);
});
afterEach(() => {
    cleanupTableItemPane();
    setTablesApi(null);
    document.body.replaceChildren();
});
it("renders document actions before lazy item data can establish table identity", () => {
    hooks.onRender(args);
    expect(isTableItem).not.toHaveBeenCalled();
    expect(args.setEnabled).not.toHaveBeenCalledWith(false);
    expect(
        Array.from(body.querySelectorAll("[data-beaver-action]")).map((e) =>
            e.getAttribute("data-beaver-action"),
        ),
    ).toEqual([
        "open",
        "library",
        "restore-shadow",
        "export-csv",
        "history",
        "restore-version",
    ]);
    expect(body.textContent).not.toContain("Edit table");
});
it("does not hide a newly selected item when the previous async identity check finishes", async () => {
    let finish!: () => void;
    load.mockImplementationOnce(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
    );
    hooks.onRender(args);
    const pending = hooks.onAsyncRender(args);
    body.setAttribute("data-beaver-table-item", "8");
    finish();
    await pending;
    expect(args.setEnabled).not.toHaveBeenCalledWith(false);
});
it("shows recovery restore failures separately from ordinary history", async () => {
    setTablesApi({
        shadow: {
            restore: vi
                .fn()
                .mockResolvedValue({
                    ok: false,
                    error: "Retained recovery payload is unavailable.",
                }),
        },
    } as any);
    hooks.onRender(args);
    const button = body.querySelector<HTMLButtonElement>(
        '[data-beaver-action="restore-shadow"]',
    )!;
    button.hidden = false;
    button.disabled = false;
    button.click();
    await vi.waitFor(() =>
        expect(body.textContent).toContain(
            "Retained recovery payload is unavailable.",
        ),
    );
    expect(
        body.querySelector('[aria-label="Retained version"]'),
    ).not.toBeNull();
});

it("validates identity even when Zotero never invokes the async hook", async () => {
    hooks.onRender(args);
    await vi.waitFor(() => expect(args.setEnabled).toHaveBeenCalledWith(false));
    expect(load).toHaveBeenCalledTimes(1);
});
it("addresses exclusion errors to the user during recovery restore", async () => {
    setTablesApi({ shadow: { restore: vi.fn().mockRejectedValue({
        code: "library_excluded", message: "Tell the user to re-enable access."
    }) } } as any);
    hooks.onRender(args);
    const button = body.querySelector<HTMLButtonElement>('[data-beaver-action="restore-shadow"]')!;
    button.hidden = false;
    button.disabled = false;
    button.click();
    await vi.waitFor(() => expect(body.textContent).toContain("You can re-enable access"));
    expect(body.textContent).not.toContain("Tell the user");
});

it("populates counts without Zotero's async hook and refreshes the same item", async () => {
    isTableItem.mockReturnValue(true);
    args.item.getFilePathAsync = vi.fn().mockResolvedValue("/table.html");
    readHistory.mockResolvedValue({ tip: 1, versions: [] });
    const spec = { id: "table", key: "TABLE001", version: 1, title: "Table", columns: [{ id: "a", header: "Answer", type: "text" }], rows: [] };
    readSpec.mockResolvedValue({ ok: true, spec });
    hooks.onRender(args);
    await vi.waitFor(() => expect(body.querySelector('.beaver-table-section-facts')!.textContent).toContain("Version 1"));
    readSpec.mockResolvedValue({ ok: true, spec: { ...spec, version: 2 } });
    hooks.onRender(args);
    await hooks.onAsyncRender(args);
    expect(body.querySelector('.beaver-table-section-facts')!.textContent).toContain("Version 2");
    expect(readSpec).toHaveBeenCalledTimes(2);
});
