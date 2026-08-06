import type {
    DeferredToolPreference,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
} from "@beaver/agent-core/protocol/agentProtocol";
import type {
    AnnotationBeforeSnapshot,
    AnnotationEditGroup,
    AnnotationPreviewSnapshot,
    AnnotationRelocation,
    EditAnnotationsPatch,
    EditAnnotationsProposedData,
    NativeAnnotationColor,
    SkippedAnnotation,
} from "@beaver/agent-core/types/agentActions/editAnnotations";
import type { ZoteroItemReference } from "@beaver/agent-core/types/zotero";
import { logger } from "@beaver/agent-core/platform/logger";
import { ZOTERO_ANNOTATION_PALETTE_COLORS } from "../../../constants/annotations";
import {
    libraryRefForLibraryID,
    modelObjectId,
    resolveItemReference,
    resolveLibraryRef,
} from "../../../utils/libraryIdentity";
import { saveItem } from "../../../utils/zoteroUtils";
import { applyAnnotationPlacement, type AnnotationPlacement } from "../../annotations/createAnnotation";
import { unsetTrashedAnnotationsInOpenReaders } from "../../annotations/readerSync";
import { checkLibraryExcluded, getDeferredToolPreference } from "../utils";
import { checkAborted, TimeoutContext, TimeoutError } from "../timeout";
import {
    prepareRelocation,
    type RelocatableAnnotationType,
} from "./annotationPlacement";

const MAX_ANNOTATIONS = 50;
const MAX_EDIT_GROUPS = 25;
const VALIDATE_RELOCATION_BUDGET_MS = 60_000;
const ALLOWED_KEYS = new Set([
    "operation",
    "edits",
    "annotation_refs",
    "skipped",
    // Written by validation and persisted on the proposal, which is replayed
    // verbatim on execute and on re-apply. Accepted and ignored here.
    "annotation_previews",
]);
const ALLOWED_GROUP_KEYS = new Set([
    "annotation_refs",
    "changes",
    "relocation",
]);
const ALLOWED_CHANGE_KEYS = new Set([
    "color",
    "comment",
    "add_tags",
    "remove_tags",
]);
const ALLOWED_REF_KEYS = new Set(["library_id", "zotero_key", "library_ref"]);

type ResolvedTarget = {
    id: string;
    item: Zotero.Item;
    attachment: Zotero.Item;
    annotationType: string;
    ref: ZoteroItemReference;
    before: AnnotationBeforeSnapshot;
    /** Index of the group this target belongs to; -1 for a delete. */
    groupIndex: number;
};

type DataResult =
    | { ok: true; data: EditAnnotationsProposedData }
    | { ok: false; error: string; code: string };

function fail(error: string, code: string): DataResult {
    return { ok: false, error, code };
}

function normalizeTags(tags: unknown): string[] | null | undefined | false {
    if (tags === undefined) return undefined;
    if (tags === null) return null;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))
        return false;
    return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function normalizeSkipped(value: unknown): SkippedAnnotation[] | DataResult {
    if (value === undefined) return [];
    if (!Array.isArray(value))
        return fail("skipped must be an array", "invalid_skipped");
    const rows: SkippedAnnotation[] = [];
    for (const row of value) {
        if (
            !row ||
            typeof row !== "object" ||
            typeof row.annotation_id !== "string" ||
            typeof row.reason !== "string"
        ) {
            return fail(
                "Every skipped entry requires annotation_id and reason",
                "invalid_skipped",
            );
        }
        rows.push({ annotation_id: row.annotation_id, reason: row.reason });
    }
    return rows;
}

