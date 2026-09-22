import { beforeEach, describe, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({
    read: vi.fn(),
    open: vi.fn(),
    api: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    lookup: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    addEvent: vi.fn(),
    removeEvent: vi.fn(),
}));
vi.mock("../../../src/utils/libraryIdentity", () => ({
    parseItemReference: (key: string) =>
        ["u-ABCDEFGH", "g6073928-ABCDEFGH"].includes(key)
            ? { library_ref: key.split("-")[0], zotero_key: "ABCDEFGH" }
            : null,
    resolveLibraryRef: (ref: { library_ref: string }) =>
        ref.library_ref === "u" ? 1 : 7,
}));
vi.mock("../../../src/services/artifacts/tableItemIdentity", () => ({
    readTableItemSpec: deps.read,
}));
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
    openStoredTable,
    resolveTableDisplay,
    subscribeTableChanges,
} from "../../../react/host/zotero/tables";

beforeEach(() => {
    vi.clearAllMocks();
    deps.api.mockReturnValue({ openTable: deps.open });
    deps.open.mockResolvedValue({ ok: true });
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
    });
});

describe("current table display and snapshot navigation", () => {
    it("reads current title and counts without overwriting historical metadata or querying exclusions", async () => {
        expect(await resolveTableDisplay("u-ABCDEFGH")).toEqual({
            status: "available",
            title: "Renamed in Zotero",
            rows: 1,
            columns: 1,
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
        deps.api.mockReturnValue(null);
        expect(await resolveTableDisplay("u-ABCDEFGH")).toHaveProperty(
            "reason",
            "Table provider unavailable.",
        );
    });
    it("routes Open through the instance snapshot API and preserves errors", async () => {
        expect(await openStoredTable("u-ABCDEFGH")).toEqual({ ok: true });
        expect(deps.open).toHaveBeenCalledWith({
            libraryID: 1,
            key: "ABCDEFGH",
        });
        deps.open.mockResolvedValueOnce({ error: "Missing file" });
        expect(await openStoredTable("u-ABCDEFGH")).toEqual({
            error: "Missing file",
        });
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
    expect(deps.open).toHaveBeenCalledWith({ libraryID: 7, key: "ABCDEFGH" });
});
