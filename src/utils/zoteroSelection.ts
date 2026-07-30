/**
 * Compat layer for reading the collections-tree selection off `ZoteroPane`.
 *
 * Zotero's collections tree supports multi-row selection, and `ZoteroPane`
 * exposes both a singular getter (`getSelectedLibraryID`,
 * `getSelectedCollection`) and a plural one (`getSelectedLibraryIDs`,
 * `getSelectedCollections`). Depending on the Zotero version, EITHER form may
 * be the one that actually works — on older versions the singular getter is
 * the real implementation and the plural one does not exist; on newer
 * versions the singular getter is a stub that unconditionally throws,
 * naming the plural getter as its replacement.
 *
 * The trap: the throwing singular getter still exists as a function, so
 * `typeof zp.getSelectedLibraryID === 'function'` and
 * `zp?.getSelectedLibraryID?.()` both look safe and then throw at call time.
 * The only reliable signal is whether the PLURAL getter exists — feature-
 * detect on that name, not on the singular one, and still wrap the call in
 * try/catch as a last resort.
 *
 * Callers that only need a single selected value (the common case) take the
 * first element, matching Zotero's own internal usage of these plural
 * getters.
 */

import { logger } from "./logger";

// A selection read failing means neither the plural nor the singular getter
// worked, i.e. the pane API changed shape again. Callers degrade to "nothing
// selected", so log each kind of failure once per session — enough to
// diagnose, without spamming from the paths that read the selection
// repeatedly.
const loggedReadFailures = new Set<string>();

function logReadFailure(which: string, e: unknown): void {
    if (loggedReadFailures.has(which)) return;
    loggedReadFailures.add(which);
    try {
        logger(`zoteroSelection: could not read ${which} from ZoteroPane: ${e}`, 1);
    } catch {
        /* logger must never break a selection read */
    }
}

/** All selected library IDs, or `[]` if none are selected or the pane is unavailable. */
export function getSelectedLibraryIds(zp: any): number[] {
    if (!zp) return [];
    try {
        if (typeof zp.getSelectedLibraryIDs === 'function') {
            const ids = zp.getSelectedLibraryIDs();
            return Array.isArray(ids) ? ids : [];
        }
        // Older Zotero: only the singular getter exists. It returns `false`
        // when nothing is selected, so normalize that away.
        const id = zp.getSelectedLibraryID();
        return typeof id === 'number' ? [id] : [];
    } catch (e) {
        logReadFailure('the selected library IDs', e);
        return [];
    }
}

/** The first selected library ID, or `null` if none is selected. */
export function getSelectedLibraryId(zp: any): number | null {
    return getSelectedLibraryIds(zp)[0] ?? null;
}

/** All selected collections, or `[]` if none are selected or the pane is unavailable. */
export function getSelectedCollections(zp: any): Zotero.Collection[] {
    if (!zp) return [];
    try {
        if (typeof zp.getSelectedCollections === 'function') {
            const collections = zp.getSelectedCollections();
            return Array.isArray(collections) ? collections : [];
        }
        // Older Zotero: only the singular getter exists. It returns `false`
        // when nothing is selected, so normalize that away.
        const collection = zp.getSelectedCollection();
        return collection ? [collection] : [];
    } catch (e) {
        logReadFailure('the selected collections', e);
        return [];
    }
}

/** The first selected collection, or `null` if none is selected. */
export function getSelectedCollection(zp: any): Zotero.Collection | null {
    return getSelectedCollections(zp)[0] ?? null;
}
