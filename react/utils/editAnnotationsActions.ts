import type { AgentAction } from "../agents/agentActions";
import type { WSAgentActionExecuteRequest } from "@beaver/agent-core/protocol/agentProtocol";
import type {
    AnnotationBeforeSnapshot,
    AnnotationPlacementSnapshot,
    EditAnnotationsPatch,
    EditAnnotationsProposedData,
    EditAnnotationsResultData,
} from "@beaver/agent-core/types/agentActions/editAnnotations";
import {
    applyAnnotationPlacement,
    type AnnotationPlacement,
} from "../../src/services/annotations/createAnnotation";
import {
    executeEditAnnotationsAction as executeHandler,
    loadAnnotationEditData,
} from "../../src/services/agentDataProvider/actions/editAnnotations";
import { ZOTERO_ANNOTATION_PALETTE_COLORS } from "../../src/constants/annotations";
import { refreshMovedAnnotationsInOpenReaders } from "../../src/services/annotations/readerSync";
import {
    modelObjectId,
    resolveItemReference,
    resolveLibraryRef,
} from "../../src/utils/libraryIdentity";
import {
    checkLibraryExcluded,
    excludedLibraryUserMessage,
} from "../../src/services/agentDataProvider/utils";
import type { UndoResult } from "./editMetadataActions";

/** Undo errors carry a separate user-facing message for the sidebar. */
type UndoUserFacingError = Error & { userMessage?: string };

export async function executeEditAnnotationsAction(
    action: AgentAction,
): Promise<EditAnnotationsResultData> {
    const controller = new AbortController();
    const response = await executeHandler(
        {
            event: "agent_action_execute",
            request_id: action.id,
            action_type: "edit_annotations",
            action_data: action.proposed_data,
        } as WSAgentActionExecuteRequest,
        {
            signal: controller.signal,
            timeoutSeconds: 25,
            startTime: Date.now(),
        },
    );
    if (!response.success)
        throw new Error(response.error ?? "Failed to edit annotations");
    return response.result_data as unknown as EditAnnotationsResultData;
}

type AnnotationTag = string | { tag: string; type?: number };

type CurrentState = {
    color: string;
    comment: string;
    // Normalized to setTags()'s input shape so the rollback path can write it back.
    tags: Array<{ tag: string; type: number }>;
    deleted: boolean;
    /** Present only when the action moved this annotation. */
    placement?: AnnotationPlacement;
};

type ResolvedAnnotation = {
    item: Zotero.Item;
    snapshot: AnnotationBeforeSnapshot;
    current: CurrentState;
};

function toPlacement(
    recorded: Partial<AnnotationPlacementSnapshot> | undefined,
): AnnotationPlacement | null {
    if (!recorded?.position) return null;
    return {
        ...(recorded.text !== undefined ? { text: recorded.text } : {}),
        pageLabel: recorded.page_label ?? "",
        sortIndex: recorded.sort_index ?? "",
        position: recorded.position,
    };
}

/**
 * Where the annotation sat before the action moved it, if it moved one.
 * `position` is written only by a move, so its presence is what marks a
 * snapshot as carrying somewhere to go back to.
 */
function snapshotPlacement(
    snapshot: AnnotationBeforeSnapshot,
): AnnotationPlacement | null {
    return toPlacement(snapshot);
}

/** Where an annotation sits right now, for comparison against a snapshot. */
function currentPlacement(
    item: Zotero.Item,
    isHighlight: boolean,
): AnnotationPlacement {
    const { annotationSortIndex } = item as unknown as ZoteroAnnotationItem;
    return {
        ...(isHighlight ? { text: item.annotationText ?? "" } : {}),
        pageLabel: item.annotationPageLabel ?? "",
        sortIndex: annotationSortIndex ?? "",
        position: item.annotationPosition ?? "",
    };
}

