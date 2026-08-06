import type { BoundingBox } from "../citations";
import type { NotePosition } from "./annotations";
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

/** One page's worth of highlight extent, in the extraction page frame. */
export interface RelocationPageLocation {
    page_idx: number;
    boxes: BoundingBox[];
    page_label?: string | null;
    reading_order_offset?: number | null;
}

/**
 * Where an annotation moves to, resolved against the source document before it
 * reaches this client — the same destination shape the create-annotation
 * actions carry, so a move lands where creating the annotation there would.
 *
 * Both PDF shapes arrive when both are available, because only this client
 * knows the annotation's type. Pick the one matching the annotation being
 * moved and skip the target when the shape it needs is absent: a page locator
 * positions a sticky note but cannot outline a highlight.
 */
export interface AnnotationRelocation {
    /** The locator as the model wrote it. Reporting only — never re-resolved. */
    loc_raw: string;
    content_kind: "pdf" | "epub" | "snapshot";
    /** An annotation cannot move between attachments; reject a mismatch. */
    attachment_ref: ZoteroItemReference;
    /** PDF highlight extent. Absent when the destination cannot be outlined. */
    page_locations?: RelocationPageLocation[] | null;
    /** PDF note margin anchor. Absent for EPUB and snapshot. */
    note_position?: NotePosition | null;
    text?: string | null;
    page_label?: string | null;
    reading_order_offset?: number | null;
    section_href?: string | null;
    section_ordinal?: number | null;
    anchor_id?: string | null;
}

/**
 * One set of annotations receiving the same change.
 *
 * A group carries a patch, a relocation, or both. A relocation names one
 * destination, so a relocating group targets exactly one annotation — a shared
 * destination would stack them all on one spot.
 */
export interface AnnotationEditGroup {
    annotation_refs: ZoteroItemReference[];
    changes?: EditAnnotationsPatch;
    relocation?: AnnotationRelocation;
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

/** An annotation's placement in its document, as Zotero stores it. */
export interface AnnotationPlacementSnapshot {
    /** `annotationText` — highlights only. */
    text?: string;
    page_label?: string;
    sort_index?: string;
    /** `annotationPosition`, verbatim. */
    position: string;
}

/**
 * Undo record for one annotation: its pre-edit state, plus both endpoints of a
 * move.
 *
 * A move overwrites position in place, so nothing else records where the
 * annotation used to be — without `position` an approved move could not be
 * reverted once the run is history. `moved_to` records where the move put it,
 * which is what lets undo tell "still where Beaver left it" (revert) apart
 * from "the user has since dragged it elsewhere" (leave alone), the same
 * three-way reconciliation the metadata fields get. Both are captured only for
 * an annotation that actually moved.
 */
export interface AnnotationBeforeSnapshot extends ZoteroItemReference {
    annotation_id: string;
    color: string;
    comment: string;
    tags: string[];
    deleted?: boolean;
    annotation_type?: string;
    /** `annotationText` before the move (highlights only). */
    text?: string;
    page_label?: string;
    sort_index?: string;
    /** `annotationPosition` before the move, verbatim. */
    position?: string;
    moved_to?: AnnotationPlacementSnapshot;
}

/** Legacy relocation mapping from the former recreate-and-trash contract. */
export interface AnnotationRelocationMapping {
    old_ref: ZoteroItemReference;
    new_ref: ZoteroItemReference;
}

/**
 * `before` snapshots every annotation the client touched (the undo source) and
 * `applied_refs` is the same set afterwards, positionally aligned. A move
 * rewrites the annotation in place, so identity is stable across every
 * operation and the two lists always name the same annotations.
 */
export interface EditAnnotationsResultData {
    operation: EditAnnotationsProposedData["operation"];
    applied_refs: ZoteroItemReference[];
    before: AnnotationBeforeSnapshot[];
    /** Present only on results persisted by the legacy relocation contract. */
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
