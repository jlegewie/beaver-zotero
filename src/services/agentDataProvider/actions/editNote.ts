import { logger } from '../../../utils/logger';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { EditNoteProposedData, type EditNoteOperation } from '../../../../react/types/agentActions/editNote';
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
    type ExternalRefContext,
} from '../../../utils/noteCitationExpand';
import {
    getLatestNoteHtml,
    waitForPMNormalization,
    waitForNoteSaveStabilization,
    flushLiveEditorToDB,
} from '../../../utils/noteEditorIO';
import {
    stripDataCitationItems,
    extractDataCitationItems,
    rebuildDataCitationItems,
    hasSchemaVersionWrapper,
} from '../../../utils/noteWrapper';
import {
    locateEditTarget,
    resolveEditTargetAtRuntime,
    buildZeroMatchHint,
    buildExecutionZeroMatchHint,
} from '../../../utils/editNotePositionLookup';
import {
    expandBase,
    findBestMatch,
    type BaseExpansion,
    type MatchInput,
} from './editNoteMatcher';
import { clearNoteEditorSelection } from '../../../../react/utils/sourceUtils';
import { store } from '../../../../react/store';
import { currentThreadIdAtom } from '../../../../react/atoms/threads';
import {
    externalReferenceMappingAtom,
    externalReferenceItemMappingAtom,
} from '../../../../react/atoms/externalReferences';
import { addOrUpdateEditFooter } from '../../../utils/noteEditFooter';
import { assertNoPreviewMarkers } from '../../../utils/notePreviewGuard';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
    DeferredToolPreference,
} from '../../agentProtocol';
import { getDeferredToolPreference } from '../utils';
import { autoApproveNoteKeysAtom, makeNoteKey } from '../../../../react/atoms/editNoteAutoApprove';
import { TimeoutContext, checkAborted } from '../timeout';
import { TimeoutError } from '../timeout';

/**
 * Merge old_string and new_string for insert_after / insert_before operations
 * so the result can be treated as a regular str_replace. Returns new_string
 * unchanged for non-insert operations.
 */
function mergeInsertNewString(
    operation: EditNoteOperation,
    oldString: string,
    newString: string,
): string {
    if (operation === 'insert_after') return oldString + newString;
    if (operation === 'insert_before') return newString + oldString;
    return newString;
}

/**
 * Get the effective preference for an edit_note action.
 * Returns 'always_apply' if the note has been auto-approved for this run,
 * otherwise falls back to the user's stored deferred-tool preference.
 */
function getEditNotePreference(library_id: number, zotero_key: string): DeferredToolPreference {
    const noteKey = makeNoteKey(library_id, zotero_key);
    const autoApproveKeys = store.get(autoApproveNoteKeysAtom);
    if (autoApproveKeys.has(noteKey)) {
        return 'always_apply';
    }
    return getDeferredToolPreference('edit_note');
}

/**
 * Snapshot the thread's external-reference state from the Jotai store so
 * `expandToRawHtml('new', ...)` can resolve `<citation external_id="..."/>`
 * to either an in-library Zotero item or an inline `<a>` link, instead of
 * throwing on attributes the simplifier doesn't natively know about.
 */
function getExternalRefContext(): ExternalRefContext {
    return {
        externalRefs: store.get(externalReferenceMappingAtom),
        externalItemMapping: store.get(externalReferenceItemMappingAtom),
    };
}

/**
 * Run the three `new_string` pre-checks (tag validity, citation item existence,
 * dry-run expansion) and return either the expanded raw HTML or a fully-formed
 * validation error response. Keeps the rewrite and main validator branches in
 * sync so future pre-checks only need to be added in one place.
 */
type NewStringPrecheckResult =
    | { ok: true; expandedNew: string }
    | { ok: false; response: WSAgentActionValidateResponse };

