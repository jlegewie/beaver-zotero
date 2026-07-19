import { logger } from '../../../utils/logger';
import {
    libraryRefForLibraryID,
    modelObjectIdFromReference,
    resolveItemReference,
    resolveLibraryRef,
} from '../../../utils/libraryIdentity';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import type {
    EditNoteBatchProposedData,
    EditNoteBatchEditItem,
    EditNoteBatchUndoRecord,
    EditNoteBatchAppliedEdit,
} from '../../../../react/types/agentActions/editNoteBatch';
import type { EditNoteOperation } from '../../../../react/types/agentActions/editNote';
import {
    getOrSimplify,
    invalidateSimplificationCache,
    normalizeNoteHtml,
    type SimplificationMetadata,
} from '../../../utils/noteHtmlSimplifier';
import {
    checkDuplicateCitations,
    validateNewString,
    checkNewCitationItemsExist,
    applyOldStringEnrichment,
} from '../../../utils/editNoteValidation';
import {
    expandToRawHtml,
    preloadPageLabelsForNewCitations,
    preloadNotePageLabels,
    preloadStructuralLocatorPages,
    buildUnresolvedLocatorWarning,
    type ExternalRefContext,
    type ResolvedLocatorPages,
} from '../../../utils/noteCitationExpand';
import type { PageLabelsByAttachmentId } from '../../../../react/atoms/citations';
import {
    getLatestNoteHtml,
    waitForNoteSaveStabilization,
    flushLiveEditorToDB,
} from '../../../utils/noteEditorIO';
import {
    stripDataCitationItems,
    extractDataCitationItems,
    rebuildDataCitationItems,
    hasSchemaVersionWrapper,
} from '../../../utils/noteWrapper';
import { clearNoteEditorSelection } from '../../../../react/utils/sourceUtils';
import { store } from '../../../../react/store';
import { currentThreadIdAtom } from '../../../../react/atoms/threads';
import { addOrUpdateEditFooter, getBeaverFooterAppendPoint } from '../../../utils/noteEditFooter';
import { assertNoPreviewMarkers, containsPreviewMarkers, stripPreviewMarkers } from '../../../utils/notePreviewGuard';
import { dismissDiffPreview, isDiffPreviewActive, isDiffPreviewPendingFor } from '../../../../react/utils/noteEditorDiffPreview';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
    type EditValidationError,
    type ErrorCandidate,
} from '../../agentProtocol';
import { checkLibraryExcluded, excludedLibraryMessage, getDeferredToolPreference } from '../utils';
import { TimeoutContext, checkAborted, TimeoutError } from '../timeout';
import {
    getExternalRefContext,
    buildMarkdownRenderFields,
} from './editNote';
import {
    resolveBatchEdits,
    detectOverlaps,
    applyResolvedEdits,
    captureUndoContexts,
    type BatchEditSpec,
    type BatchEditFailure,
    type ResolveBatchContext,
    type ResolvedBatchEdit,
    type BatchUndoDraft,
} from '../../../utils/editNoteBatchCore';

// =============================================================================
// Shared helpers
// =============================================================================

function validateError(
    requestId: string,
    error: string,
    error_code: string,
): WSAgentActionValidateResponse {
    return {
        type: 'agent_action_validate_response',
        request_id: requestId,
        valid: false,
        error,
        error_code,
        preference: 'always_ask',
    };
}

function executeError(
    requestId: string,
    error: string,
    error_code: string,
    candidates?: ErrorCandidate[],
): WSAgentActionExecuteResponse {
    return {
        type: 'agent_action_execute_response',
        request_id: requestId,
        success: false,
        error,
        error_code,
        ...(candidates && candidates.length > 0 ? { error_candidates: candidates } : {}),
    };
}

/** Default operation, mirroring the single-edit handler. */
function opOf(edit: EditNoteBatchEditItem): EditNoteOperation {
    return edit.operation ?? 'str_replace';
}

/**
 * Per-edit no-op guard. Insert operations preserve old_string and append/rewrite
 * ignore it, so the identical-strings check applies only to str_replace family.
 */
function checkNoOp(
    operation: EditNoteOperation,
    oldString: string | undefined,
    newString: string,
): { error: string; errorCode: string } | null {
    if (operation === 'rewrite') return null;
    if (operation === 'append' || operation === 'insert_after' || operation === 'insert_before') {
        if (!newString || (operation === 'append' && newString.trim() === '') || newString === '') {
            return { error: 'new_string must not be empty.', errorCode: 'no_changes' };
        }
        return null;
    }
    if (oldString === newString) {
        return { error: 'old_string and new_string are identical.', errorCode: 'no_changes' };
    }
    return null;
}

