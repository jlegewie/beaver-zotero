/**
 * Row verbs: which actions a table row offers and where each points.
 *
 * A row is a Zotero regular item or an external work (`Row.ref`). Verbs are
 * described as client-agnostic {@link RowActionTarget}s: a renderer with a
 * host turns a target into a call (the table tab) or into a `zotero://` link
 * (the static page); a renderer with neither draws nothing.
 */

import type { ExternalReference } from "../types/externalReferences";
import type { ZoteroItemReference } from "../types/zotero";
import {
    UNRESOLVED_LIBRARY_ID,
    parseItemReference,
} from "../identity/libraryRef";
import type { Row, TableSpec, ZoteroRowReference } from "./table";

/**
 * Verbs a row may offer. Add-only: the names are persisted in stored tables
 * (`capabilities.row_actions`, `Row.actions`).
 */
export const ROW_ACTIONS = ["reveal", "open", "import"] as const;

export type RowAction = (typeof ROW_ACTIONS)[number];

/**
 * What performing a verb on a row means, in terms a client can act on. Each
 * target names one operation, so a host maps it to exactly one call and a
 * static rendering to at most one link.
 */
export type RowActionTarget =
    /** Select the item in the library view. */
    | { kind: "reveal_item"; ref: ZoteroItemReference }
    /** Open this file attachment. A static rendering can link straight to it. */
    | { kind: "open_file"; ref: ZoteroItemReference }
    /**
     * Open the item's file, whichever the host decides is best. Resolved at
     * click time, so a static rendering has no link for it.
     */
    | { kind: "open_item"; ref: ZoteroItemReference }
    /** Add the reference to the library — a write, carried by the host's own UI. */
    | { kind: "import_reference"; reference: ExternalReference };

/**
 * The wire reference for a stored one. A table travels between devices, so its
 * references may carry no rowid; hosts resolve those through `library_ref`.
 */
function bare(
    ref: ZoteroRowReference | ZoteroItemReference,
): ZoteroItemReference {
    return {
        library_id: ref.library_id ?? UNRESOLVED_LIBRARY_ID,
        zotero_key: ref.zotero_key,
        library_ref: ref.library_ref,
    };
}

/**
 * The Zotero attachment a document id names (`u-KEY`, `g<groupID>-KEY`), or
 * undefined for a malformed id.
 */
export function documentReference(
    document: string | undefined,
): ZoteroItemReference | undefined {
    const parsed = document ? parseItemReference(document) : null;
    if (!parsed) return undefined;
    return {
        library_id: parsed.library_id ?? UNRESOLVED_LIBRARY_ID,
        zotero_key: parsed.zotero_key,
        ...(parsed.library_ref ? { library_ref: parsed.library_ref } : {}),
    };
}

/**
 * Whether the row's subject is in the user's library. The explicit flag wins;
 * otherwise a Zotero item is, and an external work once it lists a library
 * copy.
 */
export function isRowInLibrary(row: Row): boolean {
    if (row.in_library != null) return row.in_library;
    const ref = row.ref;
    if (!ref) return false;
    return ref.kind === "item" || (ref.reference?.library_items?.length ?? 0) > 0;
}

/**
 * Where `action` points for this row, or `undefined` when the row cannot
 * support it. Does not consult the table's declared verbs — {@link rowActions}
 * does that; this answers what the row itself can do.
 */
export function rowActionTarget(
    row: Row,
    action: RowAction,
): RowActionTarget | undefined {
    const ref = row.ref;
    if (!ref) return undefined;
    const inLibrary = isRowInLibrary(row);
    if (ref.kind === "item") {
        // A producer that marks an item as no longer in the library (deleted,
        // out of reach) takes its verbs with it.
        if (!inLibrary) return undefined;
        if (action === "reveal") return { kind: "reveal_item", ref: bare(ref) };
        if (action === "open") {
            // With the file named, a static rendering can link to it;
            // without, the host picks the best attachment when clicked.
            const file = documentReference(row.documents?.[0]);
            if (!file) return { kind: "open_item", ref: bare(ref) };
            // The item's rowid names the document's library too when both are
            // in the same one.
            if (file.library_ref === ref.library_ref && ref.library_id != null)
                file.library_id = ref.library_id;
            return { kind: "open_file", ref: file };
        }
        return undefined;
    }
    const copy = ref.reference?.library_items?.[0];
    if (action === "import")
        // Importing needs the bibliographic payload; a ref without it cannot
        // offer the verb, whatever the table declares.
        return !inLibrary && ref.reference
            ? { kind: "import_reference", reference: ref.reference }
            : undefined;
    if (!inLibrary || !copy) return undefined;
    if (action === "reveal") return { kind: "reveal_item", ref: bare(copy) };
    return { kind: "open_item", ref: bare(copy) };
}

/**
 * The verbs this row actually offers, in declared order: the table (or the
 * row) names the candidates, and the row decides which of them have a target.
 * A renderer never draws "import" on a row already in the library or "open"
 * on one with nothing to open. A row with no `ref` offers nothing.
 */
export function rowActions(spec: TableSpec, row: Row): RowAction[] {
    if (!row.ref) return [];
    const declared = row.actions ?? spec.capabilities?.row_actions ?? [];
    return declared.filter((action) => !!rowActionTarget(row, action));
}