function placementsEqual(
    a: AnnotationPlacement | null | undefined,
    b: AnnotationPlacement | null | undefined,
): boolean {
    if (!a || !b) return a === b;
    return (
        a.position === b.position &&
        a.sortIndex === b.sortIndex &&
        normalizeText(a.pageLabel) === normalizeText(b.pageLabel) &&
        normalizeText(a.text) === normalizeText(b.text)
    );
}

/** Zotero normalizes annotation strings on write (trim + NFC, empty -> null). */
function normalizeText(value: unknown): string {
    return value == null ? "" : String(value).trim().normalize();
}

/**
 * Identity of a tag for comparison: its name AND its type.
 *
 * Filing an automatic tag as manual is a change the user can make on their
 * own, so a name-only comparison would read it as "still exactly what the
 * action wrote" and let undo quietly file it back as automatic. A bare string
 * is a manual tag, which is how `setTags()` reads one.
 */
function tagKey(tag: AnnotationTag): string {
    return typeof tag === "string"
        ? `0:${tag}`
        : `${tag.type ?? 0}:${tag.tag}`;
}

function tagKeys(tags: AnnotationTag[] | null | undefined): string[] {
    if (!tags) return [];
    return [...new Set(tags.map(tagKey))].sort();
}

function tagsEqual(
    a: AnnotationTag[] | null | undefined,
    b: AnnotationTag[] | null | undefined,
): boolean {
    const left = tagKeys(a);
    const right = tagKeys(b);
    return (
        left.length === right.length &&
        left.every((tag, index) => tag === right[index])
    );
}

/**
 * The tag set to write back when reverting an annotation, with the automatic
 * and manual types it carried.
 *
 * `snapshot.tags` holds names alone because the cards render from it; passing
 * those names to `setTags()` would file every automatic tag as a manual one.
 */
function snapshotTags(
    snapshot: AnnotationBeforeSnapshot,
): Array<{ tag: string; type: number }> {
    const automatic = new Set(snapshot.automatic_tags ?? []);
    return snapshot.tags.map((tag) => ({
        tag,
        type: automatic.has(tag) ? 1 : 0,
    }));
}

/** What one action wrote for a single annotation, per field it changed. */
type AppliedValues = {
    color?: string;
    comment?: string;
    tags?: Array<{ tag: string; type: number }>;
};

/**
 * The values the action actually wrote for one annotation, per field it
 * changed. Fields absent from the patch were never touched, so undo must
 * leave them alone. Tag verbs are resolved against that annotation's own
 * pre-edit tags, which is what the action itself did.
 */
function appliedValues(
    patch: EditAnnotationsPatch | undefined,
    before: AnnotationBeforeSnapshot,
): AppliedValues {
    const color =
        patch?.color != null
            ? ZOTERO_ANNOTATION_PALETTE_COLORS[patch.color]
            : undefined;
    let tags: Array<{ tag: string; type: number }> | undefined;
    if (patch?.add_tags != null || patch?.remove_tags != null) {
        // Mirrors what the action wrote: retained tags keep the types they
        // had, and a newly added tag is manual.
        const removed = new Set(patch.remove_tags ?? []);
        const kept = snapshotTags(before).filter(
            (tag) => !removed.has(tag.tag),
        );
        const keptNames = new Set(kept.map((tag) => tag.tag));
        const added = (patch.add_tags ?? [])
            .filter((tag) => !keptNames.has(tag))
            .map((tag) => ({ tag, type: 0 }));
        tags = [...kept, ...added];
    }
    return {
        ...(color ? { color } : {}),
        ...(patch?.comment != null ? { comment: patch.comment } : {}),
        ...(tags !== undefined ? { tags } : {}),
    };
}

/**
 * Reject an annotation mutation before any item lookup crosses the privacy
 * boundary.
 *
 * A library can be excluded AFTER an action was applied; undo still writes to
 * the annotations it touched, so the boundary has to be re-checked here rather
 * than trusted from execution time.
 */
