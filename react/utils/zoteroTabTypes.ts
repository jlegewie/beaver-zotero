/**
 * Zotero keeps a restored reader tab in `reader-unloaded` state, changes it to
 * `reader-loading` when selected, and finally to `reader` after initialization.
 * Only the latter two can be the actively selected reader lifecycle handled by
 * `useReaderTabSelection`.
 */
export function isActiveReaderTabType(type: string): boolean {
    return type === "reader" || type === "reader-loading";
}
