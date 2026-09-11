import { afterEach, describe, expect, it, vi } from "vitest";
import { BasicTool } from "zotero-plugin-toolkit";
import { prepareServiceRealm } from "../../../src/runtime/realm";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("service realm console", () => {
    it("installs the native console and lets the real toolkit logger reach Zotero.debug", () => {
        const nativeConsole = {
            group: vi.fn(),
            trace: vi.fn(),
            groupEnd: vi.fn(),
        };
        const ConsoleAPI = vi.fn(function () {
            return nativeConsole;
        });
        const importESModule = vi.fn(() => ({ ConsoleAPI }));
        vi.stubGlobal("ChromeUtils", { importESModule });
        vi.stubGlobal("Cu", { importGlobalProperties: vi.fn() });
        const toolkit = new BasicTool();
        const debug = vi.spyOn(Zotero, "debug").mockImplementation(() => {});
        const logError = vi.fn();
        vi.stubGlobal("Zotero", { ...Zotero, logError });
        vi.stubGlobal("console", undefined);
        prepareServiceRealm();
        toolkit.log("BEAVER_REALM_LOG_TEST");
        expect(globalThis.console).toBe(nativeConsole);
        expect(importESModule).toHaveBeenCalledWith(
            "resource://gre/modules/Console.sys.mjs",
        );
        expect(ConsoleAPI).toHaveBeenCalledWith({ consoleID: "beaver" });
        expect(nativeConsole.group).toHaveBeenCalledWith(
            "BEAVER_REALM_LOG_TEST",
        );
        expect(nativeConsole.trace).toHaveBeenCalledOnce();
        expect(nativeConsole.groupEnd).toHaveBeenCalledOnce();
        expect(debug).toHaveBeenCalledWith("BEAVER_REALM_LOG_TEST");
        expect(logError).not.toHaveBeenCalled();
    });

    it("preserves an existing console on repeated preparation", () => {
        const existing = globalThis.console;
        const importGlobalProperties = vi.fn();
        const importESModule = vi.fn();
        vi.stubGlobal("Cu", { importGlobalProperties });
        vi.stubGlobal("ChromeUtils", { importESModule });
        prepareServiceRealm();
        prepareServiceRealm();
        expect(globalThis.console).toBe(existing);
        expect(importESModule).not.toHaveBeenCalled();
        expect(importGlobalProperties).toHaveBeenCalledWith([
            "WebSocket",
            "AbortController",
        ]);
    });
});