/**
 * Run the three new_string pre-checks (tag validity, citation existence, dry-run
 * expansion) for one edit, returning a per-edit error or null.
 */
function precheckEditNewString(
    newString: string,
    metadata: SimplificationMetadata,
    externalRefContext: ExternalRefContext,
    pageLabels: PageLabelsByAttachmentId,
    resolvedLocatorPages: ResolvedLocatorPages,
): { error: string; errorCode: string } | null {
    const validationError = validateNewString(newString, metadata);
    if (validationError) return { error: validationError, errorCode: 'invalid_new_string' };

    const citationError = checkNewCitationItemsExist(newString, metadata);
    if (citationError) return { error: citationError, errorCode: 'citation_item_not_found' };

    try {
        expandToRawHtml(newString, metadata, 'new', externalRefContext, pageLabels, resolvedLocatorPages);
    } catch (e: any) {
        return { error: e?.message || String(e), errorCode: 'expansion_failed' };
    }
    return null;
}

export interface PreloadedLabels {
    pageLabels: PageLabelsByAttachmentId;
    resolvedLocatorPages: ResolvedLocatorPages;
    locatorWarnings: string[];
}

/** Preload the union of page labels + structural locators across every edit. */
export async function preloadBatchLabels(edits: EditNoteBatchEditItem[]): Promise<PreloadedLabels> {
    let pageLabels: PageLabelsByAttachmentId = {};
    const resolvedLocatorPages: ResolvedLocatorPages = {};
    const locatorWarnings: string[] = [];
    for (const edit of edits) {
        const newLabels = await preloadPageLabelsForNewCitations(edit.new_string);
        const oldLabels = await preloadPageLabelsForNewCitations(edit.old_string ?? '');
        pageLabels = { ...pageLabels, ...newLabels, ...oldLabels };
        const structural = await preloadStructuralLocatorPages(edit.new_string);
        Object.assign(resolvedLocatorPages, structural.pages);
        const warning = buildUnresolvedLocatorWarning(structural.unresolved);
        if (warning) locatorWarnings.push(warning);
    }
    return { pageLabels, resolvedLocatorPages, locatorWarnings };
}

/**
 * Prepare per-edit specs for the core resolver: run the no-op guard + new_string
 * precheck (collecting failures), enrich old_string, and pre-render the Markdown
 * fallback. Edits that fail a pre-check are NOT added to `specs`, so the batch is
 * still rejected but every edit's diagnostics are collected.
 */
export async function prepareSpecs(
    edits: EditNoteBatchEditItem[],
    metadata: SimplificationMetadata,
    externalRefContext: ExternalRefContext,
    labels: PreloadedLabels,
    libraryId: number,
): Promise<{ specs: BatchEditSpec[]; failures: BatchEditFailure[] }> {
    const specs: BatchEditSpec[] = [];
    const failures: BatchEditFailure[] = [];

    for (const edit of edits) {
        const operation = opOf(edit);

        const noOp = checkNoOp(operation, edit.old_string, edit.new_string);
        if (noOp) {
            failures.push({ index: edit.index, error: noOp.error, errorCode: noOp.errorCode });
            continue;
        }

        const pre = precheckEditNewString(
            edit.new_string, metadata, externalRefContext, labels.pageLabels, labels.resolvedLocatorPages,
        );
        if (pre) {
            failures.push({ index: edit.index, error: pre.error, errorCode: pre.errorCode });
            continue;
        }

        const isStrReplaceFamily = operation !== 'rewrite' && operation !== 'append';
        let oldString = edit.old_string ?? '';
        let rendered: { renderedOldSimplified?: string; renderedNewSimplified?: string } = {};
        if (isStrReplaceFamily) {
            oldString = applyOldStringEnrichment(oldString, metadata, labels.pageLabels) ?? oldString;
            rendered = await buildMarkdownRenderFields(oldString, edit.new_string, operation, libraryId);
        }

        specs.push({
            index: edit.index,
            client_item_id: edit.client_item_id,
            operation,
            oldString,
            newString: edit.new_string,
            targetBeforeContext: edit.target_before_context,
            targetAfterContext: edit.target_after_context,
            ...rendered,
        });
    }

    return { specs, failures };
}