function precheckNewString(
    requestId: string,
    newString: string,
    metadata: SimplificationMetadata,
    externalRefContext: ExternalRefContext,
): NewStringPrecheckResult {
    const validationError = validateNewString(newString, metadata);
    if (validationError) {
        return {
            ok: false,
            response: {
                type: 'agent_action_validate_response',
                request_id: requestId,
                valid: false,
                error: validationError,
                error_code: 'invalid_new_string',
                preference: 'always_ask',
            },
        };
    }

    const citationError = checkNewCitationItemsExist(newString, metadata);
    if (citationError) {
        return {
            ok: false,
            response: {
                type: 'agent_action_validate_response',
                request_id: requestId,
                valid: false,
                error: citationError,
                error_code: 'citation_item_not_found',
                preference: 'always_ask',
            },
        };
    }

    try {
        const expandedNew = expandToRawHtml(newString, metadata, 'new', externalRefContext);
        return { ok: true, expandedNew };
    } catch (e: any) {
        return {
            ok: false,
            response: {
                type: 'agent_action_validate_response',
                request_id: requestId,
                valid: false,
                error: e.message || String(e),
                error_code: 'expansion_failed',
                preference: 'always_ask',
            },
        };
    }
}


function buildValidateSuccess(
    requestId: string,
    item: Zotero.Item,
    simplified: string,
    library_id: number,
    zotero_key: string,
    matchCount: number,
    normalized_action_data: EditNoteProposedData | undefined,
): WSAgentActionValidateResponse {
    const noteTitle = item.getNoteTitle() || '(untitled)';
    const totalLines = simplified.split('\n').length;
    const preference = getEditNotePreference(library_id, zotero_key);
    return {
        type: 'agent_action_validate_response',
        request_id: requestId,
        valid: true,
        current_value: {
            note_title: noteTitle,
            total_lines: totalLines,
            match_count: matchCount,
        },
        normalized_action_data,
        preference,
    };
}

function buildAmbiguousMatchError(matchCount: number): string {
    return `The string to replace was found ${matchCount} times in the note. `
        + 'Use operation str_replace_all to replace all occurrences, or include more context to make the match unique.';
}

function buildAmbiguousMatchResponse(
    requestId: string,
    matchCount: number,
): WSAgentActionValidateResponse {
    return {
        type: 'agent_action_validate_response',
        request_id: requestId,
        valid: false,
        error: buildAmbiguousMatchError(matchCount),
        error_code: 'ambiguous_match',
        preference: 'always_ask',
    };
}

/**
 * Validate an edit_note action.
 * Checks the note exists, is editable, not in editor, and performs a dry-run
 * expansion + match to verify the replacement will succeed.
 */
