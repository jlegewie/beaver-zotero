/**
 * Row kinds: everything about a table row that depends on *what the row is*.
 *
 * A `Row.ref` is a discriminated union (`RowRef`), and this module is the one
 * place that switches on it. Each kind declares how its id is derived, whether
 * it counts as in the library, which anchor cell values may describe it, which
 * verb its anchor cell carries, and where each verb points. Everything else —
 * the React grid, the static HTML, CSV — asks these helpers instead of
 * branching on `ref.kind` itself, so adding a kind means adding one entry to
 * {@link ROW_KINDS} and nothing elsewhere fails to notice: the registry is
 * typed per kind, so a missing entry is a compile error.
 *
 * Verbs are described as client-agnostic {@link RowActionTarget}s. A renderer
 * with a host turns a target into a call (`react` grid) or into a `zotero://`
 * link (static HTML); a renderer with neither draws nothing.
 */

import type { ExternalReference } from "../types/externalReferences";
import type { ZoteroItemReference } from "../types/zotero";
import type { CellValueKind, Row, RowRef, TableSpec } from "./table";

/**
 * Verbs a row may offer. Add-only: the names are persisted in stored tables
 * (`capabilities.row_actions`, `Row.actions`).
 */
export const ROW_ACTIONS = ["reveal", "open", "import"] as const;

export type RowAction = (typeof ROW_ACTIONS)[number];

export type RowKind = RowRef["kind"];

type RefOf<K extends RowKind> = Extract<RowRef, { kind: K }>;

/**
 * What performing a verb on a row means, in terms a client can act on without
 * knowing the row kind. Each target names one operation, so a host maps it to
 * exactly one call and a static rendering to at most one link.
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
    /** Open the reader on `attachment`, scrolled to the annotation. */
    | {
          kind: "open_annotation";
          ref: ZoteroItemReference;
          attachment: ZoteroItemReference;
      }
    /** Launch the local copy of a user-supplied context file. */
    | { kind: "open_external_file"; ext_key: string }
    /** Add the reference to the library — a write, carried by the host's own UI. */
    | { kind: "import_reference"; reference: ExternalReference };

export interface RowKindDef<K extends RowKind = RowKind> {
    /** Stable row id — see {@link rowIdFor}. */
    id(ref: RefOf<K>): string;
    /** In-library state when the row does not say (`Row.in_library` absent). */
    inLibrary(ref: RefOf<K>): boolean;
    /** Anchor cell value kinds that can describe a row of this kind. */
    anchorValueKinds: readonly CellValueKind[];
    /**
     * The verb the anchor cell itself carries — clicking the row's title
     * performs it, so the actions column need not repeat it.
     */
    primaryAction: RowAction;
    /**
     * Where `action` points for this ref, or `undefined` when the ref cannot
     * support it. This is the single source of applicability: a verb is offered
     * exactly when it has a target.
     */
    target(
        ref: RefOf<K>,
        action: RowAction,
        inLibrary: boolean,
    ): RowActionTarget | undefined;
}

/** Zotero object kinds share one id scheme: the key is the identity, whatever the object is. */
function zoteroRowId(ref: ZoteroItemReference): string {
    return `item:${ref.library_ref ?? ref.library_id}:${ref.zotero_key}`;
}

function bare(ref: ZoteroItemReference): ZoteroItemReference {
    return {
        library_id: ref.library_id,
        zotero_key: ref.zotero_key,
        library_ref: ref.library_ref,
    };
}