/**
 * Build the batch `edit_errors[]` list from resolution/precheck failures and
 * overlaps, plus the top-level error summary + error_code. Returns null when
 * there is nothing to report.
 */
function buildEditErrors(
    edits: EditNoteBatchEditItem[],
    failures: BatchEditFailure[],
    overlaps: ReturnType<typeof detectOverlaps>,
): { editErrors: EditValidationError[]; topError: string; topCode: string } | null {
    if (failures.length === 0 && overlaps.length === 0) return null;

    const editErrors: EditValidationError[] = failures.map((f) => ({
        index: f.index,
        error: f.error,
        error_code: f.errorCode,
        ...(f.candidates && f.candidates.length > 0
            ? { error_candidates: f.candidates as ErrorCandidate[] }
            : {}),
    }));

    // One edit can overlap several siblings — collapse its pairs into a single
    // edit_errors entry naming every conflicting partner, so indices are unique
    // and the top-level count reflects edits, not pairs.
    const overlapPartners = new Map<number, Set<number>>();
    for (const overlap of overlaps) {
        if (!overlapPartners.has(overlap.secondIndex)) overlapPartners.set(overlap.secondIndex, new Set());
        overlapPartners.get(overlap.secondIndex)!.add(overlap.firstIndex);
    }
    for (const [index, partners] of overlapPartners) {
        const partnerList = [...partners].sort((a, b) => a - b).join(', ');
        editErrors.push({
            index,
            error: `Edit ${index} overlaps edit(s) ${partnerList}: their target ranges `
                + 'intersect, so they cannot be applied together. Re-issue them so each edit targets a '
                + 'distinct region of the note.',
            error_code: 'overlapping_edits',
        });
    }

    editErrors.sort((a, b) => a.index - b.index);

    const hasNotFound = editErrors.some((e) => e.error_code === 'old_string_not_found');
    const onlyOverlaps = failures.length === 0 && overlaps.length > 0;
    const topCode = hasNotFound
        ? 'old_string_not_found'
        : onlyOverlaps
            ? 'overlapping_edits'
            : (editErrors[0].error_code ?? 'edit_failed');
    const failedCount = new Set(editErrors.map((e) => e.index)).size;
    const topError = `${failedCount} of ${edits.length} edit(s) in the batch could not be applied.`;

    return { editErrors, topError, topCode };
}

/**
 * Build the normalized edit item for one resolved edit, echoing the request's
 * `index`/`client_item_id` and carrying post-enrichment/matcher old_string,
 * merged new_string, and captured context anchors.
 */
function buildNormalizedEdit(
    original: EditNoteBatchEditItem,
    resolved: ResolvedBatchEdit,
): EditNoteBatchEditItem {
    const item: EditNoteBatchEditItem = {
        index: original.index,
        client_item_id: original.client_item_id,
        operation: original.operation,
        old_string: resolved.normalizedOldString ?? original.old_string,
        new_string: resolved.normalizedNewString ?? original.new_string,
    };
    const before = resolved.targetBeforeContext ?? original.target_before_context;
    const after = resolved.targetAfterContext ?? original.target_after_context;
    if (before !== undefined) item.target_before_context = before;
    if (after !== undefined) item.target_after_context = after;
    return item;
}

/** True when any field of the normalized edit differs from the request edit. */
function normalizedEditDiffers(
    original: EditNoteBatchEditItem,
    normalized: EditNoteBatchEditItem,
): boolean {
    return (
        (normalized.old_string ?? undefined) !== (original.old_string ?? undefined)
        || normalized.new_string !== original.new_string
        || (normalized.target_before_context ?? undefined) !== (original.target_before_context ?? undefined)
        || (normalized.target_after_context ?? undefined) !== (original.target_after_context ?? undefined)
    );
}

/**
 * Structural batch validation shared by validate + execute. Besides requiring
 * a non-empty batch and keeping rewrite as a sole edit, enforce the protocol's
 * positional-index invariant. The core uses `index` to order same-position
 * appends and group apply operations into undo records, so duplicate,
 * out-of-order, fractional, or missing indices are not safe to accept.
 */

/**
 * Local backstop on batch size for callers that do not go through the backend.
 * Matches the upper bound of the backend's configurable per-call edit limit,
 * so a batch the backend allows is never rejected here.
 */
export const MAX_BATCH_EDITS = 200;

