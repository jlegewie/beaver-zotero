/** Prepare web primitives before constructing app-lifetime network services. */
export function prepareServiceRealm(): void {
    Cu.importGlobalProperties(["WebSocket", "AbortController", "DOMParser", "TextDecoder"]);
    if (typeof console === "undefined") {
        // Use a complete console API that survives closing every main window.
        const { ConsoleAPI } = ChromeUtils.importESModule(
            "resource://gre/modules/Console.sys.mjs",
        );
        Object.assign(globalThis, {
            console: new ConsoleAPI({ consoleID: "beaver" }),
        });
    }
}