async function validateEditNoteAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    // `old_string` is `let` because step 10c may enrich no-ref citations in
    // place (see `applyOldStringEnrichment`). All downstream code operates on
    // the enriched value, and `buildNormalizedActionData` below automatically
    // propagates the enrichment into `normalized_action_data`.
    const { library_id, zotero_key, new_string, operation: rawOp } = request.action_data as EditNoteProposedData;
    const baseActionData = request.action_data as EditNoteProposedData;
    let { old_string } = baseActionData;
    const operation: EditNoteOperation = rawOp ?? 'str_replace';

    // Build a `normalized_action_data` payload that auto-includes any
    // post-enrichment `old_string`. Returns `undefined` when neither the
    // supplied `overrides` nor enrichment changed anything from the input,
    // letting callers skip emitting `normalized_action_data` unconditionally.
    // Callers should NOT pass `old_string` via `overrides` — rely on the
    // mutating local binding.
    const buildNormalizedActionData = (
        overrides: Partial<EditNoteProposedData> = {},
    ): EditNoteProposedData | undefined => {
        const changed: Partial<EditNoteProposedData> = { ...overrides };
        if (old_string !== baseActionData.old_string) changed.old_string = old_string;
        return Object.keys(changed).length > 0
            ? { ...baseActionData, ...changed }
            : undefined;
    };

    // 1. Validate library exists
    const library = Zotero.Libraries.get(library_id);
    if (!library) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library not found: ${library_id}`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

    // 2. Check library is searchable
    const searchableIds = store.get(searchableLibraryIdsAtom);
    if (!searchableIds.includes(library_id)) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library exists but is not synced with Beaver. The user can update this setting in Beaver Preferences. Library: ${library.name} (ID: ${library_id})`,
            error_code: 'library_not_searchable',
            preference: 'always_ask',
        };
    }

    // 3. Item exists
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Item not found: ${library_id}-${zotero_key}`,
            error_code: 'item_not_found',
            preference: 'always_ask',
        };
    }

    // 4. Item is a note
    if (!item.isNote()) {
        const itemId = `${library_id}-${zotero_key}`;
        const resp = {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Item ${itemId} is not a note`,
            error_code: 'not_a_note',
            preference: 'always_ask',
        } as WSAgentActionValidateResponse;
        if (item.isRegularItem()) {
            resp.error = `Item ${itemId} is a regular item and not a note. To create a new zotero note that is attached to the regular item ${itemId}, use the the <note title="..." item_id="${itemId}">...</note> tag in your response.`;
        } else if (item.isAttachment()) {
            resp.error = `Item ${itemId} is an attachment and not a note. To create a new zotero note, use the the <note title="..." item_id="${itemId}">...</note> tag in your response. To edit a note, use the edit_note with an existing note id.`;
        } else if (item.isAnnotation()) {
            resp.error = `Item ${itemId} is an annotation and not a note. To create a new zotero note, use the the <note title="..." item_id="${itemId}">...</note> tag in your response. To edit a note, use the edit_note with an existing note id.`;
        }
        return resp;
    }

    // 5. Check library is editable (after item type, matching edit_metadata ordering)
    if (!library.editable) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library '${library.name}' is read-only and cannot be edited`,
            error_code: 'library_not_editable',
            preference: 'always_ask',
        };
    }

    // 6. Load note data
    await item.loadDataType('note');
    const rawHtml = getLatestNoteHtml(item);

    // 7. Note not empty
    if (!rawHtml || rawHtml.trim() === '') {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Note ${library_id}-${zotero_key} is empty`,
            error_code: 'empty_note',
            preference: 'always_ask',
        };
    }

    // 8. Simplify note (needed for both modes)
    const noteId = `${library_id}-${zotero_key}`;
    const { simplified, metadata } = getOrSimplify(noteId, rawHtml, library_id);

    // Snapshot external-reference state once so every expandToRawHtml('new', ...)
    // below can resolve `<citation external_id="..."/>` consistently.
    const externalRefContext = getExternalRefContext();

    // ── rewrite mode: skip old_string matching, validate new_string only ──
    if (operation === 'rewrite') {
        const pre = precheckNewString(request.request_id, new_string, metadata, externalRefContext);
        if (!pre.ok) return pre.response;

        const noteTitle = item.getNoteTitle() || '(untitled)';
        const totalLines = simplified.split('\n').length;
        const preference = getEditNotePreference(library_id, zotero_key);

        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: true,
            current_value: {
                note_title: noteTitle,
                total_lines: totalLines,
                match_count: 1,
                old_content: simplified,
            },
            preference,
        };
    }

    // ── String replacement mode (default) ──

    // 9. Require an actual change.
    // For insert_after / insert_before, old_string is preserved and new_string
    // is later appended/prepended during normalization, so the regular
    // identical-strings check does not apply. An empty payload is still a
    // no-op and must be rejected before normalization turns it into
    // replace-with-self.
    if (
        ((operation !== 'insert_after' && operation !== 'insert_before') && old_string === new_string)
        || ((operation === 'insert_after' || operation === 'insert_before') && new_string === '')
    ) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: operation === 'insert_after' || operation === 'insert_before'
                ? 'new_string must not be empty.'
                : 'old_string and new_string are identical.',
            error_code: 'no_changes',
            preference: 'always_ask',
        };
    }

    // 10. Pre-check new_string (tag validity, citation items exist, dry-run expand)
    const pre = precheckNewString(request.request_id, new_string, metadata, externalRefContext);
    if (!pre.ok) return pre.response;
    // 10c. Enrich no-ref citations in old_string with refs from metadata.
    //      When the model reuses the form it wrote in an earlier edit_note
    //      (citation without ref) as its old_string in a follow-up edit,
    //      we look up the corresponding ref from metadata and inject it so
    //      expansion succeeds instead of throwing "New citations (without a
    //      ref) can only appear in new_string". `buildNormalizedActionData`
    //      propagates the enriched value to the executor automatically.
    old_string = applyOldStringEnrichment(old_string, metadata);

    // 11. Normalize raw HTML to match what simplifyNoteHtml exposes to the
    //     model, then strip data-citation-items so matching stays focused on
    //     visible content.
    const strippedHtml = stripDataCitationItems(normalizeNoteHtml(rawHtml));

    // 12. Base expansion: convert old_string and new_string to raw-HTML space.
    //     Used by the exact/decode/encode/nfkc strategies; mutation strategies
    //     (trim, json_unescape, partial_strip, spurious_wrap) re-expand their
    //     own rewritten strings.
    const matchInput: MatchInput = {
        oldString: old_string ?? '',
        newString: new_string,
        operation,
        metadata,
        simplified,
        strippedHtml,
        externalRefContext,
    };
    let base: BaseExpansion;
    try {
        base = expandBase(matchInput);
    } catch (e: any) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: e.message || String(e),
            error_code: 'expansion_failed',
            preference: 'always_ask',
        };
    }

    // 13. Run the ranked matcher. The first strategy that produces a match
    //     wins. See editNoteMatcher.ts for the full chain.
    const match = findBestMatch(matchInput, base);
    if (!match) {
        const hint = buildZeroMatchHint(simplified, old_string ?? '');
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: hint.message,
            error_code: 'old_string_not_found',
            preference: 'always_ask',
            ...(hint.candidates.length > 0
                ? { error_candidates: hint.candidates }
                : {}),
        };
    }

    // Propagate any matcher rewrite of old_string through the outer binding so
    // buildNormalizedActionData emits the final form for the executor.
    old_string = match.oldString;

    // 14. Multi-match disambiguation. Only refuse the edit when neither the
    //     strategy's own position hint nor locateEditTarget can pin down a
    //     single occurrence.
    const overrides: Partial<EditNoteProposedData> = {};
    if (match.matchCount > 1 && operation !== 'str_replace_all') {
        if (match.rawPositionHint !== undefined) {
            // Strategy (partial_element_strip) already computed a precise raw
            // position — derive context anchors from it directly.
            const rawPos = match.rawPositionHint;
            overrides.target_before_context = strippedHtml.substring(
                Math.max(0, rawPos - 200), rawPos,
            );
            overrides.target_after_context = strippedHtml.substring(
                rawPos + match.expandedOld.length,
                rawPos + match.expandedOld.length + 200,
            );
        } else {
            const location = locateEditTarget({
                strippedHtml, simplified,
                oldString: match.oldString,
                expandedOld: match.expandedOld,
                metadata,
            });
            if (location.kind === 'context') {
                overrides.target_before_context = location.beforeContext;
                overrides.target_after_context = location.afterContext;
            } else if (location.kind === 'ambiguous') {
                return buildAmbiguousMatchResponse(request.request_id, match.matchCount);
            }
            // 'position' — silent success; executor will re-locate via
            // findUniqueRawMatchPosition with no anchors needed.
        }
    }

    // 15. Compose new_string: merge for insert operations, otherwise carry
    //     any matcher rewrite. mergeInsertNewString is a no-op for
    //     str_replace / str_replace_all.
    if (operation === 'insert_after' || operation === 'insert_before') {
        overrides.new_string = mergeInsertNewString(operation, match.oldString, match.newString);
    } else if (match.newString !== new_string) {
        overrides.new_string = match.newString;
    }

    return buildValidateSuccess(
        request.request_id,
        item,
        simplified,
        library_id,
        zotero_key,
        match.matchCount,
        buildNormalizedActionData(overrides),
    );
}