function assertAnnotationLibraryNotExcluded(ref: {
    library_id?: number | null;
    library_ref?: string | null;
}): void {
    const libraryId = resolveLibraryRef(ref);
    if (libraryId === null) return;
    const exclusion = checkLibraryExcluded(libraryId);
    if (!exclusion) return;
    const error: UndoUserFacingError = new Error(exclusion.message);
    error.userMessage = excludedLibraryUserMessage(libraryId);
    throw error;
}

/**
 * Identity key for an annotation reference.
 *
 * MUST match how `before[].annotation_id` is built when the action is
 * executed (`modelObjectId`), which yields the device-portable form
 * (`u-KEY` / `g<groupID>-KEY`) — not the numeric `library_id`. Keying these
 * maps the numeric way makes every lookup miss and undo a silent no-op.
 */
function annotationKey(ref: {
    library_id: number;
    zotero_key: string;
    library_ref?: string;
}): string {
    // Prefer the reference's own portable library ref: `modelObjectId`
    // resolves the numeric id through THIS device's library map, so undoing on
    // a different device than the one that executed would produce a different
    // string than the stored snapshot and miss every lookup.
    if (ref.library_ref) return `${ref.library_ref}-${ref.zotero_key}`;
    return modelObjectId(ref.library_id, ref.zotero_key);
}

/**
 * Map each annotation id to the patch its edit group applied.
 *
 * An action can carry a different patch per group, so undo has to reconcile
 * each annotation against the patch that actually touched it.
 */
function patchesByAnnotation(
    proposed: EditAnnotationsProposedData | undefined,
): Map<string, EditAnnotationsPatch | undefined> {
    const patches = new Map<string, EditAnnotationsPatch | undefined>();
    if (!proposed || proposed.operation !== "edit") return patches;
    for (const group of proposed.edits ?? []) {
        for (const ref of group.annotation_refs ?? []) {
            patches.set(annotationKey(ref), group.changes);
        }
    }
    return patches;
}

function replacementDrift(
    current: CurrentState,
    snapshot: AnnotationBeforeSnapshot,
    applied: AppliedValues,
): string[] {
    const drifted: string[] = [];
    if (
        normalizeText(current.color) !==
        normalizeText(applied.color ?? snapshot.color)
    )
        drifted.push("color");
    if (
        normalizeText(current.comment) !==
        normalizeText(applied.comment ?? snapshot.comment)
    )
        drifted.push("comment");
    if (!tagsEqual(current.tags, applied.tags ?? snapshotTags(snapshot)))
        drifted.push("tags");
    return drifted;
}

function emptyResult(): UndoResult {
    return {
        fieldsReverted: 0,
        alreadyReverted: [],
        manuallyModified: [],
        needsConfirmation: false,
    };
}

/**
 * Classify a field against its original and applied values:
 * - `already`: the field is back at (or never left) the pre-edit value
 * - `revert`: the field still holds what the action wrote
 * - `manual`: the field holds something else, i.e. the user changed it since
 */
type FieldOutcome = "already" | "revert" | "manual";

function reconcile(
    matchesOriginal: boolean,
    matchesApplied: boolean,
    forceRevert: boolean,
): FieldOutcome {
    if (matchesOriginal) return "already";
    if (matchesApplied || forceRevert) return "revert";
    return "manual";
}

function reconcileText(
    current: unknown,
    original: unknown,
    appliedValue: unknown,
    forceRevert: boolean,
): FieldOutcome {
    return reconcile(
        normalizeText(current) === normalizeText(original),
        normalizeText(current) === normalizeText(appliedValue),
        forceRevert,
    );
}

/**
 * Restore the pre-edit state of an applied edit_annotations action.
 *
 * Every field is reconciled three ways: one still holding the applied value is
 * reverted, one already back at its original value is skipped, and one the
 * user has since changed by hand is preserved unless `forceRevert` is set.
 * Position is reconciled the same way as color, comment, and tags — a move
 * rewrites the annotation in place, so putting it back is just another field
 * revert, and a user who has since dragged it somewhere else is not overruled.
 * Deletions only move items in and out of the trash and are reapplied
 * idempotently.
 *
 * @param action The applied action to undo
 * @param forceRevert Overwrite fields the user changed after the edit
 */