function normalizeRefs(value: any): ZoteroItemReference[] | DataResult {
    if (!Array.isArray(value) || value.length < 1) {
        return fail(
            "annotation_refs must contain at least one annotation reference",
            "no_annotations",
        );
    }
    if (value.length > MAX_ANNOTATIONS) {
        return fail(
            `edit_annotations supports at most ${MAX_ANNOTATIONS} annotations`,
            "too_many_annotations",
        );
    }
    const refs: ZoteroItemReference[] = [];
    for (const rawRef of value) {
        if (!rawRef || typeof rawRef !== "object" || Array.isArray(rawRef)) {
            return fail(
                "Every annotation_ref must be an object",
                "invalid_annotation_ref",
            );
        }
        const unexpected = Object.keys(rawRef).filter(
            (key) => !ALLOWED_REF_KEYS.has(key),
        );
        if (unexpected.length)
            return fail(
                `Unsupported annotation_ref field(s): ${unexpected.join(", ")}`,
                "field_restricted",
            );
        const libraryId =
            typeof rawRef.library_id === "number"
                ? rawRef.library_id
                : Number(rawRef.library_id ?? 0);
        const zoteroKey =
            typeof rawRef.zotero_key === "string"
                ? rawRef.zotero_key.trim()
                : "";
        const libraryRef =
            typeof rawRef.library_ref === "string"
                ? rawRef.library_ref.trim()
                : undefined;
        if (
            !zoteroKey ||
            (!libraryRef && (!Number.isInteger(libraryId) || libraryId <= 0))
        ) {
            return fail(
                "Every annotation_ref requires zotero_key and a library_id or library_ref",
                "invalid_annotation_ref",
            );
        }
        refs.push({
            library_id: libraryId,
            zotero_key: zoteroKey,
            ...(libraryRef ? { library_ref: libraryRef } : {}),
        });
    }
    return refs;
}

function normalizeChanges(value: any): EditAnnotationsPatch | DataResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return fail("changes must be an object", "invalid_changes");
    }
    const unexpected = Object.keys(value).filter(
        (key) => !ALLOWED_CHANGE_KEYS.has(key),
    );
    if (unexpected.length) {
        return fail(
            `edit_annotations may only change color, comment, and tags; unsupported field(s): ${unexpected.join(", ")}`,
            "field_restricted",
        );
    }

    let color: NativeAnnotationColor | null | undefined;
    if (Object.prototype.hasOwnProperty.call(value, "color")) {
        if (value.color === null) color = null;
        else if (
            typeof value.color !== "string" ||
            !(value.color in ZOTERO_ANNOTATION_PALETTE_COLORS)
        ) {
            return fail(
                `color must be one of: ${Object.keys(ZOTERO_ANNOTATION_PALETTE_COLORS).join(", ")}`,
                "invalid_color",
            );
        } else color = value.color as NativeAnnotationColor;
    }
    if (
        Object.prototype.hasOwnProperty.call(value, "comment") &&
        value.comment !== null &&
        typeof value.comment !== "string"
    ) {
        return fail("comment must be a string or null", "invalid_comment");
    }

    const tagFields: Record<string, string[] | null | undefined> = {};
    for (const key of ["add_tags", "remove_tags"] as const) {
        const normalized = normalizeTags(value[key]);
        if (normalized === false)
            return fail(
                `${key} must be an array of strings or null`,
                "invalid_tags",
            );
        tagFields[key] = normalized;
    }
    const patch: EditAnnotationsPatch = {
        ...(color !== undefined ? { color } : {}),
        ...(Object.prototype.hasOwnProperty.call(value, "comment")
            ? { comment: value.comment }
            : {}),
        ...(tagFields.add_tags !== undefined
            ? { add_tags: tagFields.add_tags }
            : {}),
        ...(tagFields.remove_tags !== undefined
            ? { remove_tags: tagFields.remove_tags }
            : {}),
    };
    if (!Object.values(patch).some((entry) => entry != null)) {
        return fail(
            "At least one of color, comment, add_tags, or remove_tags must be provided",
            "no_changes",
        );
    }
    return patch;
}

const ALLOWED_RELOCATION_KEYS = new Set([
    "loc_raw",
    "content_kind",
    "attachment_ref",
    "page_locations",
    "note_position",
    "text",
    "page_label",
    "reading_order_offset",
    "section_href",
    "section_ordinal",
    "anchor_id",
]);

/**
 * Accept a destination that was already resolved against the source document.
 *
 * Only the shape is checked here: no geometry is recomputed and no locator is
 * re-resolved, so this stays a structural gate. Whether a given destination
 * actually fits the annotation being moved is decided later, once the
 * annotation — and therefore its type — is known.
 */
