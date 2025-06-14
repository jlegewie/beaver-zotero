
export const logger = function (
    message: string,
    level?: number,
    maxDepth?: number,
    stack?: number | boolean,
) {
    if ("Beaver" in Zotero && (Zotero as any).Beaver.data.env === "development") {
        console.log(`[Beaver] ${message}`);
    }
    Zotero.debug(message, level, maxDepth, stack);
}