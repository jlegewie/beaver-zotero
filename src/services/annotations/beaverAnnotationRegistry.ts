/**
 * Short-lived record of annotations Beaver has just written, so they are not
 * treated as user activity (the reader auto-attaches new annotations to the
 * draft). The author name cannot carry that signal: it is user-configurable
 * and may be empty.
 *
 * Record a write *before* it happens — Zotero notifies observers from inside
 * `saveTx()`. Writers that hold the item mark it; the reader's annotation
 * manager only returns a key, so those writes are recorded by library and key.
 * Storage hangs off `Zotero` because the writers and the reader observer live
 * in different bundles. Neither record is a durable authorship mark.
 */

/** How long a recorded key stays meaningful. */
const KEY_TTL_MS = 5 * 60 * 1000;

/** Hard cap on retained keys; oldest are dropped first. */
const MAX_KEYS = 500;

function writtenItems(): WeakSet<Zotero.Item> {
    if (!Zotero.__beaverWrittenAnnotationItems) {
        Zotero.__beaverWrittenAnnotationItems = new WeakSet<Zotero.Item>();
    }
    return Zotero.__beaverWrittenAnnotationItems;
}

function writtenKeys(): Map<string, number> {
    if (!Zotero.__beaverWrittenAnnotationKeys) {
        Zotero.__beaverWrittenAnnotationKeys = new Map<string, number>();
    }
    return Zotero.__beaverWrittenAnnotationKeys;
}

function keyEntry(libraryID: number, key: string): string {
    return `${libraryID}:${key}`;
}

/**
 * Record an annotation item Beaver is about to save. Call it before the save.
 */
export function markBeaverAnnotationWrite(item: Zotero.Item): void {
    writtenItems().add(item);
}

/**
 * Record an annotation Beaver is about to have saved on its behalf, for
 * writers that never hold the item (the reader, which returns only a key).
 */
export function markBeaverAnnotationWriteByKey(libraryID: number, key: string): void {
    if (!key) return;
    const keys = writtenKeys();
    keys.set(keyEntry(libraryID, key), Date.now());
    while (keys.size > MAX_KEYS) {
        const oldest = keys.keys().next();
        if (oldest.done) break;
        keys.delete(oldest.value);
    }
}

/** Whether this annotation is one Beaver wrote. */
export function wasWrittenByBeaver(item: Zotero.Item): boolean {
    if (writtenItems().has(item)) return true;
    if (!item.key) return false;
    const writtenAt = writtenKeys().get(keyEntry(item.libraryID, item.key));
    return writtenAt !== undefined && Date.now() - writtenAt < KEY_TTL_MS;
}