function normalizeRelocation(value: any): AnnotationRelocation | DataResult {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return fail("relocation must be an object", "invalid_relocation");
    const unexpected = Object.keys(value).filter(
        (key) => !ALLOWED_RELOCATION_KEYS.has(key),
    );
    if (unexpected.length)
        return fail(
            `Unsupported relocation field(s): ${unexpected.join(", ")}`,
            "field_restricted",
        );
    if (
        value.content_kind !== "pdf" &&
        value.content_kind !== "epub" &&
        value.content_kind !== "snapshot"
    ) {
        return fail(
            "relocation.content_kind must be pdf, epub, or snapshot",
            "invalid_relocation",
        );
    }
    const attachmentRef = value.attachment_ref;
    if (
        !attachmentRef ||
        typeof attachmentRef !== "object" ||
        typeof attachmentRef.zotero_key !== "string" ||
        !attachmentRef.zotero_key
    ) {
        return fail(
            "relocation.attachment_ref is required",
            "invalid_relocation",
        );
    }
    if (!value.page_locations?.length && !value.note_position && !value.anchor_id && !value.text) {
        return fail(
            "relocation carries no destination",
            "invalid_relocation",
        );
    }
    return value as AnnotationRelocation;
}

function normalizeGroup(value: any): AnnotationEditGroup | DataResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return fail("Every entry in edits must be an object", "invalid_edit");
    }
    const unexpected = Object.keys(value).filter(
        (key) => !ALLOWED_GROUP_KEYS.has(key),
    );
    if (unexpected.length)
        return fail(
            `Unsupported edit field(s): ${unexpected.join(", ")}`,
            "field_restricted",
        );

    const refs = normalizeRefs(value.annotation_refs);
    if (!Array.isArray(refs)) return refs;

    let changes: EditAnnotationsPatch | undefined;
    if (value.changes !== undefined && value.changes !== null) {
        const normalized = normalizeChanges(value.changes);
        if ("ok" in normalized) return normalized;
        changes = normalized;
    }

    let relocation: AnnotationRelocation | undefined;
    if (value.relocation !== undefined && value.relocation !== null) {
        const normalized = normalizeRelocation(value.relocation);
        if ("ok" in normalized) return normalized;
        // One destination places one annotation; sharing it would stack them.
        if (refs.length !== 1)
            return fail(
                "a relocating edit targets exactly one annotation",
                "invalid_relocation",
            );
        relocation = normalized;
    }

    if (!changes && !relocation)
        return fail(
            "each edit requires changes, a relocation, or both",
            "no_changes",
        );

    return {
        annotation_refs: refs,
        ...(changes ? { changes } : {}),
        ...(relocation ? { relocation } : {}),
    };
}

function normalizeData(
    raw: Record<string, any> | null | undefined,
): DataResult {
    const value = raw ?? {};
    const unexpected = Object.keys(value).filter(
        (key) => !ALLOWED_KEYS.has(key),
    );
    if (unexpected.length)
        return fail(
            `Unsupported edit_annotations field(s): ${unexpected.join(", ")}`,
            "field_restricted",
        );

    const operation = value.operation ?? "edit";
    const skipped = normalizeSkipped(value.skipped);
    if (!Array.isArray(skipped)) return skipped;

    if (operation === "delete") {
        if (value.edits !== undefined)
            return fail("delete does not accept edits", "field_restricted");
        const refs = normalizeRefs(value.annotation_refs);
        if (!Array.isArray(refs)) return refs;
        return { ok: true, data: { operation, annotation_refs: refs, skipped } };
    }

    if (operation !== "edit")
        return fail("operation must be edit or delete", "invalid_operation");

    if (value.annotation_refs !== undefined)
        return fail(
            "edit does not accept a top-level annotation_refs",
            "field_restricted",
        );
    if (!Array.isArray(value.edits) || value.edits.length < 1)
        return fail("edits must contain at least one entry", "no_annotations");
    if (value.edits.length > MAX_EDIT_GROUPS)
        return fail(
            `edit_annotations supports at most ${MAX_EDIT_GROUPS} edits per action`,
            "too_many_edits",
        );

    const seen = new Set<string>();
    const groups: AnnotationEditGroup[] = [];
    for (const rawGroup of value.edits) {
        const group = normalizeGroup(rawGroup);
        if ("ok" in group) return group;
        for (const ref of group.annotation_refs) {
            const key = `${ref.library_ref ?? ref.library_id}-${ref.zotero_key}`;
            if (seen.has(key))
                return fail(
                    `Annotation ${key} appears in more than one edit`,
                    "duplicate_annotation",
                );
            seen.add(key);
        }
        groups.push(group);
    }
    if (seen.size > MAX_ANNOTATIONS)
        return fail(
            `edit_annotations supports at most ${MAX_ANNOTATIONS} annotations`,
            "too_many_annotations",
        );

    return { ok: true, data: { operation: "edit", edits: groups, skipped } };
}

