import { logger } from '../../../utils/logger';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { EditNoteProposedData, type EditNoteOperation } from '../../../../react/types/agentActions/editNote';
import {
    getOrSimplify,
    expandToRawHtml,
    stripDataCitationItems,
    rebuildDataCitationItems,
    countOccurrences,
    getLatestNoteHtml,
    invalidateSimplificationCache,
    checkDuplicateCitations,
    findFuzzyMatch,
    validateNewString,
    checkNewCitationItemsExist,
    findUniqueRawMatchPosition,
    captureValidatedEditTargetContext,
    findTargetRawMatchPosition,
    preloadPageLabelsForNewCitations,
    waitForPMNormalization,
    waitForNoteSaveStabilization,
    hasSchemaVersionWrapper,
    decodeHtmlEntities,
    encodeTextEntities,
    ENTITY_FORMS,
    stripPartialSimplifiedElements,
    stripNoteWrapperDiv,
    stripSpuriousWrappingTags,
    findRangeByContexts,
} from '../../../utils/noteHtmlSimplifier';
import { clearNoteEditorSelection } from '../../../../react/utils/sourceUtils';
import { store } from '../../../../react/store';
import { currentThreadIdAtom } from '../../../../react/atoms/threads';
import { addOrUpdateEditFooter } from '../../../utils/noteEditFooter';
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
 * Validate an edit_note action.
 * Checks the note exists, is editable, not in editor, and performs a dry-run
 * expansion + match to verify the replacement will succeed.
 */
