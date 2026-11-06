import { beforeEach, describe, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({
    read: vi.fn(),
    open: vi.fn(),
    api: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    lookup: vi.fn(),
    fileSync: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    addEvent: vi.fn(),
    removeEvent: vi.fn(),
    notifyUnavailable: vi.fn(),
    notifyFailed: vi.fn(),
    getPref: vi.fn(),
    logger: vi.fn(),
}));
vi.mock("../../../src/utils/prefs", () => ({ getPref: deps.getPref }));
vi.mock("@beaver/agent-core/platform/logger", () => ({ logger: deps.logger }));
vi.mock("../../../react/host/zotero/sourceActions", () => ({
    notifyReferenceUnavailable: deps.notifyUnavailable,
    notifyTableOpenFailed: deps.notifyFailed,
}));
vi.mock("../../../src/utils/libraryIdentity", () => ({
    parseItemReference: (key: string) =>
        ["u-ABCDEFGH", "g6073928-ABCDEFGH"].includes(key)
            ? { library_ref: key.split("-")[0], zotero_key: "ABCDEFGH" }
            : null,
    resolveLibraryRef: (ref: { library_ref: string }) =>
        ref.library_ref === "u" ? 1 : 7,
}));
vi.mock("../../../src/services/artifacts/tableItemIdentity", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../../src/services/artifacts/tableItemIdentity")>();
    return {
        readTableItemSpec: deps.read,
        missingTableFileMessage: original.missingTableFileMessage,
    };
});
vi.mock("../../../src/services/artifacts/tablesApi", () => ({
    getTablesApi: deps.api,
}));
vi.mock("../../../react/runtime/windowRuntime", () => ({
    tryGetWindowRuntime: () => ({
        hostWindow: {
            addEventListener: deps.addEvent,
            removeEventListener: deps.removeEvent,
        },
    }),
}));
import {
    openCreatedTable,
    openStoredTable,
    openStoredTableForUser,
    resolveTableDisplay,
    subscribeTableChanges,
} from "../../../react/host/zotero/tables";

beforeEach(() => {
    vi.clearAllMocks();
    deps.api.mockReturnValue({ openTable: deps.open });
    deps.open.mockResolvedValue({ ok: true });
    deps.getPref.mockReturnValue(true);
    deps.lookup.mockResolvedValue({
        deleted: false,
        getField: () => "Renamed in Zotero",
    });
    deps.read.mockResolvedValue({
        ok: true,
        spec: {
            title: "Embedded title",
            rows: [{ id: "row" }],
            columns: [{ id: "col" }],
        },
    });
    deps.subscribe.mockReturnValue(deps.unsubscribe);
    deps.register.mockReturnValue("observer");
    vi.stubGlobal("Zotero", {
        Items: {
            getByLibraryAndKeyAsync: deps.lookup,
            getIDFromLibraryAndKey: () => 7,
        },
        Notifier: {
            registerObserver: deps.register,
            unregisterObserver: deps.unregister,
        },
        Beaver: { runtime: { subscribeWindow: deps.subscribe } },
        Sync: { Storage: { Local: { getEnabledForLibrary: deps.fileSync } } },
    });
    deps.fileSync.mockReturnValue(false);
});

describe("opening a newly created table", () => {
    let origin: Window;
    beforeEach(() => {
        origin = { closed: false } as Window;
    });

    it("selects the table in the originating window by default", async () => {
        deps.getPref.mockReturnValue(undefined);
        await openCreatedTable("u-ABCDEFGH", origin, "run-1", "create-1");
        expect(deps.getPref).toHaveBeenCalledWith("tables.openAfterCreate");
        expect(deps.open).toHaveBeenCalledExactlyOnceWith(
            { libraryID: 1, key: "ABCDEFGH" },
            { window: origin },
        );
    });

    it("does not open the table when the preference is disabled", async () => {
        deps.getPref.mockReturnValue(false);
        await openCreatedTable("u-ABCDEFGH", origin, "run-1", "create-1");
        expect(deps.open).not.toHaveBeenCalled();
    });

    it("does not refocus the table when the tool returns after its fill started", async () => {
        await openCreatedTable("u-ABCDEFGH", origin, "run-1", "create-1");
        await openCreatedTable("u-ABCDEFGH", origin, "run-1", "create-1");
        expect(deps.open).toHaveBeenCalledTimes(1);
    });

    it("opens only once when the fill snapshot and tool return overlap", async () => {
        let finish!: (value: { ok: true }) => void;
        deps.open.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        const pending = openCreatedTable("u-ABCDEFGH", origin, "run-1", "create-1");
        await openCreatedTable("u-ABCDEFGH", origin, "run-1", "create-1");
        expect(deps.open).toHaveBeenCalledTimes(1);
        finish({ ok: true });
        await pending;
    });

    it("opens subsequent creations and allows tool call ids to repeat in a new run", async () => {
        await openCreatedTable("u-ABCDEFGH", origin, "run-1", "create-1");
        await openCreatedTable("g6073928-ABCDEFGH", origin, "run-1", "create-2");
        await openCreatedTable("u-ABCDEFGH", origin, "run-2", "create-1");
        expect(deps.open).toHaveBeenCalledTimes(3);
    });

    it.each([
        () => deps.open.mockResolvedValueOnce({ error: "Missing file" }),
        () => deps.open.mockRejectedValueOnce(new Error("Provider unavailable")),
    ])("allows the tool return to retry a failed open without interrupting chat", async (fail) => {
        fail();
        await openCreatedTable("u-ABCDEFGH", origin, "run-1", "create-1");
        await openCreatedTable("u-ABCDEFGH", origin, "run-1", "create-1");
        expect(deps.open).toHaveBeenCalledTimes(2);
        expect(deps.logger).toHaveBeenCalledTimes(1);
        expect(deps.notifyFailed).not.toHaveBeenCalled();
    });
});