/**
 * Load every lazily-loaded data type an annotation edit touches.
 *
 * An item resolved by key carries primary data only, so reading
 * `annotationColor`/`annotationComment`/`getTags()` on a cold item throws.
 * `annotationDeferred` matters even though nothing here reads the position:
 * saving an annotation rewrites the whole `itemAnnotations` row from in-memory
 * state, so an unloaded position/pageLabel would be persisted as NULL.
 */
export async function loadAnnotationEditData(item: Zotero.Item): Promise<void> {
    await item.loadDataType?.("annotation");
    await item.loadDataType?.("annotationDeferred");
    await item.loadDataType?.("tags");
}

async function isDeleted(item: any): Promise<boolean> {
    if (item.deleted) return true;
    return !!(await Zotero.DB.valueQueryAsync(
        "SELECT 1 FROM deletedItems WHERE itemID = ? LIMIT 1",
        [item.id],
    ));
}

/**
 * Resolve one annotation reference into an editable target.
 *
 * Returns the reason it cannot be edited instead of throwing, so the caller
 * can drop just this annotation and keep the rest of the batch.
 */
async function resolveTarget(
    refInput: ZoteroItemReference,
    groupIndex: number,
    seen: Set<string>,
): Promise<ResolvedTarget | string> {
    const libraryId = resolveLibraryRef(refInput);
    const library = libraryId == null ? null : Zotero.Libraries.get(libraryId);
    if (libraryId == null || !library) return "library was not found";

    const excluded = checkLibraryExcluded(libraryId);
    if (excluded) return excluded.message;
    if (!library.editable) return `library '${library.name}' is read-only`;

    const resolved = await resolveItemReference(refInput);
    if (resolved.status !== "found") return "annotation was not found";

    const item = resolved.item;
    if (!item.isAnnotation()) return "item is not an annotation";
    if (await isDeleted(item)) return "annotation is in the trash";

    await loadAnnotationEditData(item);
    const attachment = item.parentID
        ? await Zotero.Items.getAsync(item.parentID)
        : null;
    if (
        !attachment ||
        !attachment.isAttachment() ||
        (await isDeleted(attachment))
    ) {
        return "parent attachment is missing or in the trash";
    }
    const parent = attachment.parentID
        ? await Zotero.Items.getAsync(attachment.parentID)
        : null;
    if (parent && (await isDeleted(parent)))
        return "parent library item is in the trash";

    const id = modelObjectId(item.libraryID, item.key);
    if (seen.has(id)) return "resolves to a duplicate annotation";
    seen.add(id);

    const libraryRef = libraryRefForLibraryID(item.libraryID) ?? undefined;
    const ref = {
        library_id: item.libraryID,
        zotero_key: item.key,
        ...(libraryRef ? { library_ref: libraryRef } : {}),
    };
    return {
        id,
        item,
        attachment,
        annotationType: item.annotationType,
        ref,
        groupIndex,
        before: {
            annotation_id: id,
            ...ref,
            color: item.annotationColor ?? "",
            comment: item.annotationComment ?? "",
            tags: item.getTags().map((tag: { tag: string }) => tag.tag),
            deleted: false,
            // Carried on every snapshot, not just moves: the approval card and
            // the persisted history entry both render from this, and history
            // must not depend on re-reading Zotero at display time.
            annotation_type: item.annotationType,
            page_label: item.annotationPageLabel ?? "",
            ...(item.annotationType === "highlight"
                ? { text: item.annotationText ?? "" }
                : {}),
        },
    };
}