export function checkBatchShape(edits: EditNoteBatchEditItem[] | undefined): { error: string; errorCode: string } | null {
    if (!Array.isArray(edits) || edits.length === 0) {
        return { error: 'edit_note_batch requires at least one edit.', errorCode: 'no_edits' };
    }
    if (edits.length > MAX_BATCH_EDITS) {
        return {
            error: `edit_note_batch supports at most ${MAX_BATCH_EDITS} edits per call; received ${edits.length}. `
                + 'Split the changes into multiple calls, or use a single rewrite edit for dense whole-note changes.',
            errorCode: 'invalid_batch',
        };
    }
    const invalidIndexPosition = edits.findIndex(
        (edit, position) => !edit || !Number.isInteger(edit.index) || edit.index !== position,
    );
    if (invalidIndexPosition !== -1) {
        const receivedIndex = edits[invalidIndexPosition]?.index;
        return {
            error: `Each edit index must match its zero-based position in edits[]. `
                + `Expected index ${invalidIndexPosition} at position ${invalidIndexPosition}, `
                + `received ${String(receivedIndex)}.`,
            errorCode: 'invalid_batch',
        };
    }
    const rewriteCount = edits.filter((e) => opOf(e) === 'rewrite').length;
    if (rewriteCount > 0 && edits.length > 1) {
        return {
            error: 'A rewrite edit must be the only edit in the batch. Split the rewrite into a separate '
                + 'edit_note_batch call, or express the changes as str_replace/insert edits.',
            errorCode: 'invalid_batch',
        };
    }
    return null;
}

// =============================================================================
// Validate
// =============================================================================

/**
 * Validate an edit_note_batch action. Resolves ALL edits against ONE note
 * snapshot, checks for range overlaps, and fails closed with per-edit
 * diagnostics if any edit cannot be resolved or two edits truly intersect.
 */