async function validateEditNoteAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { library_id, zotero_key, old_string, new_string, operation: rawOp } = request.action_data as EditNoteProposedData;
    const operation: EditNoteOperation = rawOp ?? 'str_replace';

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

    // ── rewrite mode: skip old_string matching, validate new_string only ──
    if (operation === 'rewrite') {
        // Validate new_string tags
        const validationError = validateNewString(new_string, metadata);
        if (validationError) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: validationError,
                error_code: 'invalid_new_string',
                preference: 'always_ask',
            };
        }

        // Check new citation items exist
        const citationError = checkNewCitationItemsExist(new_string, metadata);
        if (citationError) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: citationError,
                error_code: 'citation_item_not_found',
                preference: 'always_ask',
            };
        }

        // Dry-run expand new_string only
        try {
            expandToRawHtml(new_string, metadata, 'new');
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

    // 9. Strings different (skip for insert_after — old_string is kept, new_string is appended)
    if (operation !== 'insert_after' && old_string === new_string) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'old_string and new_string are identical.',
            error_code: 'no_changes',
            preference: 'always_ask',
        };
    }

    // 10. Validate new_string tags
    const validationError = validateNewString(new_string, metadata);
    if (validationError) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: validationError,
            error_code: 'invalid_new_string',
            preference: 'always_ask',
        };
    }

    // 10b. Check new citation items exist
    const citationError = checkNewCitationItemsExist(new_string, metadata);
    if (citationError) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: citationError,
            error_code: 'citation_item_not_found',
            preference: 'always_ask',
        };
    }

    // 11. Dry-run expansion
    let expandedOld: string;
    let expandedNew: string;
    try {
        expandedOld = expandToRawHtml(old_string ?? '', metadata, 'old');
        expandedNew = expandToRawHtml(new_string, metadata, 'new');
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

    // 12. Count occurrences — if zero, retry with entity-decoded or entity-encoded
    // strings. PM may have decoded entities (&#x27; → ') since the model read the
    // note, or the model may have used literal chars while the note has entities.
    const strippedHtml = stripDataCitationItems(rawHtml);
    let matchCount = countOccurrences(strippedHtml, expandedOld);
    if (matchCount === 0) {
        // Forward: model used &#x27; but note has ' (PM decoded)
        const decodedOld = decodeHtmlEntities(expandedOld);
        if (decodedOld !== expandedOld && countOccurrences(strippedHtml, decodedOld) > 0) {
            expandedOld = decodedOld;
            expandedNew = decodeHtmlEntities(expandedNew);
            matchCount = countOccurrences(strippedHtml, expandedOld);
        }
    }
    if (matchCount === 0) {
        // Reverse: model used ' but note has entity-encoded form (pre-PM).
        for (const form of ENTITY_FORMS) {
            const encodedOld = encodeTextEntities(expandedOld, form);
            if (encodedOld !== expandedOld && countOccurrences(strippedHtml, encodedOld) > 0) {
                expandedOld = encodedOld;
                expandedNew = encodeTextEntities(expandedNew, form);
                matchCount = countOccurrences(strippedHtml, expandedOld);
                break;
            }
        }
    }

    // 13. Zero matches — try stripping partial simplified-element fragments.
    //     The model may include e.g. "/>" (tail of a <citation…/>) in old_string.
    //     These fragments don't expand to raw HTML, but the text portion does.
    //     Gate: old_string must appear exactly once in simplified HTML.
    if (matchCount === 0) {
        const simplifiedPos = simplified.indexOf(old_string ?? '');
        const isUnique = simplifiedPos !== -1
            && simplified.indexOf(old_string ?? '', simplifiedPos + 1) === -1;

        if (isUnique) {
            const stripped = stripPartialSimplifiedElements(
                old_string ?? '', new_string, simplified, simplifiedPos,
            );
            if (stripped) {
                try {
                    expandedOld = expandToRawHtml(stripped.strippedOld, metadata, 'old');
                    expandedNew = expandToRawHtml(stripped.strippedNew, metadata, 'new');
                    matchCount = countOccurrences(strippedHtml, expandedOld);
                } catch {
                    // expansion failed — fall through to fuzzy error
                }

                if (matchCount >= 1) {
                    // Build normalized_action_data with the stripped strings
                    const normalizedActionData: EditNoteProposedData = {
                        ...request.action_data as EditNoteProposedData,
                        old_string: stripped.strippedOld,
                        new_string: operation === 'insert_after'
                            ? stripped.strippedOld + stripped.strippedNew
                            : stripped.strippedNew,
                    };

                    if (matchCount > 1 && operation !== 'str_replace_all') {
                        // Disambiguate: we know old_string's unique position in simplified.
                        // The stripped text starts at simplifiedPos + leadingStrip.
                        // Expand simplified[0..strippedStart] to compute the raw position.
                        const strippedStart = simplifiedPos + stripped.leadingStrip;
                        let disambiguated = false;
                        try {
                            const expandedBefore = expandToRawHtml(
                                simplified.substring(0, strippedStart), metadata, 'old',
                            );
                            const unwrapped = stripNoteWrapperDiv(strippedHtml);
                            const wrapperPrefixLen = unwrapped !== strippedHtml
                                ? strippedHtml.indexOf('>') + 1 : 0;
                            const rawPos = wrapperPrefixLen + expandedBefore.length;

                            if (strippedHtml.substring(rawPos, rawPos + expandedOld.length) === expandedOld) {
                                normalizedActionData.target_before_context = strippedHtml.substring(
                                    Math.max(0, rawPos - 200), rawPos,
                                );
                                normalizedActionData.target_after_context = strippedHtml.substring(
                                    rawPos + expandedOld.length,
                                    rawPos + expandedOld.length + 200,
                                );
                                disambiguated = true;
                            }
                        } catch {
                            // prefix expansion failed
                        }

                        if (!disambiguated) {
                            // Can't disambiguate — report ambiguous match on stripped string
                            matchCount = 0; // fall through to fuzzy below
                        }
                    }

                    if (matchCount >= 1) {
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
                                match_count: matchCount,
                            },
                            normalized_action_data: normalizedActionData,
                            preference,
                        };
                    }
                }
            }
        }
    }

    // 13a. Zero matches — try stripping spurious leading/trailing HTML tags.
    //      LLMs tend to wrap old_string/new_string in matching tags (e.g. <p>…</p>)
    //      to produce well-formed HTML, even when the selection starts mid-element.
    //      Candidates are ordered to strip the least first (leading-only, then
    //      trailing-only, then both) so we keep as much structural context as possible.
    if (matchCount === 0) {
        const tagCandidates = stripSpuriousWrappingTags(old_string ?? '', new_string);
        for (const tagStrip of tagCandidates) {
            try {
                const tagExpandedOld = expandToRawHtml(tagStrip.strippedOld, metadata, 'old');
                // Dry-run expand new_string to verify it's valid
                expandToRawHtml(tagStrip.strippedNew, metadata, 'new');
                const tagMatchCount = countOccurrences(strippedHtml, tagExpandedOld);

                if (tagMatchCount >= 1) {
                    const normalizedActionData: EditNoteProposedData = {
                        ...request.action_data as EditNoteProposedData,
                        old_string: tagStrip.strippedOld,
                        new_string: operation === 'insert_after'
                            ? tagStrip.strippedOld + tagStrip.strippedNew
                            : tagStrip.strippedNew,
                    };

                    let disambiguated = true;
                    if (tagMatchCount > 1 && operation !== 'str_replace_all') {
                        disambiguated = false;
                        const rawPos = findUniqueRawMatchPosition(
                            strippedHtml, simplified, tagStrip.strippedOld,
                            tagExpandedOld, metadata,
                        );
                        if (rawPos !== null) {
                            disambiguated = true;
                        } else {
                            const targetContext = captureValidatedEditTargetContext(
                                strippedHtml, simplified, tagStrip.strippedOld,
                                tagExpandedOld, metadata,
                            );
                            if (targetContext) {
                                normalizedActionData.target_before_context =
                                    targetContext.beforeContext;
                                normalizedActionData.target_after_context =
                                    targetContext.afterContext;
                                disambiguated = true;
                            }
                        }
                    }

                    if (disambiguated) {
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
                                match_count: tagMatchCount,
                            },
                            normalized_action_data: normalizedActionData,
                            preference,
                        };
                    }
                }
            } catch {
                // expansion failed for this candidate — try next
            }
        }
    }

    // 13b. Zero matches — fuzzy match on simplified HTML
    if (matchCount === 0) {
        const fuzzy = findFuzzyMatch(simplified, old_string ?? '');
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'The string to replace was not found in the note.'
                + (fuzzy ? ` Found a possible fuzzy match:\n\`\`\`\n${fuzzy}\n\`\`\`` : ''),
            error_code: 'old_string_not_found',
            preference: 'always_ask',
        };
    }

    // 14. Multiple matches without str_replace_all — accept only when the match is
    //     either uniquely identifiable without relying on ref stability, or
    //     can be captured now and re-located later via surrounding context.
    if (matchCount > 1 && operation !== 'str_replace_all') {
        const rawPos = findUniqueRawMatchPosition(
            strippedHtml, simplified, old_string ?? '', expandedOld, metadata
        );
        let normalizedActionData: EditNoteProposedData | undefined;

        if (rawPos === null) {
            const targetContext = captureValidatedEditTargetContext(
                strippedHtml, simplified, old_string ?? '', expandedOld, metadata
            );

            if (targetContext) {
                normalizedActionData = {
                    ...request.action_data as EditNoteProposedData,
                    target_before_context: targetContext.beforeContext,
                    target_after_context: targetContext.afterContext,
                };
            }
        }

        if (rawPos === null && normalizedActionData === undefined) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `The string to replace was found ${matchCount} times in the note. `
                    + 'Use operation str_replace_all to replace all occurrences, or include more context to make the match unique.',
                error_code: 'ambiguous_match',
                preference: 'always_ask',
            };
        }

        // insert_after normalization: prepend old_string to new_string so execution
        // can treat it as a regular str_replace.
        if (operation === 'insert_after') {
            if (!normalizedActionData) {
                normalizedActionData = { ...request.action_data as EditNoteProposedData };
            }
            normalizedActionData.new_string = (normalizedActionData.old_string ?? old_string ?? '') + new_string;
        }

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
                match_count: matchCount,
            },
            normalized_action_data: normalizedActionData,
            preference,
        };
    }

    // 15. insert_after normalization: prepend old_string to new_string so
    //     execution can treat it as a regular str_replace.
    let normalizedActionData: EditNoteProposedData | undefined;
    if (operation === 'insert_after') {
        normalizedActionData = {
            ...request.action_data as EditNoteProposedData,
            new_string: (old_string ?? '') + new_string,
        };
    }

    // 16. Valid — return current value
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
            match_count: matchCount,
        },
        normalized_action_data: normalizedActionData,
        preference,
    };
}