/**
 * Capture the coordinates an annotation currently sits at, so a move can be
 * undone.
 *
 * A move overwrites position in place, which leaves no other record of the
 * original — unlike a color or comment edit, whose previous value the snapshot
 * already carries. Only taken for targets that actually move, so an ordinary
 * metadata edit does not carry position JSON. The human-readable fields
 * (`annotation_type`, `page_label`, `text`) are on every snapshot already,
 * because the approval card renders from them.
 */
function capturePlacement(target: ResolvedTarget): void {
    // Zotero's upstream typing declares annotationSortIndex as a number; it is
    // a formatted string, which ZoteroAnnotationItem corrects.
    const { annotationSortIndex } = target.item as unknown as ZoteroAnnotationItem;
    target.before.sort_index = annotationSortIndex ?? "";
    target.before.position = target.item.annotationPosition ?? "";
}

type Partitioned = {
    targets: ResolvedTarget[];
    skipped: SkippedAnnotation[];
    /** Placement per ResolvedTarget index; undefined when the target stays put. */
    placements: Array<AnnotationPlacement | undefined>;
    /** True when at least one skip came from a destination that did not fit. */
    relocationFailed: boolean;
};

async function awaitWithAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw new Error("relocation preparation timed out");
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("relocation preparation timed out"));
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
    }
}

/**
 * Resolve every target and prepare any move, dropping the ones that cannot be
 * applied rather than failing the whole action.
 *
 * A destination only fails for the group that named it, so one bad move costs
 * that annotation and nothing else. Everything that survives here is exactly
 * what the approval card shows and what execution applies.
 *
 * Preparation deliberately happens here, before any transaction is opened:
 * placing a move can read the attachment and run a PDF page analysis, which
 * must not happen while holding Zotero's global write lock.
 */
async function partitionTargets(
    data: EditAnnotationsProposedData,
    signal?: AbortSignal,
): Promise<Partitioned> {
    const groups: Array<{
        refs: ZoteroItemReference[];
        relocation?: AnnotationRelocation;
    }> =
        data.operation === "delete"
            ? [{ refs: data.annotation_refs ?? [] }]
            : (data.edits ?? []).map((group) => ({
                  refs: group.annotation_refs ?? [],
                  relocation: group.relocation,
              }));

    const targets: ResolvedTarget[] = [];
    const placements: Array<AnnotationPlacement | undefined> = [];
    const skipped: SkippedAnnotation[] = [];
    const seen = new Set<string>();
    let relocationFailed = false;

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const { refs, relocation } = groups[groupIndex];
        for (const refInput of refs) {
            // Skips are reported back to the model, so they must echo the id
            // it supplied rather than the client's internal portable form.
            const label = `${refInput.library_ref ?? refInput.library_id}-${refInput.zotero_key}`;
            const resolved = await resolveTarget(refInput, groupIndex, seen);
            if (typeof resolved === "string") {
                skipped.push({ annotation_id: label, reason: resolved });
                continue;
            }
            if (!relocation) {
                targets.push(resolved);
                placements.push(undefined);
                continue;
            }
            if (
                resolved.annotationType !== "highlight" &&
                resolved.annotationType !== "note"
            ) {
                relocationFailed = true;
                skipped.push({
                    annotation_id: label,
                    reason: `annotations of type '${resolved.annotationType}' cannot be moved`,
                });
                continue;
            }
            try {
                const placement = await awaitWithAbort(
                    prepareRelocation(
                        resolved.attachment,
                        resolved.annotationType as RelocatableAnnotationType,
                        relocation,
                    ),
                    signal,
                );
                targets.push(resolved);
                placements.push(placement);
            } catch (error) {
                relocationFailed = true;
                skipped.push({
                    annotation_id: label,
                    reason: String(
                        error instanceof Error ? error.message : error,
                    ),
                });
            }
        }
    }
    return { targets, skipped, placements, relocationFailed };
}

/** Longest annotation text or comment stored on the proposal for display. */
const MAX_PREVIEW_TEXT = 300;

