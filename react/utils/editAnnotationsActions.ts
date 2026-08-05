import type { AgentAction } from "../agents/agentActions";
import type { WSAgentActionExecuteRequest } from "@beaver/agent-core/protocol/agentProtocol";
import type {
    AnnotationBeforeSnapshot,
    EditAnnotationsPatch,
    EditAnnotationsProposedData,
    EditAnnotationsResultData,
} from "@beaver/agent-core/types/agentActions/editAnnotations";
import {
    executeEditAnnotationsAction as executeHandler,
    loadAnnotationEditData,
} from "../../src/services/agentDataProvider/actions/editAnnotations";
import { ZOTERO_ANNOTATION_PALETTE_COLORS } from "../../src/constants/annotations";
import { saveItem } from "../../src/utils/zoteroUtils";
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

type AnnotationTag = string | { tag: string };

type CurrentState = {
    color: string;
    comment: string;
    // Normalized to setTags()'s input shape so the rollback path can write it back.
    tags: Array<{ tag: string; type: number }>;
    deleted: boolean;
};

type ResolvedAnnotation = {
    item: Zotero.Item;
    snapshot: AnnotationBeforeSnapshot;
    current: CurrentState;
};

/** Zotero normalizes annotation strings on write (trim + NFC, empty -> null). */
function normalizeText(value: unknown): string {
    return value == null ? "" : String(value).trim().normalize();
}

function tagNames(tags: AnnotationTag[] | null | undefined): string[] {
    if (!tags) return [];
    return [
        ...new Set(tags.map((tag) => (typeof tag === "string" ? tag : tag.tag))),
    ].sort();
}

function tagsEqual(
    a: AnnotationTag[] | null | undefined,
    b: AnnotationTag[] | null | undefined,
): boolean {
    const left = tagNames(a);
    const right = tagNames(b);
    return (
        left.length === right.length &&
        left.every((tag, index) => tag === right[index])
    );
}

/**
 * The values the action actually wrote for one annotation, per field it
 * changed. Fields absent from the patch were never touched, so undo must
 * leave them alone. Tag verbs are resolved against that annotation's own
 * pre-edit tags, which is what the action itself did.
 */