/**
 * Execute an edit_note action.
 * Performs the string replacement on the note's raw HTML via the simplified format.
 */
async function executeEditNoteAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const {
        library_id,
        zotero_key,
        old_string,
        new_string,
        operation: rawOp,
    } = request.action_data as EditNoteProposedData;
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

    // 3. Pre-load page labels so new citations resolve page indices to labels.
    //    Done before reading the note to avoid async gaps between read and write.
    await preloadPageLabelsForNewCitations(new_string, ctx.signal);
    checkAborted(ctx, 'edit_note:after_preload');

    // 4. Get current note HTML (kept for rollback on save failure)
    //    Avoid async operations between here and item.setNote() to preserve atomicity.
    const oldHtml = getLatestNoteHtml(item);

    // 5. Get metadata from cache or re-simplify
    const noteId = `${library_id}-${zotero_key}`;
    const { simplified, metadata } = getOrSimplify(noteId, oldHtml, library_id);

    // ── rewrite mode: replace entire note body ──
    if (operation === 'rewrite') {
        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(new_string, metadata, 'new');
        } catch (e: any) {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: e.message || String(e),
                error_code: 'expansion_failed',
            };
        }

        const strippedHtml = stripDataCitationItems(oldHtml);

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

        // Rebuild data-citation-items
        newHtml = rebuildDataCitationItems(newHtml);

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
            item.setNote(newHtml);
            await item.saveTx();
            logger(`executeEditNoteAction: Saved rewrite edit to ${noteId}`, 1);
        } catch (error) {
            try { item.setNote(oldHtml); } catch (_) { /* best-effort */ }
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

    // 6. Expand old_string and new_string to raw HTML
    let expandedOld: string;
    let expandedNew: string;
    try {
        expandedOld = expandToRawHtml(old_string ?? '', metadata, 'old');
        expandedNew = expandToRawHtml(new_string, metadata, 'new');
    } catch (e: any) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: e.message || String(e),
            error_code: 'expansion_failed',
        };
    }

    // 6b. Strip data-citation-items from raw HTML for matching
    const strippedHtml = stripDataCitationItems(oldHtml);

    // 7. Count occurrences — if zero, retry with entity-decoded or entity-encoded
    // strings. PM may have decoded entities (&#x27; → ') since the model read the
    // note, or the model may have used literal chars while the note has entities.
    let matchCount = countOccurrences(strippedHtml, expandedOld);
    if (matchCount === 0) {
        // Forward: model used &#x27; but note has ' (PM decoded)
        const decodedOld = decodeHtmlEntities(expandedOld);
        if (decodedOld !== expandedOld && countOccurrences(strippedHtml, decodedOld) > 0) {
            expandedOld = decodedOld;
            expandedNew = decodeHtmlEntities(expandedNew);
            if (target_before_context != null) target_before_context = decodeHtmlEntities(target_before_context);
            if (target_after_context != null) target_after_context = decodeHtmlEntities(target_after_context);
            matchCount = countOccurrences(strippedHtml, expandedOld);
        }
    }
    if (matchCount === 0) {
        // Reverse: model used ' but note has entity-encoded form (pre-PM).
        // Try all common entity spellings (&#x27;, &#39;, &apos;).
        for (const form of ENTITY_FORMS) {
            const encodedOld = encodeTextEntities(expandedOld, form);
            if (encodedOld !== expandedOld && countOccurrences(strippedHtml, encodedOld) > 0) {
                expandedOld = encodedOld;
                expandedNew = encodeTextEntities(expandedNew, form);
                if (target_before_context != null) target_before_context = encodeTextEntities(target_before_context, form);
                if (target_after_context != null) target_after_context = encodeTextEntities(target_after_context, form);
                matchCount = countOccurrences(strippedHtml, expandedOld);
                break;
            }
        }
    }

    // 8. Zero matches — try stripping partial simplified-element fragments
    //    (defense-in-depth: validation normally normalizes via normalized_action_data,
    //     but the note may have changed between validation and execution)
    if (matchCount === 0) {
        const simplifiedPos = simplified.indexOf(old_string ?? '');
        const isUnique = simplifiedPos !== -1
            && simplified.indexOf(old_string ?? '', simplifiedPos + 1) === -1;

        if (isUnique) {
            const stripped = stripPartialSimplifiedElements(
                old_string ?? '', new_string, simplified, simplifiedPos,
            );
            if (stripped) {
                try {
                    expandedOld = expandToRawHtml(stripped.strippedOld, metadata, 'old');
                    expandedNew = expandToRawHtml(stripped.strippedNew, metadata, 'new');
                    matchCount = countOccurrences(strippedHtml, expandedOld);
                } catch {
                    // expansion failed — fall through to fuzzy error
                }
            }
        }
    }

    // 8a. Zero matches — try stripping spurious wrapping tags
    //     (defense-in-depth: validation normally normalizes via normalized_action_data)
    if (matchCount === 0) {
        const tagCandidates = stripSpuriousWrappingTags(old_string ?? '', new_string);
        for (const tagStrip of tagCandidates) {
            try {
                const candidateOld = expandToRawHtml(tagStrip.strippedOld, metadata, 'old');
                const candidateNew = expandToRawHtml(tagStrip.strippedNew, metadata, 'new');
                const candidateCount = countOccurrences(strippedHtml, candidateOld);
                if (candidateCount >= 1) {
                    expandedOld = candidateOld;
                    expandedNew = candidateNew;
                    matchCount = candidateCount;
                    break;
                }
            } catch {
                // expansion failed for this candidate — try next
            }
        }
    }

    // 8b. Still zero matches — fuzzy error
    if (matchCount === 0) {
        const fuzzy = findFuzzyMatch(simplified, old_string ?? '');
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'The string to replace was not found in the note.'
                + (fuzzy ? ` Found a possible fuzzy match:\n\`\`\`\n${fuzzy}\n\`\`\`` : ''),
            error_code: 'old_string_not_found',
        };
    }

    // 9. Perform replacement and capture context
    let newHtml: string;
    let undoBeforeContext: string | undefined;
    let undoAfterContext: string | undefined;
    let undoOccurrenceContexts: Array<{ before: string; after: string }> | undefined;
    const UNDO_CONTEXT_LENGTH = 200;
    let replacementCount: number;

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
            rawPos = findUniqueRawMatchPosition(
                strippedHtml, simplified, old_string ?? '', expandedOld, metadata
            ) ?? -1;
            if (rawPos === -1 && (
                target_before_context !== undefined || target_after_context !== undefined
            )) {
                rawPos = findTargetRawMatchPosition(
                    strippedHtml,
                    expandedOld,
                    target_before_context,
                    target_after_context
                ) ?? -1;
            }
        }

        // Single raw match or disambiguation succeeded
        if (rawPos === -1) {
            if (matchCount > 1) {
                return {
                    type: 'agent_action_execute_response',
                    request_id: request.request_id,
                    success: false,
                    error: `The string to replace was found ${matchCount} times in the note. `
                        + 'Use operation str_replace_all to replace all occurrences, or include more context.',
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
    }

    // 10b. Add/update "Edited by Beaver" footer
    const threadId = store.get(currentThreadIdAtom);
    if (threadId) {
        newHtml = addOrUpdateEditFooter(newHtml, threadId);
    }

    // 11. Rebuild data-citation-items
    newHtml = rebuildDataCitationItems(newHtml);

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

    // 13. Checkpoint before save
    checkAborted(ctx, 'edit_note:before_save');

    // 14. Save
    try {
        item.setNote(newHtml);
        await item.saveTx();
        logger(`executeEditNoteAction: Saved note edit to ${noteId} (${replacementCount} occurrence(s) replaced)`, 1);
    } catch (error) {
        // Restore in-memory state on save failure
        try {
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

// =============================================================================
// Batch Execution — apply N edits to the same note in one save
// =============================================================================

/**
 * Result for a single edit within a batch.
 * Each edit gets its own response so the backend can report per-toolcall results.
 */
interface BatchEditResult {
    request: WSAgentActionExecuteRequest;
    response: WSAgentActionExecuteResponse;
}

/**
 * Apply a single str_replace/str_replace_all/insert_after edit to the in-memory
 * HTML string. Returns the updated HTML on success, or null + error response on
 * failure.
 *
 * This is a pure-string operation — no saving, no PM interaction.
 * Extracted from executeEditNoteAction so that batch execution can call it
 * in a loop on the same HTML string.
 */
function applySingleEditToHtml(
    request: WSAgentActionExecuteRequest,
    currentHtml: string,
    libraryId: number,
    noteId: string,
): { newHtml: string; resultData: Record<string, any> } | { error: WSAgentActionExecuteResponse } {
    const {
        old_string,
        new_string,
        operation: rawOp,
    } = request.action_data as EditNoteProposedData;
    const operation: EditNoteOperation = rawOp ?? 'str_replace';
    let {
        target_before_context,
        target_after_context,
    } = request.action_data as EditNoteProposedData;

    // Simplify (cheap in-memory operation — no PM involved)
    const { simplified, metadata } = getOrSimplify(noteId, currentHtml, libraryId);

    // Expand old_string and new_string to raw HTML
    let expandedOld: string;
    let expandedNew: string;
    try {
        expandedOld = expandToRawHtml(old_string ?? '', metadata, 'old');
        expandedNew = expandToRawHtml(new_string, metadata, 'new');
    } catch (e: any) {
        return {
            error: {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: e.message || String(e),
                error_code: 'expansion_failed',
            },
        };
    }

    // Strip data-citation-items for matching
    const strippedHtml = stripDataCitationItems(currentHtml);

    // Count occurrences — with entity fallbacks
    let matchCount = countOccurrences(strippedHtml, expandedOld);
    if (matchCount === 0) {
        const decodedOld = decodeHtmlEntities(expandedOld);
        if (decodedOld !== expandedOld && countOccurrences(strippedHtml, decodedOld) > 0) {
            expandedOld = decodedOld;
            expandedNew = decodeHtmlEntities(expandedNew);
            if (target_before_context != null) target_before_context = decodeHtmlEntities(target_before_context);
            if (target_after_context != null) target_after_context = decodeHtmlEntities(target_after_context);
            matchCount = countOccurrences(strippedHtml, expandedOld);
        }
    }
    if (matchCount === 0) {
        for (const form of ENTITY_FORMS) {
            const encodedOld = encodeTextEntities(expandedOld, form);
            if (encodedOld !== expandedOld && countOccurrences(strippedHtml, encodedOld) > 0) {
                expandedOld = encodedOld;
                expandedNew = encodeTextEntities(expandedNew, form);
                if (target_before_context != null) target_before_context = encodeTextEntities(target_before_context, form);
                if (target_after_context != null) target_after_context = encodeTextEntities(target_after_context, form);
                matchCount = countOccurrences(strippedHtml, expandedOld);
                break;
            }
        }
    }

    // Partial element stripping fallback
    if (matchCount === 0) {
        const simplifiedPos = simplified.indexOf(old_string ?? '');
        const isUnique = simplifiedPos !== -1
            && simplified.indexOf(old_string ?? '', simplifiedPos + 1) === -1;

        if (isUnique) {
            const stripped = stripPartialSimplifiedElements(
                old_string ?? '', new_string, simplified, simplifiedPos,
            );
            if (stripped) {
                try {
                    expandedOld = expandToRawHtml(stripped.strippedOld, metadata, 'old');
                    expandedNew = expandToRawHtml(stripped.strippedNew, metadata, 'new');
                    matchCount = countOccurrences(strippedHtml, expandedOld);
                } catch {
                    // fall through
                }
            }
        }
    }

    // Spurious tag stripping fallback
    if (matchCount === 0) {
        const tagCandidates = stripSpuriousWrappingTags(old_string ?? '', new_string);
        for (const tagStrip of tagCandidates) {
            try {
                const candidateOld = expandToRawHtml(tagStrip.strippedOld, metadata, 'old');
                expandToRawHtml(tagStrip.strippedNew, metadata, 'new');
                const candidateCount = countOccurrences(strippedHtml, candidateOld);
                if (candidateCount >= 1) {
                    expandedOld = candidateOld;
                    expandedNew = expandToRawHtml(tagStrip.strippedNew, metadata, 'new');
                    matchCount = candidateCount;
                    break;
                }
            } catch {
                // try next candidate
            }
        }
    }

    // Still zero matches — error
    if (matchCount === 0) {
        const fuzzy = findFuzzyMatch(simplified, old_string ?? '');
        return {
            error: {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: 'The string to replace was not found in the note.'
                    + (fuzzy ? ` Found a possible fuzzy match:\n\`\`\`\n${fuzzy}\n\`\`\`` : ''),
                error_code: 'old_string_not_found',
            },
        };
    }

    // Perform replacement
    let newHtml: string;
    let undoBeforeContext: string | undefined;
    let undoAfterContext: string | undefined;
    let undoOccurrenceContexts: Array<{ before: string; after: string }> | undefined;
    const UNDO_CONTEXT_LENGTH = 200;
    let replacementCount: number;

    if (operation === 'str_replace_all') {
        replacementCount = matchCount;
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

        if (matchCount > 1) {
            rawPos = findUniqueRawMatchPosition(
                strippedHtml, simplified, old_string ?? '', expandedOld, metadata
            ) ?? -1;
            if (rawPos === -1 && (
                target_before_context !== undefined || target_after_context !== undefined
            )) {
                rawPos = findTargetRawMatchPosition(
                    strippedHtml,
                    expandedOld,
                    target_before_context,
                    target_after_context
                ) ?? -1;
            }
        }

        if (rawPos === -1) {
            if (matchCount > 1) {
                return {
                    error: {
                        type: 'agent_action_execute_response',
                        request_id: request.request_id,
                        success: false,
                        error: `The string to replace was found ${matchCount} times in the note. `
                            + 'Use operation str_replace_all to replace all occurrences, or include more context.',
                        error_code: 'ambiguous_match',
                    },
                };
            }
            rawPos = strippedHtml.indexOf(expandedOld);
        }

        undoBeforeContext = strippedHtml.substring(Math.max(0, rawPos - UNDO_CONTEXT_LENGTH), rawPos);
        const afterStart = rawPos + expandedOld.length;
        undoAfterContext = strippedHtml.substring(afterStart, afterStart + UNDO_CONTEXT_LENGTH);

        newHtml = strippedHtml.substring(0, rawPos) + expandedNew
            + strippedHtml.substring(afterStart);
    }

    // Wrapper div protection
    const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
    if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
        return {
            error: {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: 'The note wrapper <div data-schema-version="..."> must not be removed.',
                error_code: 'wrapper_removed',
            },
        };
    }

    // Check for duplicate citation warnings
    const duplicateWarning = checkDuplicateCitations(new_string, metadata);
    const warnings = duplicateWarning ? [duplicateWarning] : undefined;

    return {
        newHtml,
        resultData: {
            library_id: libraryId,
            zotero_key: noteId.split('-').slice(1).join('-'),
            occurrences_replaced: replacementCount,
            warnings,
            undo_old_html: expandedOld,
            undo_new_html: expandedNew,
            undo_before_context: undoBeforeContext,
            undo_after_context: undoAfterContext,
            undo_occurrence_contexts: undoOccurrenceContexts,
        },
    };
}

/**
 * Execute a batch of edit_note actions on the same note.
 *
 * All edits are applied to the same in-memory HTML string, then saved once.
 * This avoids intermediate ProseMirror normalizations that can restructure
 * the HTML between edits, causing subsequent old_string matches to fail.
 *
 * Each edit gets its own response so the backend can track per-toolcall results.
 * Edits that fail (e.g., old_string not found) are skipped — remaining edits
 * still apply.
 */
async function executeBatchEditNoteActions(
    requests: WSAgentActionExecuteRequest[],
    ctx: TimeoutContext,
): Promise<BatchEditResult[]> {
    // All requests target the same note — extract from the first one
    const { library_id, zotero_key } = requests[0].action_data as EditNoteProposedData;
    const noteId = `${library_id}-${zotero_key}`;

    // 1. Load item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        return requests.map(req => ({
            request: req,
            response: {
                type: 'agent_action_execute_response' as const,
                request_id: req.request_id,
                success: false,
                error: `Item not found: ${noteId}`,
                error_code: 'item_not_found',
            },
        }));
    }

    // 2. Load note data
    await item.loadDataType('note');

    // 3. Pre-load page labels for all new citations across all edits
    for (const req of requests) {
        checkAborted(ctx, 'edit_note_batch:preload_citations');
        const { new_string } = req.action_data as EditNoteProposedData;
        await preloadPageLabelsForNewCitations(new_string, ctx.signal);
    }

    // 4. Get current note HTML
    const originalHtml = getLatestNoteHtml(item);
    let currentHtml = originalHtml;

    // 5. Apply each edit to the in-memory HTML
    const results: BatchEditResult[] = [];
    let anySucceeded = false;

    for (const req of requests) {
        checkAborted(ctx, 'edit_note_batch:apply_edit');
        const { operation: rawOp } = req.action_data as EditNoteProposedData;
        const operation: EditNoteOperation = rawOp ?? 'str_replace';

        // Defensive guard: rewrite operations should have been excluded from
        // batching at the agentService level. If one slips through, skip it
        // with an error — rewrite replaces the entire note body and conflicts
        // with other edits in the batch.
        if (operation === 'rewrite') {
            results.push({
                request: req,
                response: {
                    type: 'agent_action_execute_response',
                    request_id: req.request_id,
                    success: false,
                    error: 'Cannot batch a rewrite operation with other edits. '
                        + 'Rewrite replaces the entire note body.',
                    error_code: 'batch_rewrite_conflict',
                },
            });
            continue;
        }

        const editResult = applySingleEditToHtml(req, currentHtml, library_id, noteId);

        if ('error' in editResult) {
            results.push({ request: req, response: editResult.error });
        } else {
            // Success — advance currentHtml for the next edit
            currentHtml = editResult.newHtml;
            anySucceeded = true;
            results.push({
                request: req,
                response: {
                    type: 'agent_action_execute_response',
                    request_id: req.request_id,
                    success: true,
                    result_data: editResult.resultData,
                },
            });
        }

        // Invalidate simplification cache between edits so the next edit
        // re-simplifies based on the updated in-memory HTML.
        invalidateSimplificationCache(noteId);
    }

    // 6. Save once if any edit succeeded
    if (anySucceeded) {
        // Add/update "Edited by Beaver" footer
        const threadId = store.get(currentThreadIdAtom);
        if (threadId) {
            currentHtml = addOrUpdateEditFooter(currentHtml, threadId);
        }

        // Rebuild data-citation-items
        currentHtml = rebuildDataCitationItems(currentHtml);

        // Checkpoint before save
        checkAborted(ctx, 'edit_note_batch:before_save');

        try {
            item.setNote(currentHtml);
            await item.saveTx();
            logger(`executeBatchEditNoteActions: Saved ${results.filter(r => r.response.success).length} `
                + `edits to ${noteId} in one save`, 1);
        } catch (error) {
            // Restore original HTML on save failure
            try { item.setNote(originalHtml); } catch (_) { /* best-effort */ }
            if (error instanceof TimeoutError) throw error;

            // Mark previously-successful edits as save_failed, but preserve
            // the original error for edits that already failed (e.g.,
            // old_string_not_found, ambiguous_match) — those never reached
            // the save step and their error is the accurate reason.
            for (const entry of results) {
                if (entry.response.success) {
                    entry.response.success = false;
                    entry.response.error = `Failed to save note: ${error}`;
                    entry.response.error_code = 'save_failed';
                    entry.response.result_data = undefined;
                }
            }
            return results;
        }

        // 7. Wait for PM stabilization once
        await waitForNoteSaveStabilization(item, currentHtml);
        clearNoteEditorSelection(library_id, zotero_key);
        invalidateSimplificationCache(noteId);

        // 8. Wait for PM normalization and update undo data for ALL successful edits.
        //
        // After stabilization the HTML may have been rewritten by PM (entity
        // decoding, structural cleanup).  We need to refresh each successful
        // edit's undo_new_html so standalone undo still works.
        //
        // Strategy: use the first successful edit for the polling phase (it has
        // anchors closest to the original HTML), then read the final HTML once
        // and update every successful edit via findRangeByContexts.
        const savedStrippedHtml = stripDataCitationItems(currentHtml);
        const preEditStrippedHtml = stripDataCitationItems(originalHtml);

        // 8a. Run the polling phase once via waitForPMNormalization — this waits
        // until PM is done normalizing (or times out / sees no changes).
        //
        // We need a successful edit that has context anchors (undo_before_context
        // or undo_after_context) so that waitForPMNormalization can locate the
        // fragment in PM-normalized HTML.  str_replace_all edits intentionally
        // leave those anchors undefined, so using one would cause the helper to
        // return immediately and leave finalHtml stale.
        const anchoredSuccess = results.find(r =>
            r.response.success
            && r.response.result_data
            && (r.response.result_data.undo_before_context !== undefined
                || r.response.result_data.undo_after_context !== undefined)
        );
        if (anchoredSuccess?.response.result_data) {
            const pollUndoData = {
                undo_new_html: anchoredSuccess.response.result_data.undo_new_html,
                undo_before_context: anchoredSuccess.response.result_data.undo_before_context,
                undo_after_context: anchoredSuccess.response.result_data.undo_after_context,
            };
            await waitForPMNormalization(item, savedStrippedHtml, pollUndoData, preEditStrippedHtml);
        } else {
            // All successful edits are str_replace_all (no anchors).
            // Fall back to waitForNoteSaveStabilization which already ran,
            // so just give PM one more chance to settle.
            await waitForNoteSaveStabilization(item, currentHtml);
        }

        // 8b. Read the final PM-normalized HTML and update each successful edit's
        // undo data in-place.
        const finalHtml = getLatestNoteHtml(item);
        const finalStripped = stripDataCitationItems(finalHtml);
        const PM_UNDO_CONTEXT_LENGTH = 200;

        if (finalStripped !== savedStrippedHtml) {
            // PM changed the HTML — refresh undo data for every successful edit
            for (const entry of results) {
                const rd = entry.response.result_data;
                if (!entry.response.success || !rd?.undo_new_html) continue;

                const beforeCtx = rd.undo_before_context as string | undefined;
                const afterCtx = rd.undo_after_context as string | undefined;
                if (beforeCtx === undefined && afterCtx === undefined) continue;

                // Try original anchors, then entity-decoded anchors
                let range = findRangeByContexts(finalStripped, beforeCtx, afterCtx);
                if (!range) {
                    const decodedBefore = beforeCtx != null ? decodeHtmlEntities(beforeCtx) : undefined;
                    const decodedAfter = afterCtx != null ? decodeHtmlEntities(afterCtx) : undefined;
                    range = findRangeByContexts(finalStripped, decodedBefore, decodedAfter);
                }
                if (range) {
                    const actualFragment = finalStripped.substring(range.start, range.end);
                    if (actualFragment !== rd.undo_new_html) {
                        rd.undo_new_html = actualFragment;
                        rd.undo_before_context = finalStripped.substring(
                            Math.max(0, range.start - PM_UNDO_CONTEXT_LENGTH), range.start,
                        );
                        rd.undo_after_context = finalStripped.substring(
                            range.end, range.end + PM_UNDO_CONTEXT_LENGTH,
                        );
                    }
                } else {
                    logger(`executeBatchEditNoteActions: could not locate undo fragment for `
                        + `request ${entry.request.request_id} after PM normalization`, 1);
                }
            }
        }
    }

    return results;
}

export { validateEditNoteAction, executeEditNoteAction, executeBatchEditNoteActions };