describe("current table display and snapshot navigation", () => {
    it("reads current title and counts without overwriting historical metadata or querying exclusions", async () => {
        expect(await resolveTableDisplay("u-ABCDEFGH")).toEqual({
            status: "available",
            title: "Renamed in Zotero",
            rows: 1,
            columns: 1,
            contentColumns: 1,
        });
        expect(deps.read).toHaveBeenCalledTimes(1);
    });
    it("distinguishes a missing item, trash, missing file, and unavailable provider", async () => {
        deps.lookup.mockResolvedValueOnce(null);
        expect(await resolveTableDisplay("u-ABCDEFGH")).toHaveProperty(
            "reason",
            "Table item is missing.",
        );
        deps.lookup.mockResolvedValueOnce({ deleted: true });
        expect(await resolveTableDisplay("u-ABCDEFGH")).toHaveProperty(
            "reason",
            "Table is in the trash.",
        );
        deps.read.mockResolvedValueOnce({ ok: false, code: "no_file" });
        expect(await resolveTableDisplay("u-ABCDEFGH")).toHaveProperty(
            "reason",
            "Table file is missing on this device.",
        );
        deps.fileSync.mockReturnValueOnce(true);
        deps.read.mockResolvedValueOnce({ ok: false, code: "no_file" });
        expect(await resolveTableDisplay("u-ABCDEFGH")).toHaveProperty(
            "reason",
            "Table files are not on this device yet. Opening the table downloads them.",
        );
        deps.api.mockReturnValue(null);
        expect(await resolveTableDisplay("u-ABCDEFGH")).toHaveProperty(
            "reason",
            "Table provider unavailable.",
        );
    });
    it("routes Open through the instance table API with the origin window and preserves errors", async () => {
        const origin = { closed: false } as unknown as Window;
        expect(await openStoredTable("u-ABCDEFGH", origin)).toEqual({ ok: true });
        expect(deps.open).toHaveBeenCalledWith(
            { libraryID: 1, key: "ABCDEFGH" },
            { window: origin },
        );
        deps.open.mockResolvedValueOnce({ error: "Missing file" });
        expect(await openStoredTable("u-ABCDEFGH")).toEqual({
            error: "Missing file",
        });
        // Opens nobody clicked do not interrupt the user.
        expect(deps.notifyFailed).not.toHaveBeenCalled();
    });
    it("shows a not-available popup, and opens nothing, when the clicked table was deleted", async () => {
        deps.lookup.mockResolvedValueOnce(false);
        expect(await openStoredTableForUser("u-ABCDEFGH")).toHaveProperty("error");
        expect(deps.notifyUnavailable).toHaveBeenCalledExactlyOnceWith("table");
        deps.lookup.mockResolvedValueOnce({ deleted: true });
        expect(await openStoredTableForUser("u-ABCDEFGH")).toHaveProperty("error");
        expect(deps.notifyUnavailable).toHaveBeenCalledTimes(2);
        expect(deps.open).not.toHaveBeenCalled();
        expect(deps.notifyFailed).not.toHaveBeenCalled();
    });
    it("shows a popup with the reason when a clicked table that exists cannot be opened", async () => {
        deps.open.mockResolvedValueOnce({ error: "Could not open table ABCDEFGH — it has no file on disk." });
        await openStoredTableForUser("u-ABCDEFGH", null, { focus: { rowId: "row" } });
        expect(deps.open).toHaveBeenCalledWith({ libraryID: 1, key: "ABCDEFGH" }, { focus: { rowId: "row" }, window: null });
        expect(deps.notifyFailed).toHaveBeenCalledExactlyOnceWith("Could not open table ABCDEFGH — it has no file on disk.");
        expect(deps.notifyUnavailable).not.toHaveBeenCalled();
    });
    it("says the library is unavailable when the clicked table's library is not on this device", async () => {
        expect(await openStoredTableForUser("x-ABCDEFGH")).toHaveProperty("error");
        expect(deps.notifyUnavailable).toHaveBeenCalledExactlyOnceWith("table", "library_unavailable");
        expect(deps.open).not.toHaveBeenCalled();
    });
    it("refreshes on relevant item/table events and releases both listeners on unmount or unload", () => {
        const changed = vi.fn();
        const cleanup = subscribeTableChanges("u-ABCDEFGH", changed);
        const observer = deps.register.mock.calls[0][0];
        observer.notify("modify", "item", [8]);
        expect(changed).not.toHaveBeenCalled();
        observer.notify("trash", "item", [7]);
        const listener = deps.subscribe.mock.calls[0][2];
        listener({ libraryID: 1, key: "ABCDEFGH" });
        listener({ libraryID: 1, key: "ZZZZZZZZ" });
        expect(changed).toHaveBeenCalledTimes(2);
        deps.addEvent.mock.calls[0][1]();
        cleanup();
        expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
        expect(deps.unregister).toHaveBeenCalledExactlyOnceWith("observer");
        expect(deps.removeEvent).toHaveBeenCalledTimes(1);
    });
});

it("resolves group display and Open to the same local snapshot identity", async () => {
    expect(await resolveTableDisplay("g6073928-ABCDEFGH")).toMatchObject({
        status: "available",
    });
    expect(deps.lookup).toHaveBeenCalledWith(7, "ABCDEFGH");
    await openStoredTable("g6073928-ABCDEFGH");
    expect(deps.open).toHaveBeenCalledWith({ libraryID: 7, key: "ABCDEFGH" }, { window: null });
});
