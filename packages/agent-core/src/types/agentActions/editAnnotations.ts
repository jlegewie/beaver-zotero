import type { ZoteroItemReference } from "../zotero";

/** Zotero's eight native reader palette names. */
export type NativeAnnotationColor =
    | "yellow"
    | "red"
    | "green"
    | "blue"
    | "purple"
    | "magenta"
    | "orange"
    | "gray";

/**
 * Field patch applied to every annotation in one edit group.
 *
 * Tag edits are additive only so a batch never destroys per-annotation tags the
 * caller did not name — the same two verbs `organize_items` uses for tags on
 * any item. Replacing a tag set wholesale is spelled as removing the current
 * tags and adding the new ones.
 */
export interface EditAnnotationsPatch {
    color?: NativeAnnotationColor | null;
    comment?: string | null;
    add_tags?: string[] | null;
    remove_tags?: string[] | null;
}

/**
 * One set of annotations receiving the same change.
 *
 * A group carries a patch, a relocation, or both. Relocation recreates the
 * annotation at a new locator, so a relocating group targets exactly one
 * annotation — a shared locator would stack them all on one spot.
 */
export interface AnnotationEditGroup {
    annotation_refs: ZoteroItemReference[];
    changes?: EditAnnotationsPatch;
    /** A client-resolved compact locator such as `s12`, `heading3`, or `page5`. */
    relocation?: { locator: string };
}

/** One annotation dropped during validation, with the reason why. */
export interface SkippedAnnotation {
    annotation_id: string;
    reason: string;
}

interface EditAnnotationsBase {
    /** Targets the client could not act on; recorded, never applied. */
    skipped?: SkippedAnnotation[];
}

export interface EditAnnotationsEditProposedData extends EditAnnotationsBase {
    operation: "edit";
    edits: AnnotationEditGroup[];
}

export interface EditAnnotationsDeleteProposedData extends EditAnnotationsBase {
    operation: "delete";
    annotation_refs: ZoteroItemReference[];
}

/**
 * Backend-normalized, approval-persisted edit_annotations action.
 *
 * The `edit_annotations` and `delete_annotations` tools share this one action
 * type so the client keeps a single validate/execute/undo path.
 */
export type EditAnnotationsProposedData =
    | EditAnnotationsEditProposedData
    | EditAnnotationsDeleteProposedData;

export interface AnnotationBeforeSnapshot extends ZoteroItemReference {
    annotation_id: string;
    color: string;
    comment: string;
    tags: string[];
    deleted?: boolean;
}

export interface AnnotationRelocationMapping {
    old_ref: ZoteroItemReference;
    new_ref: ZoteroItemReference;
}

/**
 * `before` snapshots every annotation the client touched (the undo source).
 * `applied_refs` is the same set afterwards, positionally aligned with
 * `before`; it differs only where an annotation was relocated, since that
 * recreates the item under a new key. `relocated` carries those pairings.
 */
export interface EditAnnotationsResultData {
    operation: EditAnnotationsProposedData["operation"];
    applied_refs: ZoteroItemReference[];
    before: AnnotationBeforeSnapshot[];
    relocated?: AnnotationRelocationMapping[];
}

/** Every annotation an action targets, in the order the client applies them. */
export function editAnnotationsTargets(
    data: EditAnnotationsProposedData | undefined,
): ZoteroItemReference[] {
    if (!data) return [];
    if (data.operation === "delete") return data.annotation_refs ?? [];
    return (data.edits ?? []).flatMap((group) => group.annotation_refs ?? []);
}