function clip(value: string | undefined): string {
    const text = value ?? "";
    return text.length > MAX_PREVIEW_TEXT
        ? `${text.slice(0, MAX_PREVIEW_TEXT)}…`
        : text;
}

/**
 * The display half of a snapshot, for storage on the proposal.
 *
 * Text and comments are clipped to what a preview row shows, and the undo
 * fields (position, sort index, move destination) are left out — those belong
 * to the result, which is where undo reads them.
 */
function previewSnapshot(
    before: AnnotationBeforeSnapshot,
): AnnotationPreviewSnapshot {
    return {
        annotation_id: before.annotation_id,
        library_id: before.library_id,
        zotero_key: before.zotero_key,
        ...(before.library_ref ? { library_ref: before.library_ref } : {}),
        ...(before.annotation_type
            ? { annotation_type: before.annotation_type }
            : {}),
        color: before.color,
        comment: clip(before.comment),
        tags: before.tags,
        ...(before.page_label !== undefined
            ? { page_label: before.page_label }
            : {}),
        ...(before.text !== undefined ? { text: clip(before.text) } : {}),
    };
}

/** Rebuild the proposal from the targets that survived validation. */
function survivingData(
    data: EditAnnotationsProposedData,
    partition: Partitioned,
): EditAnnotationsProposedData {
    const combinedSkips = [...(data.skipped ?? []), ...partition.skipped].filter(
        (row, index, all) =>
            all.findIndex(
                (candidate) =>
                    candidate.annotation_id === row.annotation_id &&
                    candidate.reason === row.reason,
            ) === index,
    );
    // Carried on the proposal so a rejected or undone card can still render the
    // annotations by content: result data holds the same state, but is cleared
    // as soon as the action resolves.
    const common = {
        skipped: combinedSkips,
        annotation_previews: partition.targets.map((target) =>
            previewSnapshot(target.before),
        ),
    };
    if (data.operation === "delete") {
        return {
            operation: "delete",
            annotation_refs: partition.targets.map((target) => target.ref),
            ...common,
        };
    }
    const edits: AnnotationEditGroup[] = [];
    (data.edits ?? []).forEach((group, groupIndex) => {
        const refs = partition.targets
            .filter((target) => target.groupIndex === groupIndex)
            .map((target) => target.ref);
        if (!refs.length) return;
        edits.push({ ...group, annotation_refs: refs });
    });
    return { operation: "edit", edits, ...common };
}

/**
 * An edit that overwrites content the user wrote (a comment, or a tag set
 * being replaced wholesale) always goes to the user, whatever their standing
 * preference for annotation edits is. So does any move.
 *
 * Deletion is not handled here: it lives in its own approval group with no
 * persisted preference, so it already resolves to "always ask" on its own.
 */
function requiresApproval(
    data: EditAnnotationsProposedData,
    targets: ResolvedTarget[],
): boolean {
    if (data.operation === "delete") return false;
    // MUST be called with the ORIGINAL proposal: `groupIndex` is assigned
    // against `data.edits` as received, while `survivingData` compacts the
    // list. Passing the compacted form shifts every group after a dropped one
    // and silently resolves `members` to the wrong (empty) set, which can only
    // ever weaken the guard.
    return (data.edits ?? []).some((group, groupIndex) => {
        const members = targets.filter(
            (target) => target.groupIndex === groupIndex,
        );
        // Every target dropped during validation: nothing left to approve.
        if (!members.length) return false;
        if (group.relocation) return true;
        const changes = group.changes;
        if (!changes) return false;
        // Writing a comment onto an annotation that already has one, or
        // wiping out every tag it carried, destroys something the user wrote.
        // Adding a comment where there was none, recoloring, and a targeted
        // tag add/remove that leaves other tags standing are non-destructive.
        if (
            changes.comment != null &&
            members.some((target) => target.before.comment.trim())
        )
            return true;
        // Replacing a tag set is spelled as removing the current tags and
        // adding the new ones, so the destructive case is a removal that
        // leaves none of an annotation's prior tags behind.
        if (
            changes.remove_tags?.length &&
            members.some((target) => {
                if (!target.before.tags.length) return false;
                const next =
                    nextTags(target.before.tags, changes) ?? target.before.tags;
                return !target.before.tags.some((tag) => next.includes(tag));
            })
        )
            return true;
        return false;
    });
}