export const ROW_KINDS: { [K in RowKind]: RowKindDef<K> } = {
    item: {
        id: zoteroRowId,
        inLibrary: () => true,
        anchorValueKinds: ["reference"],
        primaryAction: "reveal",
        target(ref, action, inLibrary) {
            // A producer that marks a library object as no longer in the
            // library (deleted, out of reach) takes its verbs with it.
            if (!inLibrary) return undefined;
            if (action === "reveal")
                return { kind: "reveal_item", ref: bare(ref) };
            if (action === "open")
                // With the file named, a static rendering can link to it;
                // without, the host picks the best attachment when clicked.
                return ref.attachment
                    ? { kind: "open_file", ref: ref.attachment }
                    : { kind: "open_item", ref: bare(ref) };
            return undefined;
        },
    },
    attachment: {
        id: zoteroRowId,
        inLibrary: () => true,
        anchorValueKinds: ["reference"],
        primaryAction: "reveal",
        target(ref, action, inLibrary) {
            if (!inLibrary) return undefined;
            if (action === "reveal")
                return { kind: "reveal_item", ref: bare(ref) };
            if (action === "open") return { kind: "open_file", ref: bare(ref) };
            return undefined;
        },
    },
    annotation: {
        id: zoteroRowId,
        inLibrary: () => true,
        anchorValueKinds: ["annotation"],
        // An annotation has no row in the items tree; the reader is where it
        // is shown, so opening it is the verb its text carries.
        primaryAction: "open",
        target(ref, action, inLibrary) {
            if (!inLibrary) return undefined;
            if (action === "reveal")
                return {
                    kind: "reveal_item",
                    ref: ref.parent_item ?? ref.attachment,
                };
            if (action === "open")
                return {
                    kind: "open_annotation",
                    ref: bare(ref),
                    attachment: ref.attachment,
                };
            return undefined;
        },
    },
    external: {
        id: (ref) => `ext:${ref.source}:${ref.source_id}`,
        inLibrary: (ref) => (ref.reference?.library_items?.length ?? 0) > 0,
        anchorValueKinds: ["reference"],
        primaryAction: "reveal",
        target(ref, action, inLibrary) {
            const copy = ref.reference?.library_items?.[0];
            if (action === "import")
                // Importing needs the bibliographic payload; a ref without it
                // cannot offer the verb, whatever the table declares.
                return !inLibrary && ref.reference
                    ? { kind: "import_reference", reference: ref.reference }
                    : undefined;
            if (!inLibrary || !copy) return undefined;
            const libraryRef = bare(copy);
            if (action === "reveal")
                return { kind: "reveal_item", ref: libraryRef };
            return { kind: "open_item", ref: libraryRef };
        },
    },
    file: {
        id: (ref) => `file:${ref.ext_key}`,
        // A context file is not a library item and not a work with an external
        // identity: nothing to reveal, nothing to import, only the file to open.
        inLibrary: () => false,
        anchorValueKinds: ["reference"],
        primaryAction: "open",
        target(ref, action) {
            return action === "open"
                ? { kind: "open_external_file", ext_key: ref.ext_key }
                : undefined;
        },
    },
};

/** The kind entry for a ref, typed against that ref. */
export function rowKindOf<R extends RowRef>(ref: R): RowKindDef<R["kind"]> {
    return ROW_KINDS[ref.kind] as RowKindDef<R["kind"]>;
}

/**
 * Stable row id derived from what the row is about, so the same paper gets the
 * same id across regenerations (and snapshot annotations stay anchored).
 */
export function rowIdFor(ref: RowRef): string {
    return rowKindOf(ref).id(ref as never);
}

/**
 * Whether the row's subject is in the user's library. The explicit flag wins;
 * otherwise the kind decides — a Zotero object is by definition in a library,
 * an external reference once it lists a library copy, a context file never.
 */
export function isRowInLibrary(row: Row): boolean {
    if (row.in_library != null) return row.in_library;
    if (!row.ref) return false;
    return rowKindOf(row.ref).inLibrary(row.ref as never);
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
    if (!row.ref) return undefined;
    return rowKindOf(row.ref).target(
        row.ref as never,
        action,
        isRowInLibrary(row),
    );
}

/**
 * The verbs this row actually offers, in declared order: the table (or the
 * row) names the candidates, and the row's kind decides which of them have a
 * target. A renderer never draws "import" on a row already in the library or
 * "open" on one with nothing to open. A row with no `ref` offers nothing.
 */
export function rowActions(spec: TableSpec, row: Row): RowAction[] {
    if (!row.ref) return [];
    const declared = row.actions ?? spec.capabilities?.row_actions ?? [];
    return declared.filter((action) => !!rowActionTarget(row, action));
}

/** The verb the row's anchor cell carries, if the row has a kind. */
export function rowPrimaryAction(row: Row): RowAction | undefined {
    return row.ref ? rowKindOf(row.ref).primaryAction : undefined;
}

/** Anchor cell value kinds that can describe this ref. */
export function anchorValueKindsFor(ref: RowRef): readonly CellValueKind[] {
    return rowKindOf(ref).anchorValueKinds;
}