/**
 * Execute an edit_note action.
 * Performs the string replacement on the note's raw HTML via the simplified format.
 *
 * Concurrency: relies on `AgentService.actionExecutionQueue` (src/services/agentService.ts)
 * to serialize all agent action dispatches. This function assumes no other edit_note
 * execution is running against the same note. Do not introduce parallel dispatch
 * (e.g. Promise.all) at the caller level without adding a per-note lock here.
 */
async function executeEditNoteAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const {
        library_id,
        zotero_key,
        new_string,
        operation: rawOp,
    } = request.action_data as EditNoteProposedData;
    // `old_string` is `let` because step 5b re-runs `applyOldStringEnrichment`
    // as defense-in-depth for skipped/stale validation.
    let { old_string } = request.action_data as EditNoteProposedData;
    const operation: EditNoteOperation = rawOp ?? 'str_replace';
    let {
        target_before_context,
        target_after_context,
    } = request.action_data as EditNoteProposedData;

    // 1. Load item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Item not found: ${library_id}-${zotero_key}`,
            error_code: 'item_not_found',
        };
    }

    // 2. Load note
    await item.loadDataType('note');

    // 2b. Promote any unsaved content from the open editor into the DB so that
    //     this execute reads the same HTML validation saw. Without this, a
    //     rewrite could clobber the user's in-flight typing, and a str_replace
    //     could fail with no_match against matches that only exist in the
    //     editor's unsaved state.
    await flushLiveEditorToDB(item);

    // 3. Pre-load page labels so new citations resolve page indices to labels.
    //    Done before reading the note to avoid async gaps between read and write.
    await preloadPageLabelsForNewCitations(new_string);

    // 4. Get current note HTML (kept for rollback on save failure)
    //    Avoid async operations between here and item.setNote() to preserve atomicity.
    const oldHtml: string = item.getNote();

    // 5. Get metadata from cache or re-simplify
    const noteId = `${library_id}-${zotero_key}`;
    const { simplified, metadata } = getOrSimplify(noteId, oldHtml, library_id);

    // Snapshot external-reference state once so every expandToRawHtml('new', ...)
    // below can resolve `<citation external_id="..."/>` consistently.
    const externalRefContext = getExternalRefContext();

    // ── rewrite mode: replace entire note body ──
    if (operation === 'rewrite') {
        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(new_string, metadata, 'new', externalRefContext);
        } catch (e: any) {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: e.message || String(e),
                error_code: 'expansion_failed',
            };
        }

        const normalizedOldHtml = normalizeNoteHtml(oldHtml);
        const existingCitationCache = extractDataCitationItems(normalizedOldHtml);
        const strippedHtml = stripDataCitationItems(normalizedOldHtml);

        // Preserve wrapper div
        const trimmed = strippedHtml.trim();
        let wrapperOpen = '';
        let wrapperClose = '';
        if (trimmed.startsWith('<div') && trimmed.endsWith('</div>')) {
            const closeAngle = trimmed.indexOf('>');
            wrapperOpen = trimmed.substring(0, closeAngle + 1);
            wrapperClose = '</div>';
        }

        let newHtml = wrapperOpen + expandedNew + wrapperClose;

        // Add/update "Edited by Beaver" footer
        const threadId = store.get(currentThreadIdAtom);
        if (threadId) {
            newHtml = addOrUpdateEditFooter(newHtml, threadId);
        }

        // Rebuild data-citation-items, preserving pre-edit itemData so
        // citations to foreign/unresolved URIs don't lose their labels.
        newHtml = rebuildDataCitationItems(newHtml, existingCitationCache);

        // Wrapper div protection
        const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
        if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: 'The note wrapper <div data-schema-version="..."> must not be removed.',
                error_code: 'wrapper_removed',
            };
        }

        // Checkpoint before save
        checkAborted(ctx, 'edit_note:before_save');

        // Save
        try {
            assertNoPreviewMarkers(newHtml, 'editNote:rewrite:apply');
            item.setNote(newHtml);
            await item.saveTx();
            logger(`executeEditNoteAction: Saved rewrite edit to ${noteId}`, 1);
        } catch (error) {
            try {
                assertNoPreviewMarkers(oldHtml, 'editNote:rewrite:rollback');
                item.setNote(oldHtml);
            } catch (_) { /* best-effort */ }
            if (error instanceof TimeoutError) throw error;
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Failed to save note: ${error}`,
                error_code: 'save_failed',
            };
        }

        await waitForNoteSaveStabilization(item, newHtml);
        clearNoteEditorSelection(library_id, zotero_key);
        invalidateSimplificationCache(noteId);

        // Check for duplicate citation warnings
        const duplicateWarning = checkDuplicateCitations(new_string, metadata);
        const warnings = duplicateWarning ? [duplicateWarning] : undefined;

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: {
                library_id,
                zotero_key,
                occurrences_replaced: 1,
                warnings,
                undo_full_html: strippedHtml,
            },
        };
    }

    // ── String replacement mode (default) ──

    // 5b. Defense-in-depth: validator normally already enriched, re-run for
    //     skipped/stale validation paths. See applyOldStringEnrichment.
    old_string = applyOldStringEnrichment(old_string, metadata);

    // 6. Normalize + strip data-citation-items from raw HTML for matching.
    //    Snapshot the cache first so rebuild can preserve itemData for URIs
    //    that don't resolve in the current library.
    const normalizedOldHtml = normalizeNoteHtml(oldHtml);
    const existingCitationCache = extractDataCitationItems(normalizedOldHtml);
    const strippedHtml = stripDataCitationItems(normalizedOldHtml);

    // 7. Base expansion for the ranked matcher. Mutation-style strategies
    //    (trim, json_unescape, partial_strip, spurious_wrap) re-expand their
    //    own rewritten strings; the base failing here is fatal.
    const matchInput: MatchInput = {
        oldString: old_string ?? '',
        newString: new_string,
        operation,
        metadata,
        simplified,
        strippedHtml,
        externalRefContext,
    };
    let base: BaseExpansion;
    try {
        base = expandBase(matchInput);
    } catch (e: any) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: e.message || String(e),
            error_code: 'expansion_failed',
        };
    }

    // 8. Run the ranked matcher. Defense-in-depth: validator normally
    //    normalizes via normalized_action_data, but the note may have drifted
    //    between validation and execution (PM re-normalization, concurrent
    //    edit) so we re-match here against the current HTML.
    const match = findBestMatch(matchInput, base);
    if (!match) {
        const hint = buildExecutionZeroMatchHint(simplified, old_string ?? '');
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: hint.message,
            error_code: 'old_string_not_found',
            ...(hint.candidates.length > 0
                ? { error_candidates: hint.candidates }
                : {}),
        };
    }

    // 8a. Transform validator-supplied context anchors the same way the
    //     matcher transformed the haystack needle (entity decode/encode, NFKC).
    //     Mutation-style strategies use identity, so this is a no-op for them.
    if (target_before_context != null) target_before_context = match.normalizeAnchor(target_before_context);
    if (target_after_context != null) target_after_context = match.normalizeAnchor(target_after_context);

    const expandedOld = match.expandedOld;
    const expandedNew = match.expandedNew;
    const matchCount = match.matchCount;

    // 9. Perform replacement and capture context
    let newHtml: string;
    let undoBeforeContext: string | undefined;
    let undoAfterContext: string | undefined;
    let undoOccurrenceContexts: Array<{ before: string; after: string }> | undefined;
    const UNDO_CONTEXT_LENGTH = 200;
    let replacementCount: number;
    let editPos = -1; // Position of the edit in strippedHtml (single-occurrence only)

    if (operation === 'str_replace_all') {
        replacementCount = matchCount;

        // Capture per-occurrence context anchors before replacing
        undoOccurrenceContexts = [];
        let searchFrom = 0;
        while (true) {
            const idx = strippedHtml.indexOf(expandedOld, searchFrom);
            if (idx === -1) break;
            undoOccurrenceContexts.push({
                before: strippedHtml.substring(Math.max(0, idx - UNDO_CONTEXT_LENGTH), idx),
                after: strippedHtml.substring(
                    idx + expandedOld.length,
                    idx + expandedOld.length + UNDO_CONTEXT_LENGTH
                ),
            });
            searchFrom = idx + expandedOld.length;
        }
        newHtml = strippedHtml.split(expandedOld).join(expandedNew);
    } else {
        replacementCount = 1;
        let rawPos = -1;

        // When expandedOld matches multiple times in raw HTML (e.g. duplicate citations),
        // first use the conservative matcher, then fall back to the exact target
        // context captured during validation.
        if (matchCount > 1) {
            rawPos = resolveEditTargetAtRuntime({
                strippedHtml, simplified,
                oldString: old_string ?? '',
                expandedOld,
                metadata,
                targetBeforeContext: target_before_context,
                targetAfterContext: target_after_context,
            }).rawPosition;
        }

        // Single raw match or disambiguation succeeded
        if (rawPos === -1) {
            if (matchCount > 1) {
                return {
                    type: 'agent_action_execute_response',
                    request_id: request.request_id,
                    success: false,
                    error: buildAmbiguousMatchError(matchCount),
                    error_code: 'ambiguous_match',
                };
            }
            rawPos = strippedHtml.indexOf(expandedOld);
        }

        // Capture surrounding context for robust undo of single-occurrence edits.
        undoBeforeContext = strippedHtml.substring(Math.max(0, rawPos - UNDO_CONTEXT_LENGTH), rawPos);
        const afterStart = rawPos + expandedOld.length;
        undoAfterContext = strippedHtml.substring(afterStart, afterStart + UNDO_CONTEXT_LENGTH);

        newHtml = strippedHtml.substring(0, rawPos) + expandedNew
            + strippedHtml.substring(afterStart);
        editPos = rawPos;
    }

    // 10b. Add/update "Edited by Beaver" footer
    const threadId = store.get(currentThreadIdAtom);
    if (threadId) {
        newHtml = addOrUpdateEditFooter(newHtml, threadId);
    }

    // 11. Rebuild data-citation-items, preserving pre-edit itemData so
    //     citations to foreign/unresolved URIs don't lose their labels.
    newHtml = rebuildDataCitationItems(newHtml, existingCitationCache);

    // 12. Wrapper div protection — only error if the edit removed it
    const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
    if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'The note wrapper <div data-schema-version="..."> must not be removed.',
            error_code: 'wrapper_removed',
        };
    }

    // 12b. Recapture undo contexts from the post-edit, post-footer stripped HTML.
    // The initial capture (from pre-edit strippedHtml at step 9) may be stale
    // because addOrUpdateEditFooter inserts/moves content before </div>, causing
    // the after-context to diverge from what the note actually contains after saving.
    // The edit position is unchanged since the footer is appended at the end.
    if (editPos !== -1 && undoBeforeContext !== undefined) {
        const postEditStripped = stripDataCitationItems(newHtml);
        const posInNew = editPos + expandedNew.length;
        undoBeforeContext = postEditStripped.substring(
            Math.max(0, editPos - UNDO_CONTEXT_LENGTH), editPos);
        undoAfterContext = postEditStripped.substring(
            posInNew, posInNew + UNDO_CONTEXT_LENGTH);
    }

    // 13. Checkpoint before save
    checkAborted(ctx, 'edit_note:before_save');

    // 14. Save
    try {
        assertNoPreviewMarkers(newHtml, 'editNote:strReplace:apply');
        item.setNote(newHtml);
        await item.saveTx();
        logger(`executeEditNoteAction: Saved note edit to ${noteId} (${replacementCount} occurrence(s) replaced)`, 1);
    } catch (error) {
        // Restore in-memory state on save failure
        try {
            assertNoPreviewMarkers(oldHtml, 'editNote:strReplace:rollback');
            item.setNote(oldHtml);
        } catch (_) {
            // Best-effort restoration
        }
        if (error instanceof TimeoutError) throw error;
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Failed to save note: ${error}`,
            error_code: 'save_failed',
        };
    }

    // 14b. Wait for the note to stabilize after save.
    // saveTx() fires a Notifier event. When the note is open in an editor,
    // ProseMirror receives the Notifier, normalizes the HTML (e.g. entity
    // decoding, structural cleanup), and may save back a modified version
    // via item.setNote() + item.saveTx().  This async save-back can
    // overwrite a subsequent edit's save if it lands between two edits.
    // Poll item.getNote() until it stops changing so the next queued edit
    // reads the stabilized (PM-normalized) HTML as its base.
    await waitForNoteSaveStabilization(item, newHtml);

    // 15. Clear editor selection so it doesn't shift to unrelated text
    clearNoteEditorSelection(library_id, zotero_key);

    // 16. Invalidate cache
    invalidateSimplificationCache(noteId);

    // 17. Check for duplicate citation warnings
    const duplicateWarning = checkDuplicateCitations(new_string, metadata);
    const warnings = duplicateWarning ? [duplicateWarning] : undefined;

    // 18. Wait for ProseMirror to normalize the note and update undo data.
    // When the note is open in the editor, PM re-normalizes after saveTx(),
    // which can change the HTML structure (e.g. inline styles → semantic elements).
    // Without this, undo_new_html becomes stale and undo fails.
    // Note: waitForNoteSaveStabilization above ensures PM's save-back is
    // complete, so this reads the final PM-normalized HTML.
    const undoData = {
        undo_new_html: expandedNew,
        undo_before_context: undoBeforeContext,
        undo_after_context: undoAfterContext,
    };
    const savedStrippedHtml = stripDataCitationItems(newHtml);
    await waitForPMNormalization(item, savedStrippedHtml, undoData, strippedHtml);

    return {
        type: 'agent_action_execute_response',
        request_id: request.request_id,
        success: true,
        result_data: {
            library_id,
            zotero_key,
            occurrences_replaced: replacementCount,
            warnings,
            undo_old_html: expandedOld,
            undo_new_html: undoData.undo_new_html,
            undo_before_context: undoData.undo_before_context,
            undo_after_context: undoData.undo_after_context,
            undo_occurrence_contexts: undoOccurrenceContexts,
        },
    };
}

export { validateEditNoteAction, executeEditNoteAction };