/**
 * The approval preference this action should run under.
 *
 * Both model-facing tools share one action type, so the operation decides
 * which approval group applies. Deletion has its own group with no
 * Preferences row, which makes "always apply" unreachable for it except
 * through an explicit per-run grant.
 *
 * Only the auto-apply preference is ever overridden. A user who chose
 * "continue without applying" asked not to be interrupted, and that mode never
 * applies anything on its own, so raising a card buys no safety — which is why
 * a delete inherits that choice from the annotations group rather than
 * defaulting to a prompt the user opted out of.
 */
function resolvePreference(
    data: EditAnnotationsProposedData,
    targets: ResolvedTarget[],
): DeferredToolPreference {
    if (data.operation === "delete") {
        const granted = getDeferredToolPreference("delete_annotations");
        // No preference is persisted for the deletion group, so this can only
        // be a per-run grant the user gave for deletions specifically.
        if (granted === "always_apply") return granted;
        const annotations = getDeferredToolPreference(
            "create_highlight_annotations",
        );
        return annotations === "continue_without_applying"
            ? annotations
            : "always_ask";
    }
    const stored = getDeferredToolPreference("edit_annotations");
    return stored === "always_apply" && requiresApproval(data, targets)
        ? "always_ask"
        : stored;
}

function invalidValidation(
    requestId: string,
    error: string,
    errorCode: string,
): WSAgentActionValidateResponse {
    return {
        type: "agent_action_validate_response",
        request_id: requestId,
        valid: false,
        error,
        error_code: errorCode,
        preference: "always_ask",
    };
}

function describeSkips(skipped: SkippedAnnotation[]): string {
    return skipped
        .map((row) => `${row.annotation_id}: ${row.reason}`)
        .join("\n");
}

export async function validateEditAnnotationsAction(
    request: WSAgentActionValidateRequest,
    relocationBudgetMs: number = VALIDATE_RELOCATION_BUDGET_MS,
): Promise<WSAgentActionValidateResponse> {
    const normalized = normalizeData(request.action_data);
    if (!normalized.ok)
        return invalidValidation(
            request.request_id,
            normalized.error,
            normalized.code,
        );

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), relocationBudgetMs);
    let partition: Partitioned;
    try {
        partition = await partitionTargets(normalized.data, deadline.signal);
    } finally {
        clearTimeout(timer);
    }
    if (!partition.targets.length) {
        return invalidValidation(
            request.request_id,
            describeSkips(partition.skipped) ||
                "No annotations could be resolved",
            partition.relocationFailed
                ? "relocation_validation_failed"
                : "annotation_validation_failed",
        );
    }

    const surviving = survivingData(normalized.data, partition);
    const preference = resolvePreference(normalized.data, partition.targets);

    return {
        type: "agent_action_validate_response",
        request_id: request.request_id,
        valid: true,
        current_value: {
            annotations: partition.targets.map((target) => target.before),
        },
        // Skips travel inside normalized_action_data so they are persisted on
        // the action and shown on the approval card, not just logged.
        normalized_action_data: surviving,
        preference,
    };
}

/**
 * Put the in-memory items back the way they were after a rolled-back
 * transaction, so a cached Zotero.Item never outlives the write it was part of
 * carrying values that were never committed.
 */
function restoreSnapshots(targets: ResolvedTarget[]): void {
    for (const target of targets) {
        target.item.annotationColor = target.before.color;
        target.item.annotationComment = target.before.comment;
        target.item.setTags(target.before.tags);
        target.item.deleted = target.before.deleted ?? false;
        // Only a move captures placement, so its presence marks the items
        // whose position was overwritten before the rollback.
        if (target.before.position !== undefined) {
            applyAnnotationPlacement(target.item, {
                ...(target.before.text !== undefined
                    ? { text: target.before.text }
                    : {}),
                pageLabel: target.before.page_label ?? "",
                sortIndex: target.before.sort_index ?? "",
                position: target.before.position,
            });
        }
    }
}

