import type {
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
} from "@beaver/agent-core/protocol/agentProtocol";
import type {
    AnnotationBeforeSnapshot,
    AnnotationEditGroup,
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
import { checkLibraryExcluded, getDeferredToolPreference } from "../utils";
import { checkAborted, TimeoutContext, TimeoutError } from "../timeout";
import {
    resolveAnnotationRelocation,
    type RelocatableAnnotationType,
    type ResolvedRelocationTarget,
} from "./annotationRelocation";

const MAX_ANNOTATIONS = 50;
// Total budget for resolving every target during validation. Individual
// document extractions carry their own timeouts, but a batch of relocations
// across distinct attachments would otherwise add up without bound.
const VALIDATE_RESOLUTION_BUDGET_MS = 60_000;
const MAX_EDIT_GROUPS = 25;
const ALLOWED_KEYS = new Set([
    "operation",
    "edits",
    "annotation_refs",
    "skipped",
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

    let relocation: { locator: string } | undefined;
    if (value.relocation !== undefined && value.relocation !== null) {
        if (typeof value.relocation !== "object" || Array.isArray(value.relocation))
            return fail("relocation must be an object", "invalid_relocation");
        const unexpectedRelocation = Object.keys(value.relocation).filter(
            (key) => key !== "locator",
        );
        if (unexpectedRelocation.length)
            return fail(
                `Unsupported relocation field(s): ${unexpectedRelocation.join(", ")}`,
                "field_restricted",
            );
        const locator =
            typeof value.relocation.locator === "string"
                ? value.relocation.locator.trim()
                : "";
        if (!locator)
            return fail("relocation.locator is required", "invalid_locator");
        // Relocation recreates the annotation at the locator, so one locator
        // can only stand for one annotation.
        if (refs.length !== 1)
            return fail(
                "a relocating edit targets exactly one annotation",
                "invalid_relocation",
            );
        relocation = { locator };
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

    if (operation === "delete") {
        if (value.edits !== undefined)
            return fail("delete does not accept edits", "field_restricted");
        const refs = normalizeRefs(value.annotation_refs);
        if (!Array.isArray(refs)) return refs;
        return { ok: true, data: { operation, annotation_refs: refs } };
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

    return { ok: true, data: { operation: "edit", edits: groups } };
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
        },
    };
}

type Partitioned = {
    targets: ResolvedTarget[];
    skipped: SkippedAnnotation[];
    /** Relocation target per ResolvedTarget index; undefined when it stays put. */
    relocations: Array<ResolvedRelocationTarget | undefined>;
    /** True when at least one skip came from an unusable locator. */
    locatorFailed: boolean;
    /** True when at least one skip came from running out of time, not a bad input. */
    timedOut: boolean;
};

/**
 * Resolve every target and its relocation, dropping the ones that cannot be
 * applied rather than failing the whole action.
 *
 * A locator only fails for the group that supplied it, so one bad locator
 * costs that annotation and nothing else. Everything that survives here is
 * exactly what the approval card shows and what execution applies.
 */
async function partitionTargets(
    data: EditAnnotationsProposedData,
    signal?: AbortSignal,
): Promise<Partitioned> {
    const groups: Array<{ refs: ZoteroItemReference[]; locator?: string }> =
        data.operation === "delete"
            ? [{ refs: data.annotation_refs ?? [] }]
            : (data.edits ?? []).map((group) => ({
                  refs: group.annotation_refs ?? [],
                  locator: group.relocation?.locator,
              }));

    const targets: ResolvedTarget[] = [];
    const relocations: Array<ResolvedRelocationTarget | undefined> = [];
    const skipped: SkippedAnnotation[] = [];
    const seen = new Set<string>();
    let locatorFailed = false;
    let timedOut = false;

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const { refs, locator } = groups[groupIndex];
        for (const refInput of refs) {
            // Skips are reported back to the model, so they must echo the id
            // it supplied rather than the client's internal portable form.
            const label = `${refInput.library_ref ?? refInput.library_id}-${refInput.zotero_key}`;
            const resolved = await resolveTarget(refInput, groupIndex, seen);
            if (typeof resolved === "string") {
                skipped.push({ annotation_id: label, reason: resolved });
                continue;
            }
            if (!locator) {
                targets.push(resolved);
                relocations.push(undefined);
                continue;
            }
            if (
                resolved.annotationType !== "highlight" &&
                resolved.annotationType !== "note"
            ) {
                locatorFailed = true;
                skipped.push({
                    annotation_id: label,
                    reason: `annotations of type '${resolved.annotationType}' cannot be moved`,
                });
                continue;
            }
            try {
                const relocation = await resolveAnnotationRelocation(
                    resolved.attachment,
                    resolved.annotationType as RelocatableAnnotationType,
                    locator,
                    signal,
                );
                targets.push(resolved);
                relocations.push(relocation);
            } catch (error) {
                // An aborted resolution means we ran out of time, not that the
                // model gave a bad locator. Reporting it as a locator failure
                // would send the model back to "copy an exact locator" advice
                // for a locator that was already correct.
                if (signal?.aborted) {
                    timedOut = true;
                    skipped.push({
                        annotation_id: label,
                        reason:
                            "could not be prepared in time; move fewer annotations per call",
                    });
                    continue;
                }
                locatorFailed = true;
                skipped.push({
                    annotation_id: label,
                    reason: String(
                        error instanceof Error ? error.message : error,
                    ),
                });
            }
        }
    }
    return { targets, skipped, relocations, locatorFailed, timedOut };
}

/** Rebuild the proposal from the targets that survived validation. */
function survivingData(
    data: EditAnnotationsProposedData,
    partition: Partitioned,
): EditAnnotationsProposedData {
    const skipped = partition.skipped.length
        ? { skipped: partition.skipped }
        : { skipped: [] };
    if (data.operation === "delete") {
        return {
            operation: "delete",
            annotation_refs: partition.targets.map((target) => target.ref),
            ...skipped,
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
    return { operation: "edit", edits, ...skipped };
}

/**
 * An edit that overwrites content the user wrote (a comment, or a tag set
 * being replaced wholesale) always goes to the user, whatever their
 * standing preference for annotation edits is. So does any move.
 */
function requiresApproval(
    data: EditAnnotationsProposedData,
    targets: ResolvedTarget[],
): boolean {
    if (data.operation === "delete") return true;
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
    // Overridable so tests can exercise the deadline without waiting it out.
    resolutionBudgetMs: number = VALIDATE_RESOLUTION_BUDGET_MS,
): Promise<WSAgentActionValidateResponse> {
    const normalized = normalizeData(request.action_data);
    if (!normalized.ok)
        return invalidValidation(
            request.request_id,
            normalized.error,
            normalized.code,
        );

    // Validation resolves every relocation target, and each one can extract a
    // document (25s apiece for a PDF, unbounded for EPUB/snapshot). With
    // relocations spread across distinct attachments that is otherwise an
    // unbounded, uncancellable wait, and nothing upstream imposes a deadline.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), resolutionBudgetMs);
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
            partition.timedOut
                ? "resolution_timed_out"
                : partition.locatorFailed
                  ? "relocation_validation_failed"
                  : "annotation_validation_failed",
        );
    }

    const surviving = survivingData(normalized.data, partition);
    // F5: only the auto-apply preference is overridden. A user who chose
    // "continue without applying" asked not to be interrupted, and that mode
    // never applies anything on its own, so forcing a card buys no safety.
    const stored = getDeferredToolPreference("edit_annotations");
    const preference =
        stored === "always_apply" &&
        requiresApproval(normalized.data, partition.targets)
            ? "always_ask"
            : stored;

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

function restoreSnapshots(targets: ResolvedTarget[]): void {
    for (const target of targets) {
        target.item.annotationColor = target.before.color;
        target.item.annotationComment = target.before.comment;
        target.item.setTags(target.before.tags);
        target.item.deleted = target.before.deleted ?? false;
    }
}

function paletteName(hex: string): string {
    return (
        Object.entries(ZOTERO_ANNOTATION_PALETTE_COLORS).find(
            ([, value]) => value === hex,
        )?.[0] ?? "yellow"
    );
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
            error_code: partition.timedOut
                ? "resolution_timed_out"
                : "annotation_validation_failed",
        };
    }

    const changesByGroup = new Map<number, EditAnnotationsPatch | undefined>();
    if (normalized.data.operation === "edit") {
        (normalized.data.edits ?? []).forEach((group, index) =>
            changesByGroup.set(index, group.changes),
        );
    }

    const mappings: Array<{
        old_ref: ZoteroItemReference;
        new_ref: ZoteroItemReference;
    }> = [];
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
                const relocation = partition.relocations[index];
                const tags = nextTags(target.before.tags, changes);
                const color =
                    changes?.color != null
                        ? ZOTERO_ANNOTATION_PALETTE_COLORS[changes.color]
                        : target.before.color;
                const comment =
                    changes?.comment != null
                        ? changes.comment
                        : target.before.comment;

                if (!relocation) {
                    if (changes?.color != null)
                        target.item.annotationColor = color;
                    if (changes?.comment != null)
                        target.item.annotationComment = comment;
                    if (tags != null) target.item.setTags(tags);
                    await saveItem(target.item);
                    appliedRefs.push(target.ref);
                    continue;
                }

                // Relocation recreates the annotation at the new position and
                // carries its metadata (patched, if this edit also changes
                // fields) across; the original is retired only once the
                // replacement is persisted.
                const newRef = await relocation.create({
                    color: paletteName(color),
                    comment,
                    tags: tags ?? target.before.tags,
                });
                const replacement = await resolveItemReference(newRef);
                if (
                    replacement.status !== "found" ||
                    !replacement.item.isAnnotation()
                ) {
                    throw new Error(
                        `Created replacement for ${target.id} could not be resolved`,
                    );
                }
                // The shared writers accept named palette colors. Restore the
                // exact hex as well, so a pre-existing custom Zotero color is
                // copied rather than coerced to yellow.
                replacement.item.annotationColor = color;
                replacement.item.annotationComment = comment;
                replacement.item.setTags(tags ?? target.before.tags);
                await saveItem(replacement.item);
                target.item.deleted = true;
                await saveItem(target.item);
                mappings.push({ old_ref: target.ref, new_ref: newRef });
                appliedRefs.push(newRef);
            }
        });
        return {
            type: "agent_action_execute_response",
            request_id: request.request_id,
            success: true,
            result_data: {
                operation: normalized.data.operation,
                applied_refs: appliedRefs,
                before: partition.targets.map((target) => target.before),
                ...(mappings.length ? { relocated: mappings } : {}),
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
