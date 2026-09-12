/* global Worker */
/** System-global construction keeps module workers independent of UI windows. */
export function createDocumentWorker(url) {
    return new Worker(url, { type: "module" });
}