async function validateEditNoteBatchAction(
    request: WSAgentActionValidateRequest,
): Promise<WSAgentActionValidateResponse> {
    const { library_id, library_ref, zotero_key, edits } = request.action_data as EditNoteBatchProposedData;

    const shapeError = checkBatchShape(edits);
    if (shapeError) return validateError(request.request_id, shapeError.error, shapeError.errorCode);

    // Exclusion boundary BEFORE resolving/loading the note.
    const targetLibraryId = resolveLibraryRef({ library_id, library_ref });
    const excluded = targetLibraryId === null ? null : checkLibraryExcluded(targetLibraryId);
    if (excluded) return validateError(request.request_id, excluded.message, 'library_not_searchable');

    const resolved = await resolveItemReference({ library_id, library_ref, zotero_key });
    if (resolved.status === 'library_unavailable') {
        return validateError(request.request_id, `Library not available for note: ${library_ref || library_id}-${zotero_key}`, 'library_unavailable');
    }
    if (resolved.status === 'not_found') {
        return validateError(request.request_id, `Item not found: ${library_id}-${zotero_key}`, 'item_not_found');
    }
    const item = resolved.item;
    const resolvedLibraryId = item.libraryID;

    const library = Zotero.Libraries.get(resolvedLibraryId);
    if (!library) {
        return validateError(request.request_id, `Library not found: ${resolvedLibraryId}`, 'library_not_found');
    }

    const searchableIds = store.get(searchableLibraryIdsAtom);
    if (!searchableIds.includes(resolvedLibraryId)) {
        return validateError(request.request_id, excludedLibraryMessage(resolvedLibraryId), 'library_not_searchable');
    }

    if (!item.isNote()) {
        const itemId = modelObjectIdFromReference({ library_id: resolvedLibraryId, library_ref, zotero_key });
        let error = `Item ${itemId} is not a note`;
        if (item.isRegularItem()) {
            error = `Item ${itemId} is a regular item and not a note. To create a new zotero note that is attached to the regular item ${itemId}, use the the <note title="..." item_id="${itemId}">...</note> tag in your response.`;
        } else if (item.isAttachment()) {
            error = `Item ${itemId} is an attachment and not a note. To create a new zotero note, use the the <note title="..." item_id="${itemId}">...</note> tag in your response. To edit a note, use the edit_note with an existing note id.`;
        } else if (item.isAnnotation()) {
            error = `Item ${itemId} is an annotation and not a note. To create a new zotero note, use the the <note title="..." item_id="${itemId}">...</note> tag in your response. To edit a note, use the edit_note with an existing note id.`;
        }
        return validateError(request.request_id, error, 'not_a_note');
    }

    if (!library.editable) {
        return validateError(request.request_id, `Library '${library.name}' is read-only and cannot be edited`, 'library_not_editable');
    }

    await item.loadDataType('note');
    let rawHtml = getLatestNoteHtml(item);
    if (containsPreviewMarkers(rawHtml)) {
        logger(`validateEditNoteBatchAction: note ${resolvedLibraryId}-${zotero_key} contains persisted diff-preview markup; validating against stripped content`, 1);
        rawHtml = stripPreviewMarkers(rawHtml);
    }

    if (!rawHtml || rawHtml.trim() === '') {
        return validateError(request.request_id, `Note ${resolvedLibraryId}-${zotero_key} is empty`, 'empty_note');
    }

    // Simplify ONCE.
    const noteId = `${resolvedLibraryId}-${zotero_key}`;
    const pageLabelsByItemId = await preloadNotePageLabels(rawHtml, resolvedLibraryId, { extractOnCacheMiss: true });
    const { simplified, metadata } = getOrSimplify(noteId, rawHtml, resolvedLibraryId, pageLabelsByItemId);

    const externalRefContext = getExternalRefContext();
    const labels = await preloadBatchLabels(edits);

    // Strip data-citation-items ONCE — the shared match/apply haystack.
    const strippedHtml = stripDataCitationItems(normalizeNoteHtml(rawHtml));
    const appendPoint = getBeaverFooterAppendPoint(strippedHtml);

    const { specs, failures: prepFailures } = await prepareSpecs(
        edits, metadata, externalRefContext, labels, resolvedLibraryId,
    );

    const ctx: ResolveBatchContext = {
        strippedHtml, simplified, metadata, externalRefContext,
        pageLabels: labels.pageLabels,
        resolvedLocatorPages: labels.resolvedLocatorPages,
        appendPoint,
        mode: 'validate',
    };
    const { resolved: resolvedEdits, failures: resolveFailures } = resolveBatchEdits(ctx, specs);
    const overlaps = detectOverlaps(resolvedEdits);

    const allFailures = [...prepFailures, ...resolveFailures];
    const errorReport = buildEditErrors(edits, allFailures, overlaps);
    if (errorReport) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: errorReport.topError,
            error_code: errorReport.topCode,
            edit_errors: errorReport.editErrors,
            preference: 'always_ask',
        };
    }

    // Success — build normalized_action_data (same order/length as request).
    const resolvedByIndex = new Map<number, ResolvedBatchEdit>();
    for (const r of resolvedEdits) resolvedByIndex.set(r.index, r);

    const normalizedEdits: EditNoteBatchEditItem[] = [];
    const warnings: string[] = [...labels.locatorWarnings];
    let anyChanged = false;
    for (const edit of edits) {
        const r = resolvedByIndex.get(edit.index);
        if (!r) {
            // Should not happen on success, but keep the array aligned.
            normalizedEdits.push(edit);
            continue;
        }
        const normalized = buildNormalizedEdit(edit, r);
        normalizedEdits.push(normalized);
        if (normalizedEditDiffers(edit, normalized)) anyChanged = true;
        for (const w of r.warnings) warnings.push(w);
    }

    const isSingleRewrite = edits.length === 1 && opOf(edits[0]) === 'rewrite';
    const totalLines = simplified.split('\n').length;
    const noteTitle = item.getNoteTitle() || '(untitled)';

    const response: WSAgentActionValidateResponse = {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            note_title: noteTitle,
            total_lines: totalLines,
            ...(isSingleRewrite ? { old_content: simplified } : {}),
        },
        preference: getDeferredToolPreference('edit_note_batch', {
            library_id: resolvedLibraryId,
            zotero_key,
        }),
    };
    if (anyChanged) {
        response.normalized_action_data = {
            library_id,
            zotero_key,
            ...(library_ref !== undefined ? { library_ref } : {}),
            edits: normalizedEdits,
        };
    }
    if (warnings.length > 0) response.warnings = warnings;
    return response;
}

// =============================================================================
// Execute
// =============================================================================

/**
 * Execute an edit_note_batch action. Re-resolves ALL edits against the current
 * note (defense-in-depth), re-checks overlaps, then applies every edit in ONE
 * setNote + saveTx — all or nothing.
 *
 * Concurrency: relies on `AgentService.actionExecutionQueue` to serialize all
 * agent action dispatches, so no per-note lock is taken here.
 */
