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
import { editAnnotationsTargets } from "@beaver/agent-core/types/agentActions/editAnnotations";
import type { ZoteroItemReference } from "@beaver/agent-core/types/zotero";
import { logger } from "@beaver/agent-core/platform/logger";
import { ZOTERO_ANNOTATION_PALETTE_COLORS } from "../../../constants/annotations";
import {
    libraryRefForLibraryID,
    modelObjectId,
    resolveItemReference,
    resolveLibraryRef,
} from "../../../utils/libraryIdentity";
import {
    applyAnnotationPlacement,
    type AnnotationPlacement,
} from "../../annotations/createAnnotation";
import {
    refreshMovedAnnotationsInOpenReaders,
    unsetTrashedAnnotationsInOpenReaders,
} from "../../annotations/readerSync";
import { checkLibraryExcluded, getDeferredToolPreference, hasFullAccessForCurrentRun } from "../utils";
import { checkAborted, TimeoutContext, TimeoutError } from "../timeout";
import {
    prepareRelocation,
    type RelocatableAnnotationType,
} from "./annotationPlacement";

/** Skip reason for an annotation that sits in the trash. */
const TRASHED_REASON = "annotation is in the trash";

const MAX_ANNOTATIONS = 50;
const MAX_EDIT_GROUPS = 25;
const VALIDATE_RELOCATION_BUDGET_MS = 60_000;
const ALLOWED_KEYS = new Set([
    "operation",
    "edits",
    "annotation_refs",
    "skipped",
    // Written by validation and persisted on the proposal, which is replayed
    // verbatim on execute and on re-apply.
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

/** A tag in the shape `setTags()` accepts; type 0 is a manual tag. */
type ItemTag = { tag: string; type: number };

/** Zotero's automatic-tag type; everything else is a manual tag. */
const AUTOMATIC_TAG_TYPE = 1;

type ResolvedTarget = {
    id: string;
    item: Zotero.Item;
    attachment: Zotero.Item;
    annotationType: string;
    ref: ZoteroItemReference;
    before: AnnotationBeforeSnapshot;
    /**
     * The annotation's tags with their types, for writing back. `before.tags`
     * is names only (it is display data), and writing names back would file
     * every automatic tag as a manual one.
     */
    beforeTags: ItemTag[];
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
    if (
        !value.page_locations?.length &&
        !value.note_position &&
        !value.anchor_id &&
        !value.text
    ) {
        return fail("relocation carries no destination", "invalid_relocation");
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

/**
 * The snapshots validation stored on the proposal, carried through so
 * execution can compare what it is about to overwrite against what validation
 * saw. Read defensively — this is replayed action data, and a row that lost a
 * field reads as "had nothing there", which can only make the comparison more
 * cautious.
 */
function normalizePreviews(
    value: unknown,
): AnnotationPreviewSnapshot[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const rows: AnnotationPreviewSnapshot[] = [];
    for (const row of value) {
        if (!row || typeof row !== "object") continue;
        if (typeof row.annotation_id !== "string") continue;
        rows.push({
            ...row,
            comment: typeof row.comment === "string" ? row.comment : "",
            tags: Array.isArray(row.tags)
                ? row.tags.filter((tag: unknown) => typeof tag === "string")
                : [],
        });
    }
    return rows.length ? rows : undefined;
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
    const previews = normalizePreviews(value.annotation_previews);
    const carried = previews ? { annotation_previews: previews } : {};

    if (operation === "delete") {
        if (value.edits !== undefined)
            return fail("delete does not accept edits", "field_restricted");
        const refs = normalizeRefs(value.annotation_refs);
        if (!Array.isArray(refs)) return refs;
        return {
            ok: true,
            data: { operation, annotation_refs: refs, skipped, ...carried },
        };
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

    return {
        ok: true,
        data: { operation: "edit", edits: groups, skipped, ...carried },
    };
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

function readItemTags(item: Zotero.Item): ItemTag[] {
    return item
        .getTags()
        .map((tag: { tag: string; type?: number }) => ({
            tag: tag.tag,
            type: tag.type ?? 0,
        }));
}

function automaticTagNames(tags: ItemTag[]): string[] {
    return tags
        .filter((tag) => tag.type === AUTOMATIC_TAG_TYPE)
        .map((tag) => tag.tag);
}

async function isDeleted(item: any): Promise<boolean> {
    if (item.deleted) return true;
    return !!(await Zotero.DB.valueQueryAsync(
        "SELECT 1 FROM deletedItems WHERE itemID = ? LIMIT 1",
        [item.id],
    ));
}

/**
 * The exclusion message for the first target in a library the user excluded
 * from Beaver, or null when the whole batch is allowed.
 *
 * Runs before anything is resolved or written: an excluded library is an
 * access boundary, so a batch that names one is rejected outright rather than
 * partially applied with that target dropped as an ordinary skip.
 */
function excludedTargetMessage(
    data: EditAnnotationsProposedData,
): string | null {
    for (const ref of editAnnotationsTargets(data)) {
        const libraryId = resolveLibraryRef(ref);
        if (libraryId == null) continue; // not on this device; skipped later
        const excluded = checkLibraryExcluded(libraryId);
        if (excluded) return excluded.message;
    }
    return null;
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
    if (await isDeleted(item)) return TRASHED_REASON;

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
    const beforeTags = readItemTags(item);
    const automaticTags = automaticTagNames(beforeTags);
    return {
        id,
        item,
        attachment,
        annotationType: item.annotationType,
        ref,
        beforeTags,
        groupIndex,
        before: {
            annotation_id: id,
            ...ref,
            color: item.annotationColor ?? "",
            comment: item.annotationComment ?? "",
            tags: beforeTags.map((tag) => tag.tag),
            // Undo restores the tag set from the snapshot, so the types have to
            // travel with it; the names alone would file them all as manual.
            ...(automaticTags.length ? { automatic_tags: automaticTags } : {}),
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
    const { annotationSortIndex } =
        target.item as unknown as ZoteroAnnotationItem;
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

/**
 * Skips already on the proposal plus the ones this pass found, deduplicated.
 * Execution re-resolves the batch, so it can drop targets validation accepted.
 */
function mergeSkips(
    existing: SkippedAnnotation[] | undefined,
    found: SkippedAnnotation[],
): SkippedAnnotation[] {
    return [...(existing ?? []), ...found].filter(
        (row, index, all) =>
            all.findIndex(
                (candidate) =>
                    candidate.annotation_id === row.annotation_id &&
                    candidate.reason === row.reason,
            ) === index,
    );
}

/** Rebuild the proposal from the targets that survived validation. */
function survivingData(
    data: EditAnnotationsProposedData,
    partition: Partitioned,
): EditAnnotationsProposedData {
    // Carried on the proposal so a rejected or undone card can still render the
    // annotations by content: result data holds the same state, but is cleared
    // as soon as the action resolves.
    const common = {
        skipped: mergeSkips(data.skipped, partition.skipped),
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
 * The per-annotation state the approval guard reads: what the edit would
 * overwrite, and which group's patch would overwrite it.
 */
type ApprovalState = {
    annotationId: string;
    groupIndex: number;
    comment: string;
    tags: string[];
};

/** What the guard sees for targets resolved from the library right now. */
function currentStates(targets: ResolvedTarget[]): ApprovalState[] {
    return targets.map((target) => ({
        annotationId: target.id,
        groupIndex: target.groupIndex,
        comment: target.before.comment,
        tags: target.before.tags,
    }));
}

/**
 * The same states as validation saw, rebuilt from the snapshots it stored on
 * the proposal.
 *
 * Only annotations validation actually resolved have a snapshot; anything
 * without one keeps its current state, which reports no drift for it. The
 * stored comment is clipped for display, so it may only be tested for
 * emptiness — which is all the guard asks of it.
 */
function validatedStates(
    data: EditAnnotationsProposedData,
    targets: ResolvedTarget[],
): ApprovalState[] | null {
    const previews = new Map(
        (data.annotation_previews ?? []).map((row) => [row.annotation_id, row]),
    );
    if (!previews.size) return null;
    return currentStates(targets).map((state) => {
        const preview = previews.get(state.annotationId);
        if (!preview) return state;
        return { ...state, comment: preview.comment, tags: preview.tags };
    });
}

/** Wiping out every tag an annotation carried, as opposed to trimming some. */
function removesEveryTag(
    state: ApprovalState,
    changes: EditAnnotationsPatch,
): boolean {
    if (!state.tags.length) return false;
    const before = state.tags.map((tag) => ({ tag, type: 0 }));
    const next = nextTags(before, changes) ?? before;
    const names = new Set(next.map((tag) => tag.tag));
    return !state.tags.some((tag) => names.has(tag));
}

/**
 * Everything about this edit that would overwrite content the user wrote — a
 * comment, or a tag set being replaced wholesale — plus every move.
 *
 * Keyed by group, annotation, and field rather than reported as one flag, so
 * that comparing two runs of this tells which annotation turned destructive.
 * A coarser key hides one target behind another: a group that already had to
 * be approved for annotation A would otherwise absorb a comment B gained since.
 *
 * Deletion is not handled here: it lives in its own approval group with no
 * persisted preference, so it already resolves to "always ask" on its own.
 */
function destructiveEdits(
    data: EditAnnotationsProposedData,
    states: ApprovalState[],
): Set<string> {
    const destructive = new Set<string>();
    if (data.operation === "delete") return destructive;
    // MUST be called with the proposal whose `edits` the states' `groupIndex`
    // was assigned against: `survivingData` compacts the list, so mixing the
    // original proposal with states resolved from the compacted one shifts
    // every group after a dropped one and silently resolves `members` to the
    // wrong (empty) set, which can only ever weaken the guard.
    (data.edits ?? []).forEach((group, groupIndex) => {
        const changes = group.changes;
        // A group whose targets were all dropped contributes nothing.
        for (const state of states) {
            if (state.groupIndex !== groupIndex) continue;
            const key = (field: string) =>
                `${groupIndex}:${state.annotationId}:${field}`;
            if (group.relocation) destructive.add(key("position"));
            if (!changes) continue;
            // Writing a comment onto an annotation that already has one, or
            // wiping out every tag it carried, destroys something the user
            // wrote. Adding a comment where there was none, recoloring, and a
            // targeted tag add/remove that leaves other tags standing are
            // non-destructive.
            if (changes.comment != null && state.comment.trim())
                destructive.add(key("comment"));
            // Replacing a tag set is spelled as removing the current tags and
            // adding the new ones, so the destructive case is a removal that
            // leaves none of an annotation's prior tags behind.
            if (changes.remove_tags?.length && removesEveryTag(state, changes))
                destructive.add(key("tags"));
        }
    });
    return destructive;
}

/**
 * A destructive edit always goes to the user, whatever their standing
 * preference for annotation edits is.
 */
function requiresApproval(
    data: EditAnnotationsProposedData,
    states: ApprovalState[],
): boolean {
    return destructiveEdits(data, states).size > 0;
}

/**
 * True when this edit would now destroy something on an annotation that it
 * would not have destroyed at validation time.
 *
 * A move is state-independent, so it keys the same on both sides and never
 * counts as drift on its own — it only ever came with an approval card.
 */
function turnedDestructive(
    data: EditAnnotationsProposedData,
    targets: ResolvedTarget[],
): boolean {
    const validated = validatedStates(data, targets);
    if (!validated) return false;
    const before = destructiveEdits(data, validated);
    return [...destructiveEdits(data, currentStates(targets))].some(
        (key) => !before.has(key),
    );
}

/**
 * The approval preference this action should run under.
 *
 * Both model-facing tools share one action type, so the operation decides
 * which approval group applies. Deletion has its own group with no editable
 * Preferences row, which keeps "always apply" out of the normal UI except for
 * an explicit per-run grant. Manually configured underlying preferences remain
 * supported.
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
    // The run's "Full access" grant sits above all of it: the user asked for
    // every library change in this response to apply on its own, so an edit
    // that would otherwise escalate back to a prompt is not raised again.
    if (hasFullAccessForCurrentRun()) return "always_apply";
    if (data.operation === "delete") {
        const deletionPreference = getDeferredToolPreference(
            "delete_annotations",
        );
        // This is normally a per-run grant. Keep honoring an advanced manual
        // configuration too, even though the UI does not expose one.
        if (deletionPreference === "always_apply") return deletionPreference;
        const annotations = getDeferredToolPreference(
            "create_highlight_annotations",
        );
        return annotations === "continue_without_applying"
            ? annotations
            : "always_ask";
    }
    const stored = getDeferredToolPreference("edit_annotations");
    return stored === "always_apply" &&
        requiresApproval(data, currentStates(targets))
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

    const excluded = excludedTargetMessage(normalized.data);
    if (excluded)
        return invalidValidation(
            request.request_id,
            excluded,
            "library_not_searchable",
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
        target.item.setTags(target.beforeTags);
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

/** Raised inside the transaction to roll it back before anything is written. */
class AnnotationStateChangedError extends Error {}

/** Raised inside the transaction when every target was trashed since it resolved. */
class AllTargetsTrashedError extends Error {}

/**
 * Drop edit targets that were trashed after they resolved.
 *
 * `resolveTarget` rejects an annotation that is already in the trash, and
 * `refreshBeforeState` re-reads that state inside the transaction. Without this
 * an annotation the user trashed while the batch was being prepared would still
 * be edited and saved, reporting a successful edit the user cannot see. Deletes
 * are left alone: trashing one that is already trashed is a no-op, and the
 * refreshed `deleted: true` snapshot already keeps undo from pulling it back
 * out of the trash.
 *
 * Mutates the partition so everything downstream — the approval re-check, the
 * writes, the result snapshots, and the rollback restore — sees only the
 * targets that are actually written.
 */
function dropTrashedTargets(partition: Partitioned): SkippedAnnotation[] {
    const trashed: SkippedAnnotation[] = [];
    const targets: ResolvedTarget[] = [];
    const placements: Array<AnnotationPlacement | undefined> = [];
    partition.targets.forEach((target, index) => {
        if (target.before.deleted) {
            trashed.push({
                annotation_id: target.id,
                reason: TRASHED_REASON,
            });
            return;
        }
        targets.push(target);
        placements.push(partition.placements[index]);
    });
    partition.targets = targets;
    partition.placements = placements;
    return trashed;
}

/**
 * Re-read the state a target's write will overwrite.
 *
 * `resolveTarget` snapshots each annotation as it resolves it, and preparing
 * the batch's moves can take seconds after that — long enough for the user or
 * sync to change an annotation resolved early on. Run inside the transaction,
 * where no other write can interleave, so what this captures is what the batch
 * actually overwrites: the undo record and the re-checked approval guard both
 * read it.
 *
 * The trash state is re-read too: `resolveTarget` rejects an annotation that is
 * already trashed, so a stale `false` would let a delete record an annotation
 * the user trashed themselves as one this action deleted — and undo would then
 * pull it back out of the trash.
 *
 * Placement is left alone — only a move overwrites it, and `capturePlacement`
 * already records it in the same transaction.
 */
async function refreshBeforeState(target: ResolvedTarget): Promise<void> {
    const item = target.item;
    target.before.deleted = await isDeleted(item);
    target.beforeTags = readItemTags(item);
    const automatic = automaticTagNames(target.beforeTags);
    target.before.color = item.annotationColor ?? "";
    target.before.comment = item.annotationComment ?? "";
    target.before.tags = target.beforeTags.map((tag) => tag.tag);
    if (automatic.length) target.before.automatic_tags = automatic;
    else delete target.before.automatic_tags;
    target.before.page_label = item.annotationPageLabel ?? "";
    if (target.annotationType === "highlight")
        target.before.text = item.annotationText ?? "";
}

/**
 * The tag set an annotation ends up with after one patch.
 *
 * Retained tags are carried through unchanged, types included: a patch that
 * names other tags must not silently re-file an annotation's automatic tags as
 * manual ones. Newly added tags are manual, which is what `addTag()` defaults
 * to.
 */
function nextTags(
    before: ItemTag[],
    changes: EditAnnotationsPatch | undefined,
): ItemTag[] | null {
    if (!changes) return null;
    if (changes.add_tags == null && changes.remove_tags == null) return null;
    const removed = new Set(changes.remove_tags ?? []);
    const kept = before.filter((tag) => !removed.has(tag.tag));
    const keptNames = new Set(kept.map((tag) => tag.tag));
    const added = (changes.add_tags ?? [])
        .filter((tag) => !keptNames.has(tag))
        .map((tag) => ({ tag, type: 0 }));
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

    // Re-checked here, not just at validation: a library can be excluded while
    // the approval card is open.
    const excluded = excludedTargetMessage(normalized.data);
    if (excluded)
        return {
            type: "agent_action_execute_response",
            request_id: request.request_id,
            success: false,
            error: excluded,
            error_code: "library_not_searchable",
        };

    // Re-resolve rather than trusting the validate pass: the library can
    // change while the approval card is open. Anything that has since become
    // unusable is dropped the same way it would have been at validate time.
    const partition = await partitionTargets(normalized.data, ctx.signal);
    // A deadline that fired during preparation turns every pending move into a
    // skip, which would otherwise be reported as a resolution failure and lose
    // the timeout diagnostics the caller relies on.
    checkAborted(ctx, "edit_annotations:after_partition");
    const skipped = mergeSkips(normalized.data.skipped, partition.skipped);
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
    let trashedSkips: SkippedAnnotation[] = [];

    try {
        checkAborted(ctx, "edit_annotations:before_transaction");
        await Zotero.DB.executeTransaction(async () => {
            // Re-snapshot everything before writing anything: resolving the
            // batch and preparing its moves can take seconds, and the state
            // captured back then may no longer be what these writes overwrite.
            for (const target of partition.targets)
                await refreshBeforeState(target);

            if (normalized.data.operation !== "delete") {
                trashedSkips = dropTrashedTargets(partition);
                if (!partition.targets.length)
                    throw new AllTargetsTrashedError();
            }

            // The approval guard runs at validation, and an edit found
            // non-destructive there can reach this point auto-applied, with no
            // card ever shown. Re-check it against what the write would
            // actually overwrite. This is a comparison, not a re-run: an edit
            // that was already destructive when the user saw it stays
            // approved. Inside the transaction, so nothing can slip in between
            // the check and the writes.
            if (turnedDestructive(normalized.data, partition.targets))
                throw new AnnotationStateChangedError();

            for (let index = 0; index < partition.targets.length; index++) {
                const target = partition.targets[index];
                checkAborted(ctx, `edit_annotations:${target.id}`);

                if (normalized.data.operation === "delete") {
                    target.item.deleted = true;
                    // save(), not saveTx(): every write joins the transaction
                    // opened above. saveTx() opens its own, which nested inside
                    // an open one waits for a transaction that cannot finish
                    // until this call returns and times out after 30s, rolling
                    // the whole batch back.
                    await target.item.save();
                    appliedRefs.push(target.ref);
                    continue;
                }

                const changes = changesByGroup.get(target.groupIndex);
                const placement = partition.placements[index];
                const tags = nextTags(target.beforeTags, changes);

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
                await target.item.save();
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
        } else {
            await refreshMovedAnnotationsInOpenReaders(
                partition.targets.flatMap((target, index) =>
                    partition.placements[index]
                        ? [
                              {
                                  attachmentID: target.attachment.id,
                                  item: target.item,
                              },
                          ]
                        : [],
                ),
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
                // Re-resolution can drop a target the approval card still
                // listed, so the result carries the full skip list rather than
                // letting a partial batch read as an unqualified success.
                ...(skipped.length || trashedSkips.length
                    ? { skipped: mergeSkips(skipped, trashedSkips) }
                    : {}),
            },
        };
    } catch (error) {
        if (error instanceof AllTargetsTrashedError) {
            // Thrown before the first write, so there is nothing to roll back.
            return {
                type: "agent_action_execute_response",
                request_id: request.request_id,
                success: false,
                error:
                    describeSkips(mergeSkips(skipped, trashedSkips)) ||
                    "No annotations could be resolved",
                error_code: "annotation_validation_failed",
            };
        }
        if (error instanceof AnnotationStateChangedError) {
            // Thrown before the first write, so there is nothing to roll back
            // in memory and the snapshots describe the annotations as they
            // stand.
            return {
                type: "agent_action_execute_response",
                request_id: request.request_id,
                success: false,
                error:
                    "These annotations changed since the edit was proposed and " +
                    "it would now overwrite content the user wrote. Read them " +
                    "again and propose the edit against their current state.",
                error_code: "annotation_state_changed",
            };
        }
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
