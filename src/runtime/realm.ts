/** Prepare web primitives before constructing app-lifetime network services. */
export function prepareServiceRealm(): void {
    Cu.importGlobalProperties(["WebSocket", "AbortController"]);
    if (typeof console === "undefined") {
        const log = (...values: unknown[]) =>
            Zotero.debug(values.map(String).join(" "));
        Object.assign(globalThis, {
            console: { log, debug: log, info: log, warn: log, error: log },
        });
    }
}