async function executeEditNoteBatchAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const { library_id, library_ref, zotero_key, edits } = request.action_data as EditNoteBatchProposedData;

    const shapeError = checkBatchShape(edits);
    if (shapeError) return executeError(request.request_id, shapeError.error, shapeError.errorCode);

    // TOCTOU exclusion guard BEFORE resolving/loading the note.
    const targetLibraryId = resolveLibraryRef({ library_id, library_ref });
    const targetExcluded = targetLibraryId === null ? null : checkLibraryExcluded(targetLibraryId);
    if (targetExcluded) return executeError(request.request_id, targetExcluded.message, 'library_not_searchable');

    const resolved = await resolveItemReference({ library_id, library_ref, zotero_key });
    if (resolved.status !== 'found') {
        return executeError(
            request.request_id,
            resolved.status === 'library_unavailable'
                ? `Library not available for note: ${library_ref || library_id}-${zotero_key}`
                : `Item not found: ${library_id}-${zotero_key}`,
            resolved.status === 'library_unavailable' ? 'library_unavailable' : 'item_not_found',
        );
    }
    const item = resolved.item;
    const resolvedLibraryId = item.libraryID;

    const excludedLibrary = checkLibraryExcluded(resolvedLibraryId);
    if (excludedLibrary) return executeError(request.request_id, excludedLibrary.message, 'library_not_searchable');

    // Library editability can change between validation and execution
    // (TOCTOU, same as the exclusion re-check above): fail cleanly instead of
    // surfacing a raw save error from Zotero.
    const executeLibrary = Zotero.Libraries.get(resolvedLibraryId);
    if (executeLibrary && !executeLibrary.editable) {
        return executeError(request.request_id, `Library '${executeLibrary.name}' is read-only and cannot be edited`, 'library_not_editable');
    }

    // Load note + settle any in-flight diff preview / unsaved editor content.
    await item.loadDataType('note');
    if (isDiffPreviewActive(resolvedLibraryId, zotero_key) || isDiffPreviewPendingFor(resolvedLibraryId, zotero_key)) {
        await dismissDiffPreview();
    }
    await flushLiveEditorToDB(item);

    // Repair persisted diff-preview markup (and save the repair even if the
    // batch later fails, so a failed attempt still un-bricks the note).
    {
        const persistedHtml: string = item.getNote();
        if (containsPreviewMarkers(persistedHtml)) {
            const repaired = stripPreviewMarkers(persistedHtml);
            if (!containsPreviewMarkers(repaired)) {
                logger(`executeEditNoteBatchAction: repairing persisted diff-preview markup in ${resolvedLibraryId}-${zotero_key}`, 1);
                item.setNote(repaired);
                await item.saveTx();
                await waitForNoteSaveStabilization(item, repaired);
            } else {
                logger(`executeEditNoteBatchAction: diff-preview markup in ${resolvedLibraryId}-${zotero_key} could not be fully stripped; save will be refused by the preview guard`, 1);
            }
        }
    }

    // Preload page labels for ALL edits before the final note snapshot.
    const labels = await preloadBatchLabels(edits);

    const preSeedHtml = item.getNote();
    await preloadNotePageLabels(preSeedHtml, resolvedLibraryId, { extractOnCacheMiss: true });

    // Snapshot the note. Avoid async between here and item.setNote() to keep atomicity.
    const oldHtml: string = item.getNote();
    const noteId = `${resolvedLibraryId}-${zotero_key}`;
    const pageLabelsByItemId = await preloadNotePageLabels(oldHtml, resolvedLibraryId);
    const { simplified, metadata } = getOrSimplify(noteId, oldHtml, resolvedLibraryId, pageLabelsByItemId);
    const externalRefContext = getExternalRefContext();

    const normalizedOldHtml = normalizeNoteHtml(oldHtml);
    const existingCitationCache = extractDataCitationItems(normalizedOldHtml);
    const strippedHtml = stripDataCitationItems(normalizedOldHtml);

    const threadId = store.get(currentThreadIdAtom);

    // ── Single-rewrite batch: v1 rewrite tail semantics, batch envelope ──
    if (edits.length === 1 && opOf(edits[0]) === 'rewrite') {
        return await executeSingleRewrite(
            request, ctx, item, edits[0], resolvedLibraryId, zotero_key,
            oldHtml, strippedHtml, existingCitationCache, metadata, externalRefContext,
            labels, threadId, noteId,
        );
    }

    // ── General batch ──
    const { specs, failures: prepFailures } = await prepareSpecs(
        edits, metadata, externalRefContext, labels, resolvedLibraryId,
    );
    // A pre-check failure at execute time means the note drifted since approval.
    if (prepFailures.length > 0) {
        const first = prepFailures[0];
        return executeError(
            request.request_id,
            `Batch cannot be applied: ${prepFailures.length} edit(s) failed re-validation (edit ${first.index}: ${first.error})`,
            first.errorCode,
            first.candidates as ErrorCandidate[] | undefined,
        );
    }

    const appendPoint = getBeaverFooterAppendPoint(strippedHtml);
    const resolveCtx: ResolveBatchContext = {
        strippedHtml, simplified, metadata, externalRefContext,
        pageLabels: labels.pageLabels,
        resolvedLocatorPages: labels.resolvedLocatorPages,
        appendPoint,
        mode: 'execute',
    };
    const { resolved: resolvedEdits, failures: resolveFailures } = resolveBatchEdits(resolveCtx, specs);

    // Any resolution failure → whole batch fails BEFORE any write.
    if (resolveFailures.length > 0) {
        const first = resolveFailures[0];
        return executeError(
            request.request_id,
            `Batch cannot be applied: ${resolveFailures.length} edit(s) no longer resolve against the current note `
            + `(edit ${first.index}: ${first.error})`,
            first.errorCode,
            first.candidates as ErrorCandidate[] | undefined,
        );
    }

    // Re-run the overlap gate — the note may have drifted since approval.
    const overlaps = detectOverlaps(resolvedEdits);
    if (overlaps.length > 0) {
        const o = overlaps[0];
        return executeError(
            request.request_id,
            `Batch cannot be applied: edits ${o.firstIndex} and ${o.secondIndex} now target overlapping regions of the note.`,
            'overlapping_edits',
        );
    }

    // Apply ALL edits in one pass.
    const { newStrippedHtml, undoDrafts } = applyResolvedEdits(strippedHtml, resolvedEdits);

    // Footer ONCE, then rebuild data-citation-items ONCE.
    let newHtml = newStrippedHtml;
    if (threadId) newHtml = addOrUpdateEditFooter(newHtml, threadId);
    newHtml = rebuildDataCitationItems(newHtml, existingCitationCache);

    const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
    if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
        return executeError(request.request_id, 'The note wrapper <div data-schema-version="..."> must not be removed.', 'wrapper_removed');
    }

    checkAborted(ctx, 'edit_note_batch:before_save');

    try {
        assertNoPreviewMarkers(newHtml, 'editNoteBatch:apply');
        item.setNote(newHtml);
        await item.saveTx();
        logger(`executeEditNoteBatchAction: Saved ${resolvedEdits.length} edit(s) to ${noteId}`, 1);
    } catch (error) {
        try {
            assertNoPreviewMarkers(oldHtml, 'editNoteBatch:rollback');
            item.setNote(oldHtml);
        } catch (_) { /* best-effort */ }
        if (error instanceof TimeoutError) throw error;
        return executeError(request.request_id, `Failed to save note: ${error}`, 'save_failed');
    }

    await waitForNoteSaveStabilization(item, newHtml);
    clearNoteEditorSelection(resolvedLibraryId, zotero_key);
    invalidateSimplificationCache(noteId);

    // Refresh undo contexts against the final (post-footer, PM-normalized) HTML.
    const finalStripped = stripDataCitationItems(getLatestNoteHtml(item));
    captureUndoContexts(finalStripped, undoDrafts, newStrippedHtml);

    // Warnings: per-edit duplicate-citation + batch locator warnings.
    const warnings: string[] = [...labels.locatorWarnings];
    for (const edit of edits) {
        const dup = checkDuplicateCitations(edit.new_string, metadata);
        if (dup) warnings.push(dup);
    }

    const applied = buildAppliedList(resolvedEdits);
    const undo = buildUndoList(undoDrafts);

    return {
        type: 'agent_action_execute_response',
        request_id: request.request_id,
        success: true,
        result_data: {
            library_id: resolvedLibraryId,
            zotero_key,
            library_ref: libraryRefForLibraryID(resolvedLibraryId) ?? undefined,
            applied,
            ...(warnings.length > 0 ? { warnings } : {}),
            undo,
        },
    };
}