/** The tag set an annotation ends up with after one patch. */
function nextTags(
    before: string[],
    changes: EditAnnotationsPatch | undefined,
): string[] | null {
    if (!changes) return null;
    if (changes.add_tags == null && changes.remove_tags == null) return null;
    const removed = new Set(changes.remove_tags ?? []);
    const kept = before.filter((tag) => !removed.has(tag));
    const added = (changes.add_tags ?? []).filter((tag) => !kept.includes(tag));
    return [...kept, ...added];
}

export async function executeEditAnnotationsAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const normalized = normalizeData(request.action_data);
    if (!normalized.ok)
        return {
            type: "agent_action_execute_response",
            request_id: request.request_id,
            success: false,
            error: normalized.error,
            error_code: normalized.code,
        };

    // Re-resolve rather than trusting the validate pass: the library can
    // change while the approval card is open. Anything that has since become
    // unusable is dropped the same way it would have been at validate time.
    const partition = await partitionTargets(normalized.data, ctx.signal);
    if (!partition.targets.length) {
        return {
            type: "agent_action_execute_response",
            request_id: request.request_id,
            success: false,
            error:
                describeSkips(partition.skipped) ||
                "No annotations could be resolved",
            error_code: "annotation_validation_failed",
        };
    }

    const changesByGroup = new Map<number, EditAnnotationsPatch | undefined>();
    if (normalized.data.operation === "edit") {
        (normalized.data.edits ?? []).forEach((group, index) =>
            changesByGroup.set(index, group.changes),
        );
    }

    const appliedRefs: ZoteroItemReference[] = [];

    try {
        checkAborted(ctx, "edit_annotations:before_transaction");
        await Zotero.DB.executeTransaction(async () => {
            for (let index = 0; index < partition.targets.length; index++) {
                const target = partition.targets[index];
                checkAborted(ctx, `edit_annotations:${target.id}`);

                if (normalized.data.operation === "delete") {
                    target.item.deleted = true;
                    await saveItem(target.item);
                    appliedRefs.push(target.ref);
                    continue;
                }

                const changes = changesByGroup.get(target.groupIndex);
                const placement = partition.placements[index];
                const tags = nextTags(target.before.tags, changes);

                if (changes?.color != null)
                    target.item.annotationColor =
                        ZOTERO_ANNOTATION_PALETTE_COLORS[changes.color];
                if (changes?.comment != null)
                    target.item.annotationComment = changes.comment;
                if (tags != null) target.item.setTags(tags);
                if (placement) {
                    // Moving rewrites the annotation's position on the item
                    // itself, so its key, author, tags, and any citation
                    // pointing at it all survive the move. Record both ends —
                    // nothing else records where it was, and undo needs the
                    // destination to tell its own write apart from a later
                    // manual drag.
                    capturePlacement(target);
                    target.before.moved_to = {
                        ...(placement.text !== undefined
                            ? { text: placement.text }
                            : {}),
                        page_label: placement.pageLabel,
                        sort_index: placement.sortIndex,
                        position: placement.position,
                    };
                    applyAnnotationPlacement(target.item, placement);
                }
                await saveItem(target.item);
                appliedRefs.push(target.ref);
            }
        });
        if (normalized.data.operation === "delete") {
            // Only after the transaction commits: an open reader keeps showing
            // trashed annotations otherwise.
            unsetTrashedAnnotationsInOpenReaders(
                partition.targets.map((target) => ({
                    attachmentID: target.attachment.id,
                    key: target.item.key,
                })),
            );
        }
        return {
            type: "agent_action_execute_response",
            request_id: request.request_id,
            success: true,
            result_data: {
                operation: normalized.data.operation,
                applied_refs: appliedRefs,
                before: partition.targets.map((target) => target.before),
            },
        };
    } catch (error) {
        restoreSnapshots(partition.targets);
        if (error instanceof TimeoutError) throw error;
        logger(
            `executeEditAnnotationsAction: transaction rolled back: ${error}`,
            1,
        );
        return {
            type: "agent_action_execute_response",
            request_id: request.request_id,
            success: false,
            error: String(error),
            error_code: "transaction_failed",
        };
    }
}