export async function undoEditAnnotationsAction(
    action: AgentAction,
    forceRevert: boolean = false,
): Promise<UndoResult> {
    const result = action.result_data as unknown as
        | EditAnnotationsResultData
        | undefined;
    const before = result?.before ?? [];
    if (!before.length)
        throw new Error("Annotation edit is missing before snapshots");
    const operation = result?.operation ?? "edit";
    const proposed = action.proposed_data as unknown as
        | EditAnnotationsProposedData
        | undefined;
    const patches = patchesByAnnotation(proposed);
    const legacyRelocatedIds = new Set(
        (result?.relocated ?? []).map((mapping) =>
            annotationKey(mapping.old_ref),
        ),
    );

    const resolved: ResolvedAnnotation[] = [];
    for (const snapshot of before) {
        assertAnnotationLibraryNotExcluded(snapshot);
        const found = await resolveItemReference(snapshot);
        if (found.status !== "found" || !found.item.isAnnotation()) {
            throw new Error(
                `Annotation ${snapshot.annotation_id} is no longer available`,
            );
        }
        // Annotation fields and tags are lazily loaded, so an action undone
        // from persisted history (after a restart, or once the item has been
        // evicted) would otherwise throw here.
        await loadAnnotationEditData(found.item);
        resolved.push({
            item: found.item,
            snapshot,
            current: {
                color: found.item.annotationColor,
                comment: found.item.annotationComment,
                tags: found.item
                    .getTags()
                    .map((tag) => ({ tag: tag.tag, type: tag.type ?? 0 })),
                deleted: found.item.deleted,
                ...(snapshot.position
                    ? {
                          placement: currentPlacement(
                              found.item,
                              snapshot.annotation_type === "highlight",
                          ),
                      }
                    : {}),
            },
        });
    }

    const legacyReplacements = new Map<
        string,
        { item: Zotero.Item; deleted: boolean; current: CurrentState }
    >();
    for (const mapping of result?.relocated ?? []) {
        assertAnnotationLibraryNotExcluded(mapping.new_ref);
        const found = await resolveItemReference(mapping.new_ref);
        if (found.status !== "found" || !found.item.isAnnotation()) {
            throw new Error(
                `Replacement annotation ${mapping.new_ref.zotero_key} is no longer available`,
            );
        }
        await loadAnnotationEditData(found.item);
        legacyReplacements.set(annotationKey(mapping.old_ref), {
            item: found.item,
            deleted: found.item.deleted,
            current: {
                color: found.item.annotationColor,
                comment: found.item.annotationComment,
                tags: found.item
                    .getTags()
                    .map((tag) => ({ tag: tag.tag, type: tag.type ?? 0 })),
                deleted: found.item.deleted,
            },
        });
    }

    const undoResult = emptyResult();
    const alreadyReverted = new Set<string>();
    const manuallyModified = new Set<string>();
    const movedItems: Array<{ attachmentID: number; item: Zotero.Item }> = [];

    try {
        await Zotero.DB.executeTransaction(async () => {
            for (let index = 0; index < resolved.length; index++) {
                const { item, snapshot, current } = resolved[index];
                const applied = appliedValues(
                    patches.get(snapshot.annotation_id),
                    snapshot,
                );
                const legacyRelocation = legacyRelocatedIds.has(
                    snapshot.annotation_id,
                );
                const replacement = legacyReplacements.get(
                    snapshot.annotation_id,
                );

                if (legacyRelocation && replacement && !replacement.deleted) {
                    const drifted = replacementDrift(
                        replacement.current,
                        snapshot,
                        applied,
                    );
                    if (drifted.length && !forceRevert) {
                        drifted.forEach((field) => manuallyModified.add(field));
                        continue;
                    }
                }

                let dirty = false;
                let placementReverted = false;

                if (operation === "edit" && !legacyRelocation) {
                    // Only fields the action actually wrote are reconciled;
                    // everything else on the annotation is left alone.
                    const revert = (apply: () => void) => {
                        apply();
                        undoResult.fieldsReverted++;
                        dirty = true;
                    };
                    const record = (field: string, outcome: FieldOutcome) => {
                        if (outcome === "already") alreadyReverted.add(field);
                        else manuallyModified.add(field);
                    };

                    if (applied.color !== undefined) {
                        const outcome = reconcileText(
                            current.color,
                            snapshot.color,
                            applied.color,
                            forceRevert,
                        );
                        if (outcome === "revert")
                            revert(() => {
                                item.annotationColor = snapshot.color;
                            });
                        else record("color", outcome);
                    }
                    if (applied.comment !== undefined) {
                        const outcome = reconcileText(
                            current.comment,
                            snapshot.comment,
                            applied.comment,
                            forceRevert,
                        );
                        if (outcome === "revert")
                            revert(() => {
                                item.annotationComment = snapshot.comment;
                            });
                        else record("comment", outcome);
                    }
                    if (applied.tags !== undefined) {
                        const outcome = reconcile(
                            tagsEqual(current.tags, snapshotTags(snapshot)),
                            tagsEqual(current.tags, applied.tags),
                            forceRevert,
                        );
                        if (outcome === "revert")
                            revert(() => item.setTags(snapshotTags(snapshot)));
                        else record("tags", outcome);
                    }
                    // A move is reverted like any other field: the snapshot
                    // holds where the annotation was, and the placement the
                    // action wrote is still on the item unless the user has
                    // since moved it themselves.
                    const original = snapshotPlacement(snapshot);
                    if (original && current.placement) {
                        const outcome = reconcile(
                            placementsEqual(current.placement, original),
                            placementsEqual(
                                current.placement,
                                toPlacement(snapshot.moved_to),
                            ),
                            forceRevert,
                        );
                        if (outcome === "revert")
                            revert(() => {
                                applyAnnotationPlacement(item, original);
                                placementReverted = true;
                            });
                        else record("position", outcome);
                    }
                } else {
                    // A deletion only trashed the annotation.
                    const target = snapshot.deleted ?? false;
                    if (current.deleted === target) {
                        alreadyReverted.add("deleted");
                    } else {
                        item.deleted = target;
                        undoResult.fieldsReverted++;
                        dirty = true;
                    }
                }

                if (dirty) {
                    // save(), not saveTx(): every write joins the transaction
                    // opened above. saveTx() opens its own, which nested inside
                    // an open one waits for a transaction that cannot finish
                    // until this call returns and times out after 30s, rolling
                    // the whole undo back.
                    await item.save();
                    if (placementReverted && item.parentID) {
                        movedItems.push({ attachmentID: item.parentID, item });
                    }
                }
                if (replacement && !replacement.deleted) {
                    replacement.item.deleted = true;
                    await replacement.item.save();
                }
            }
        });
    } catch (error) {
        for (const { item, current } of resolved) {
            item.annotationColor = current.color;
            item.annotationComment = current.comment;
            item.setTags(current.tags);
            item.deleted = current.deleted;
            if (current.placement)
                applyAnnotationPlacement(item, current.placement);
        }
        for (const replacement of legacyReplacements.values()) {
            replacement.item.annotationColor = replacement.current.color;
            replacement.item.annotationComment = replacement.current.comment;
            replacement.item.setTags(replacement.current.tags);
            replacement.item.deleted = replacement.deleted;
        }
        throw error;
    }

    await refreshMovedAnnotationsInOpenReaders(movedItems);

    undoResult.alreadyReverted = [...alreadyReverted];
    undoResult.manuallyModified = [...manuallyModified];
    undoResult.needsConfirmation =
        undoResult.manuallyModified.length > 0 && !forceRevert;
    return undoResult;
}