export function buildAppliedList(resolvedEdits: ResolvedBatchEdit[]): EditNoteBatchAppliedEdit[] {
    return resolvedEdits.map((r) => ({
        index: r.index,
        client_item_id: r.client_item_id,
        occurrences_replaced: r.occurrencesReplaced,
    }));
}

export function buildUndoList(drafts: BatchUndoDraft[]): EditNoteBatchUndoRecord[] {
    return drafts.map((d) => ({
        index: d.index,
        client_item_id: d.client_item_id,
        operation: d.operation,
        undo_old_html: d.undo_old_html,
        undo_new_html: d.undo_new_html,
        ...(d.undo_before_context !== undefined ? { undo_before_context: d.undo_before_context } : {}),
        ...(d.undo_after_context !== undefined ? { undo_after_context: d.undo_after_context } : {}),
        ...(d.undo_occurrence_contexts !== undefined ? { undo_occurrence_contexts: d.undo_occurrence_contexts } : {}),
    }));
}

/**
 * Apply a single-rewrite batch using the same wrapper-preserving semantics as
 * the single-edit rewrite path, wrapped in the batch result envelope. The undo
 * record carries the FULL pre-edit stripped body in undo_old_html.
 */
async function executeSingleRewrite(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
    item: Zotero.Item,
    edit: EditNoteBatchEditItem,
    resolvedLibraryId: number,
    zotero_key: string,
    oldHtml: string,
    strippedHtml: string,
    existingCitationCache: ReturnType<typeof extractDataCitationItems>,
    metadata: SimplificationMetadata,
    externalRefContext: ExternalRefContext,
    labels: PreloadedLabels,
    threadId: string | null,
    noteId: string,
): Promise<WSAgentActionExecuteResponse> {
    let expandedNew: string;
    try {
        expandedNew = expandToRawHtml(
            edit.new_string, metadata, 'new', externalRefContext,
            labels.pageLabels, labels.resolvedLocatorPages,
        );
    } catch (e: any) {
        return executeError(request.request_id, e?.message || String(e), 'expansion_failed');
    }

    // Preserve wrapper div by slicing it off the stripped body.
    const trimmed = strippedHtml.trim();
    let wrapperOpen = '';
    let wrapperClose = '';
    if (trimmed.startsWith('<div') && trimmed.endsWith('</div>')) {
        const closeAngle = trimmed.indexOf('>');
        wrapperOpen = trimmed.substring(0, closeAngle + 1);
        wrapperClose = '</div>';
    }

    let newHtml = wrapperOpen + expandedNew + wrapperClose;
    if (threadId) newHtml = addOrUpdateEditFooter(newHtml, threadId);
    newHtml = rebuildDataCitationItems(newHtml, existingCitationCache);

    const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
    if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
        return executeError(request.request_id, 'The note wrapper <div data-schema-version="..."> must not be removed.', 'wrapper_removed');
    }

    checkAborted(ctx, 'edit_note_batch:before_save');

    try {
        assertNoPreviewMarkers(newHtml, 'editNoteBatch:rewrite:apply');
        item.setNote(newHtml);
        await item.saveTx();
        logger(`executeEditNoteBatchAction: Saved rewrite edit to ${noteId}`, 1);
    } catch (error) {
        try {
            assertNoPreviewMarkers(oldHtml, 'editNoteBatch:rewrite:rollback');
            item.setNote(oldHtml);
        } catch (_) { /* best-effort */ }
        if (error instanceof TimeoutError) throw error;
        return executeError(request.request_id, `Failed to save note: ${error}`, 'save_failed');
    }

    await waitForNoteSaveStabilization(item, newHtml);
    clearNoteEditorSelection(resolvedLibraryId, zotero_key);
    invalidateSimplificationCache(noteId);

    const warnings: string[] = [...labels.locatorWarnings];
    const dup = checkDuplicateCitations(edit.new_string, metadata);
    if (dup) warnings.push(dup);

    return {
        type: 'agent_action_execute_response',
        request_id: request.request_id,
        success: true,
        result_data: {
            library_id: resolvedLibraryId,
            zotero_key,
            library_ref: libraryRefForLibraryID(resolvedLibraryId) ?? undefined,
            applied: [{
                index: edit.index,
                client_item_id: edit.client_item_id,
                occurrences_replaced: 1,
            }],
            ...(warnings.length > 0 ? { warnings } : {}),
            undo: [{
                index: edit.index,
                client_item_id: edit.client_item_id,
                operation: 'rewrite',
                undo_old_html: strippedHtml,
            }],
        },
    };
}

export { validateEditNoteBatchAction, executeEditNoteBatchAction };
