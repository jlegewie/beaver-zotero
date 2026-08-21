/**
 * Compat layer for reading the collections-tree selection off `ZoteroPane`.
 *
 * The collections tree supports selecting several rows at once, and the API for
 * reading that selection has been introduced in stages across Zotero versions.
 *
 * Callers that only need a single selected value (the common case) take the
 * first element, matching Zotero's own internal usage of these plural getters.
 */

import { logger } from "@beaver/agent-core/platform/logger";

// A selection read failing means none of the accessors worked, i.e. the pane
// API changed shape again. Callers degrade to "nothing selected", so log each
// kind of failure once per session — enough to diagnose, without spamming from
// the paths that read the selection repeatedly.
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

/** Method names for one kind of selectable row, in the order they are tried. */
interface SelectionAccessors {
    /** Plural getter on `ZoteroPane`. */
    panePlural: string;
    /** Plural getter on `ZoteroPane.collectionsView`. */
    treePlural: string;
    /** Singular getter on `ZoteroPane`, used only when no plural one exists. */
    paneSingular: string;
}

/**
 * Read one kind of selected row, preferring the accessor that can report the
 * whole selection. `fromSingular` adapts the singular getter's return value,
 * which reports "nothing selected" as a falsy value rather than an empty list.
 */
function readSelection<T>(
    zp: any,
    which: string,
    accessors: SelectionAccessors,
    fromSingular: (value: any) => T[],
): T[] {
    if (!zp) return [];

    // Remembered so that a read where every rung failed can be reported once;
    // a rung that throws is silent as long as a later one succeeds.
    let failure: unknown;

    /** Returns the rung's result, or `null` when it is unavailable or throws. */
    const attempt = (owner: any, name: string, adapt: (value: any) => T[]): T[] | null => {
        try {
            const accessor = owner ? owner[name] : undefined;
            if (typeof accessor !== 'function') return null;
            return adapt(accessor.call(owner));
        } catch (e) {
            failure = e;
            return null;
        }
    };

    const asList = (values: any): T[] => (Array.isArray(values) ? values : []);

    let tree: any;
    try {
        tree = zp.collectionsView;
    } catch (e) {
        failure = e;
    }

    // An empty array is a successful "nothing selected" read, so only `null`
    // (unavailable or threw) falls through to the next rung.
    const result = attempt(zp, accessors.panePlural, asList)
        ?? attempt(tree, accessors.treePlural, asList)
        ?? attempt(zp, accessors.paneSingular, fromSingular);
    if (result) return result;

    if (failure !== undefined) logReadFailure(which, failure);
    return [];
}

/** All selected library IDs, or `[]` if none are selected or the pane is unavailable. */
export function getSelectedLibraryIds(zp: any): number[] {
    return readSelection<number>(
        zp,
        'the selected library IDs',
        {
            panePlural: 'getSelectedLibraryIDs',
            treePlural: 'getSelectedLibraryIDs',
            paneSingular: 'getSelectedLibraryID',
        },
        (id) => (typeof id === 'number' ? [id] : []),
    );
}

/** The first selected library ID, or `null` if none is selected. */
export function getSelectedLibraryId(zp: any): number | null {
    return getSelectedLibraryIds(zp)[0] ?? null;
}

/** All selected collections, or `[]` if none are selected or the pane is unavailable. */
export function getSelectedCollections(zp: any): Zotero.Collection[] {
    return readSelection<Zotero.Collection>(
        zp,
        'the selected collections',
        {
            panePlural: 'getSelectedCollections',
            treePlural: 'getSelectedCollections',
            paneSingular: 'getSelectedCollection',
        },
        (collection) => (collection ? [collection] : []),
    );
}

/** The first selected collection, or `null` if none is selected. */
export function getSelectedCollection(zp: any): Zotero.Collection | null {
    return getSelectedCollections(zp)[0] ?? null;
}

/**
 * Every selected collections-tree row, in collections-list order (not click
 * order), or `[]` when nothing is selected.
 *
 * Rows are the tree's own row objects, carrying `type`, `ref`, and predicates
 * like `isCollection()`. Unlike {@link getSelectedCollections} this keeps
 * non-collection rows (libraries, saved searches, trash, …), so it is the right
 * read when the caller cares about what kind of view is selected.
 */
export function getCollectionTreeRows(zp: any): any[] {
    if (!zp) return [];
    try {
        if (typeof zp.getCollectionTreeRows === 'function') {
            const rows = zp.getCollectionTreeRows();
            return Array.isArray(rows) ? rows : [];
        }
        // Older Zotero: only one row can ever be selected, so the focused row
        // is the whole selection. Read it off the tree rather than through the
        // singular pane getter, which is the form that throws on newer Zotero.
        const cv = zp.collectionsView;
        if (!cv?.selection || cv.selection.focused < 0) return [];
        const row = cv.getRow(cv.selection.focused);
        return row ? [row] : [];
    } catch (e) {
        logReadFailure('the selected collection tree rows', e);
        return [];
    }
}

/**
 * All selected saved searches, or `[]` if none are selected or the pane is
 * unavailable. Collections and saved searches can be selected together, so a
 * non-empty result here does not imply the collection list is empty.
 */
export function getSelectedSavedSearches(zp: any): Zotero.Search[] {
    return readSelection<Zotero.Search>(
        zp,
        'the selected saved searches',
        {
            panePlural: 'getSelectedSavedSearches',
            // The collections tree drops the "saved" prefix.
            treePlural: 'getSelectedSearches',
            paneSingular: 'getSelectedSavedSearch',
        },
        (search) => (search ? [search] : []),
    );
}