function appliedValues(
    patch: EditAnnotationsPatch | undefined,
    before: AnnotationBeforeSnapshot,
): {
    color?: string;
    comment?: string;
    tags?: string[];
} {
    const color =
        patch?.color != null
            ? ZOTERO_ANNOTATION_PALETTE_COLORS[patch.color]
            : undefined;
    let tags: string[] | undefined;
    if (patch?.add_tags != null || patch?.remove_tags != null) {
        const removed = new Set(patch.remove_tags ?? []);
        const kept = before.tags.filter((tag) => !removed.has(tag));
        const added = (patch.add_tags ?? []).filter(
            (tag) => !kept.includes(tag),
        );
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

/**
 * Fields the user changed on a relocated annotation's replacement since the
 * move.
 *
 * The move copied the original's metadata (patched, where the same edit also
 * changed fields) onto the replacement. Anything that no longer matches is the
 * user's own later work — trashing the replacement would discard it, so undo
 * must ask first, exactly as it does for an in-place edit.
 */
function replacementDrift(
    current: CurrentState,
    snapshot: AnnotationBeforeSnapshot,
    applied: { color?: string; comment?: string; tags?: string[] },
): string[] {
    const drifted: string[] = [];
    if (normalizeText(current.color) !== normalizeText(applied.color ?? snapshot.color))
        drifted.push("color");
    if (
        normalizeText(current.comment) !==
        normalizeText(applied.comment ?? snapshot.comment)
    )
        drifted.push("comment");
    if (!tagsEqual(current.tags, applied.tags ?? snapshot.tags))
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
 * Field edits are reconciled three ways per field: a field still holding the
 * applied value is reverted, a field already back at its original value is
 * skipped, and a field the user has since changed by hand is preserved unless
 * `forceRevert` is set. Deletions and moves only put items in and out of the
 * trash, so they are simply reapplied idempotently.
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
    // Only the annotations that were moved changed identity; the rest were
    // edited in place and reconcile field by field.
    const relocatedOldIds = new Set(
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
            },
        });
    }

    // Keyed by the OLD annotation id so each snapshot finds its replacement
    // even when only part of the batch moved.
    const replacements = new Map<
        string,
        { item: Zotero.Item; deleted: boolean; current: CurrentState }
    >();
    for (const mapping of result?.relocated ?? []) {
        assertAnnotationLibraryNotExcluded(mapping.new_ref);
        const replacement = await resolveItemReference(mapping.new_ref);
        if (replacement.status !== "found" || !replacement.item.isAnnotation()) {
            throw new Error(
                `Replacement annotation ${mapping.new_ref.zotero_key} is no longer available`,
            );
        }
        await loadAnnotationEditData(replacement.item);
        replacements.set(annotationKey(mapping.old_ref), {
            item: replacement.item,
            deleted: replacement.item.deleted,
            current: {
                color: replacement.item.annotationColor,
                comment: replacement.item.annotationComment,
                tags: replacement.item
                    .getTags()
                    .map((tag) => ({ tag: tag.tag, type: tag.type ?? 0 })),
                deleted: replacement.item.deleted,
            },
        });
    }

    const undoResult = emptyResult();
    const alreadyReverted = new Set<string>();
    const manuallyModified = new Set<string>();

    try {
        await Zotero.DB.executeTransaction(async () => {
            for (let index = 0; index < resolved.length; index++) {
                const { item, snapshot, current } = resolved[index];
                const wasRelocated = relocatedOldIds.has(snapshot.annotation_id);
                const applied = appliedValues(
                    patches.get(snapshot.annotation_id),
                    snapshot,
                );
                const replacement = replacements.get(snapshot.annotation_id);

                if (wasRelocated && replacement && !replacement.deleted) {
                    const drifted = replacementDrift(
                        replacement.current,
                        snapshot,
                        applied,
                    );
                    if (drifted.length && !forceRevert) {
                        // Undoing a move is all-or-nothing: restoring the
                        // original while leaving the edited replacement in
                        // place would duplicate the annotation. Leave the pair
                        // untouched and let the caller confirm.
                        drifted.forEach((field) => manuallyModified.add(field));
                        continue;
                    }
                }

                let dirty = false;

                if (operation === "edit" && !wasRelocated) {
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
                            tagsEqual(current.tags, snapshot.tags),
                            tagsEqual(current.tags, applied.tags),
                            forceRevert,
                        );
                        if (outcome === "revert")
                            revert(() => item.setTags(snapshot.tags));
                        else record("tags", outcome);
                    }
                } else {
                    // A deletion or a move only trashed the original.
                    const target = snapshot.deleted ?? false;
                    if (current.deleted === target) {
                        alreadyReverted.add("deleted");
                    } else {
                        item.deleted = target;
                        undoResult.fieldsReverted++;
                        dirty = true;
                    }
                }

                if (dirty) await saveItem(item);

                if (replacement && !replacement.deleted) {
                    replacement.item.deleted = true;
                    await saveItem(replacement.item);
                }
            }
        });
    } catch (error) {
        for (const { item, current } of resolved) {
            item.annotationColor = current.color;
            item.annotationComment = current.comment;
            item.setTags(current.tags);
            item.deleted = current.deleted;
        }
        for (const replacement of replacements.values()) {
            replacement.item.annotationColor = replacement.current.color;
            replacement.item.annotationComment = replacement.current.comment;
            replacement.item.setTags(replacement.current.tags);
            replacement.item.deleted = replacement.deleted;
        }
        throw error;
    }

    undoResult.alreadyReverted = [...alreadyReverted];
    undoResult.manuallyModified = [...manuallyModified];
    undoResult.needsConfirmation =
        undoResult.manuallyModified.length > 0 && !forceRevert;
    return undoResult;
}
