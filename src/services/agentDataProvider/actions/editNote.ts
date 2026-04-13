import { logger } from '../../../utils/logger';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { EditNoteProposedData, type EditNoteOperation } from '../../../../react/types/agentActions/editNote';
import {
    getOrSimplify,
    expandToRawHtml,
    stripDataCitationItems,
    extractDataCitationItems,
    rebuildDataCitationItems,
    countOccurrences,
    getLatestNoteHtml,
    invalidateSimplificationCache,
    checkDuplicateCitations,
    findFuzzyMatch,
    findStructuralAnchorHint,
    findInlineTagDriftMatch,
    validateNewString,
    checkNewCitationItemsExist,
    enrichOldStringCitationRefs,
    findUniqueRawMatchPosition,
    captureValidatedEditTargetContext,
    findTargetRawMatchPosition,
    preloadPageLabelsForNewCitations,
    waitForPMNormalization,
    waitForNoteSaveStabilization,
    flushLiveEditorToDB,
    hasSchemaVersionWrapper,
    decodeHtmlEntities,
    encodeTextEntities,
    ENTITY_FORMS,
    stripPartialSimplifiedElements,
    stripNoteWrapperDiv,
    stripSpuriousWrappingTags,
    normalizeNoteHtml,
    type ExternalRefContext,
} from '../../../utils/noteHtmlSimplifier';
import { clearNoteEditorSelection } from '../../../../react/utils/sourceUtils';
import { store } from '../../../../react/store';
import { currentThreadIdAtom } from '../../../../react/atoms/threads';
import {
    externalReferenceMappingAtom,
    externalReferenceItemMappingAtom,
} from '../../../../react/atoms/externalReferences';
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
 * Validate an edit_note action.
 * Checks the note exists, is editable, not in editor, and performs a dry-run
 * expansion + match to verify the replacement will succeed.
 */
async function validateEditNoteAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    // `old_string` is `let` because step 10c may enrich no-ref citations in
    // place (see `enrichOldStringCitationRefs`). All downstream code — including
    // the fallback normalization paths — operates on the enriched value.
    const { library_id, zotero_key, new_string, operation: rawOp } = request.action_data as EditNoteProposedData;
    let { old_string } = request.action_data as EditNoteProposedData;
    const operation: EditNoteOperation = rawOp ?? 'str_replace';
    // Track whether step 10c modified old_string so success paths that don't
    // otherwise build a `normalized_action_data` can carry the enrichment
    // forward to the executor.
    let oldStringEnriched = false;

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
            expandToRawHtml(new_string, metadata, 'new', externalRefContext);
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

    // 10c. Enrich no-ref citations in old_string with refs from metadata.
    //      When the model reuses the form it wrote in an earlier edit_note
    //      (citation without ref) as its old_string in a follow-up edit,
    //      we look up the corresponding ref from metadata and inject it so
    //      expansion succeeds instead of throwing "New citations (without a
    //      ref) can only appear in new_string".
    const enrichedOldString = enrichOldStringCitationRefs(old_string ?? '', metadata);
    if (enrichedOldString !== null) {
        old_string = enrichedOldString;
        oldStringEnriched = true;
    }

    // 11. Dry-run expansion
    let expandedOld: string;
    let expandedNew: string;
    try {
        expandedOld = expandToRawHtml(old_string ?? '', metadata, 'old');
        expandedNew = expandToRawHtml(new_string, metadata, 'new', externalRefContext);
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
    // Normalize rawHtml to match what simplifyNoteHtml exposes to the model,
    // so expanded old_string (based on normalized simplified) finds a match.
    const strippedHtml = stripDataCitationItems(normalizeNoteHtml(rawHtml));
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

    // 12a'. Zero matches — NFKC fallback for CJK full-width → half-width drift.
    if (matchCount === 0) {
        const nfkcOld = expandedOld.normalize('NFKC');
        if (nfkcOld !== expandedOld && countOccurrences(strippedHtml, nfkcOld) > 0) {
            expandedOld = nfkcOld;
            expandedNew = expandedNew.normalize('NFKC');
            matchCount = countOccurrences(strippedHtml, expandedOld);
        }
    }

    // 12b. Zero matches — try trimming trailing newlines from old_string.
    //      LLMs often add extra trailing \n characters to old_string.
    //      Emit normalized_action_data so execution uses the trimmed strings.
    if (matchCount === 0 && old_string) {
        const trimmedOld = old_string.replace(/\n+$/, '');
        if (trimmedOld !== old_string) {
            try {
                const trimmedExpandedOld = expandToRawHtml(trimmedOld, metadata, 'old');
                const trimmedCount = countOccurrences(strippedHtml, trimmedExpandedOld);
                if (trimmedCount > 0) {
                    const trimmedNew = operation === 'insert_after' || operation === 'insert_before'
                        ? new_string
                        : new_string.replace(/\n+$/, '');
                    // Dry-run expand new_string to verify
                    expandToRawHtml(trimmedNew, metadata, 'new', externalRefContext);

                    const normalizedActionData: EditNoteProposedData = {
                        ...request.action_data as EditNoteProposedData,
                        old_string: trimmedOld,
                        new_string: mergeInsertNewString(operation, trimmedOld, trimmedNew),
                    };

                    // Multi-match: mirror block 14's disambiguation. Try
                    // findUniqueRawMatchPosition first; if that fails, fall back
                    // to captureValidatedEditTargetContext so the executor can
                    // disambiguate via surrounding raw context. Only refuse the
                    // edit when neither path can pin down a single target.
                    if (trimmedCount > 1 && operation !== 'str_replace_all') {
                        const rawPos = findUniqueRawMatchPosition(
                            strippedHtml, simplified, trimmedOld, trimmedExpandedOld, metadata
                        );
                        let disambiguated = rawPos !== null;
                        if (!disambiguated) {
                            const targetContext = captureValidatedEditTargetContext(
                                strippedHtml, simplified, trimmedOld, trimmedExpandedOld, metadata
                            );
                            if (targetContext) {
                                normalizedActionData.target_before_context = targetContext.beforeContext;
                                normalizedActionData.target_after_context = targetContext.afterContext;
                                disambiguated = true;
                            }
                        }
                        if (!disambiguated) {
                            return {
                                type: 'agent_action_validate_response',
                                request_id: request.request_id,
                                valid: false,
                                error: `The string to replace was found ${trimmedCount} times in the note. `
                                    + 'Use operation str_replace_all to replace all occurrences, or include more context to make the match unique.',
                                error_code: 'ambiguous_match',
                                preference: 'always_ask',
                            };
                        }
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
                            match_count: trimmedCount,
                        },
                        normalized_action_data: normalizedActionData,
                        preference,
                    };
                }
            } catch {
                // expansion failed — fall through
            }
        }
    }

    // 12c. Zero matches — try stripping JSON-style backslash escapes.
    //      LLMs sometimes double-escape characters when constructing JSON tool
    //      call parameters, producing literal \" / \n / \\ in the string
    //      instead of the actual characters.
    const JSON_ESCAPE_PATTERN = /\\(["\\/nrt])/g;
    const unescapeJsonEscapes = (s: string): string =>
        s.replace(JSON_ESCAPE_PATTERN, (_match, c) => {
            switch (c) {
                case 'n': return '\n';
                case 'r': return '\r';
                case 't': return '\t';
                default: return c; // " \ /
            }
        });
    if (matchCount === 0 && old_string && /\\["\\/nrt]/.test(old_string)) {
        const unescapedOld = unescapeJsonEscapes(old_string);
        if (unescapedOld !== old_string) {
            try {
                const unescapedExpandedOld = expandToRawHtml(unescapedOld, metadata, 'old');
                const unescapedCount = countOccurrences(strippedHtml, unescapedExpandedOld);
                if (unescapedCount > 0) {
                    const unescapedNew = unescapeJsonEscapes(new_string);
                    // Dry-run expand new_string to verify
                    expandToRawHtml(unescapedNew, metadata, 'new', externalRefContext);

                    const normalizedActionData: EditNoteProposedData = {
                        ...request.action_data as EditNoteProposedData,
                        old_string: unescapedOld,
                        new_string: mergeInsertNewString(operation, unescapedOld, unescapedNew),
                    };

                    // Multi-match: mirror block 14's disambiguation. Try
                    // findUniqueRawMatchPosition first; if that fails, fall back
                    // to captureValidatedEditTargetContext so the executor can
                    // disambiguate via surrounding raw context. Only refuse the
                    // edit when neither path can pin down a single target.
                    if (unescapedCount > 1 && operation !== 'str_replace_all') {
                        const rawPos = findUniqueRawMatchPosition(
                            strippedHtml, simplified, unescapedOld, unescapedExpandedOld, metadata
                        );
                        let disambiguated = rawPos !== null;
                        if (!disambiguated) {
                            const targetContext = captureValidatedEditTargetContext(
                                strippedHtml, simplified, unescapedOld, unescapedExpandedOld, metadata
                            );
                            if (targetContext) {
                                normalizedActionData.target_before_context = targetContext.beforeContext;
                                normalizedActionData.target_after_context = targetContext.afterContext;
                                disambiguated = true;
                            }
                        }
                        if (!disambiguated) {
                            return {
                                type: 'agent_action_validate_response',
                                request_id: request.request_id,
                                valid: false,
                                error: `The string to replace was found ${unescapedCount} times in the note. `
                                    + 'Use operation str_replace_all to replace all occurrences, or include more context to make the match unique.',
                                error_code: 'ambiguous_match',
                                preference: 'always_ask',
                            };
                        }
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
                            match_count: unescapedCount,
                        },
                        normalized_action_data: normalizedActionData,
                        preference,
                    };
                }
            } catch {
                // expansion failed — fall through
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
                    expandedNew = expandToRawHtml(stripped.strippedNew, metadata, 'new', externalRefContext);
                    matchCount = countOccurrences(strippedHtml, expandedOld);
                } catch {
                    // expansion failed — fall through to fuzzy error
                }

                if (matchCount >= 1) {
                    // Build normalized_action_data with the stripped strings
                    const normalizedActionData: EditNoteProposedData = {
                        ...request.action_data as EditNoteProposedData,
                        old_string: stripped.strippedOld,
                        new_string: mergeInsertNewString(
                            operation,
                            stripped.strippedOld,
                            stripped.strippedNew,
                        ),
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
                expandToRawHtml(tagStrip.strippedNew, metadata, 'new', externalRefContext);
                const tagMatchCount = countOccurrences(strippedHtml, tagExpandedOld);

                if (tagMatchCount >= 1) {
                    const normalizedActionData: EditNoteProposedData = {
                        ...request.action_data as EditNoteProposedData,
                        old_string: tagStrip.strippedOld,
                        new_string: mergeInsertNewString(
                            operation,
                            tagStrip.strippedOld,
                            tagStrip.strippedNew,
                        ),
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

    // 13b. Zero matches — try inline tag drift detection first.
    //      The model often copies text from read_note but drops inline
    //      formatting tags (<strong>/<em>/etc.) around individual words.
    //      Detecting this lets us emit a much more pointed error than the
    //      generic fuzzy match.
    if (matchCount === 0) {
        const drift = findInlineTagDriftMatch(simplified, old_string ?? '');
        if (drift) {
            const droppedList = drift.droppedTags.join(' ');
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: 'The string to replace was not found in the note. '
                    + 'Your old_string text matches a span in the note uniquely, '
                    + 'but is missing inline HTML formatting tags that the note has.\n'
                    + `Note has:\n\`\`\`\n${drift.noteSpan}\n\`\`\`\n`
                    + `Your old_string:\n\`\`\`\n${old_string}\n\`\`\`\n`
                    + `Tags missing from old_string: ${droppedList}.\n`
                    + 'To fix: copy the "Note has" version above as your old_string '
                    + '(must match exactly, including all inline tags). Then choose '
                    + 'new_string based on intent — keep the same tags around the '
                    + 'same words to preserve the formatting, or omit them to remove '
                    + 'the formatting.',
                error_code: 'old_string_not_found',
                preference: 'always_ask',
            };
        }

        // 13b (cont). Fall back to generic fuzzy match on simplified HTML.
        const fuzzy = findFuzzyMatch(simplified, old_string ?? '');
        // 13c. When fuzzy word-match returns nothing (e.g. old_string is mostly
        //      structural HTML like `</h2>\n<table>`), try to find a distinctive
        //      block-level tag that old_string references and show its real
        //      context in the note so the model can pick a correct anchor.
        const structural = fuzzy
            ? null
            : findStructuralAnchorHint(simplified, old_string ?? '');
        let errorMsg = 'The string to replace was not found in the note.';
        if (fuzzy) {
            errorMsg += ` Found a possible fuzzy match:\n\`\`\`\n${fuzzy}\n\`\`\``;
        } else if (structural) {
            errorMsg += ` Your old_string references \`<${structural.tagName}>\`,`
                + ' but its actual context in the note is:\n'
                + `\`\`\`\n${structural.context}\n\`\`\`\n`
                + 'Rewrite old_string to match the surrounding content shown above.';
        }
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: errorMsg,
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
                    ...(oldStringEnriched ? { old_string } : {}),
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

        // insert_after / insert_before normalization: merge old_string and
        // new_string so execution can treat it as a regular str_replace.
        if (operation === 'insert_after' || operation === 'insert_before') {
            if (!normalizedActionData) {
                normalizedActionData = {
                    ...request.action_data as EditNoteProposedData,
                    ...(oldStringEnriched ? { old_string } : {}),
                };
            }
            const anchor = normalizedActionData.old_string ?? old_string ?? '';
            normalizedActionData.new_string = mergeInsertNewString(operation, anchor, new_string);
        }

        // Carry enriched old_string forward even when disambiguation succeeded
        // via the unique raw-position path (no target context captured).
        if (!normalizedActionData && oldStringEnriched) {
            normalizedActionData = {
                ...request.action_data as EditNoteProposedData,
                old_string,
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
                match_count: matchCount,
            },
            normalized_action_data: normalizedActionData,
            preference,
        };
    }

    // 15. insert_after / insert_before normalization: merge old_string and
    //     new_string so execution can treat it as a regular str_replace.
    //     - insert_after:  new_string = old_string + new_string
    //     - insert_before: new_string = new_string + old_string
    let normalizedActionData: EditNoteProposedData | undefined;
    if (operation === 'insert_after' || operation === 'insert_before') {
        normalizedActionData = {
            ...request.action_data as EditNoteProposedData,
            ...(oldStringEnriched ? { old_string } : {}),
            new_string: mergeInsertNewString(operation, old_string ?? '', new_string),
        };
    } else if (oldStringEnriched) {
        // Carry the enriched old_string forward so the executor sees it.
        normalizedActionData = {
            ...request.action_data as EditNoteProposedData,
            old_string,
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
        new_string,
        operation: rawOp,
    } = request.action_data as EditNoteProposedData;
    // `old_string` is `let` because we may enrich no-ref citations with their
    // stored refs before expansion (step 5b). This is defense-in-depth: validate
    // already enriches and emits `normalized_action_data`, but we re-enrich here
    // so direct executor calls (or stale action_data) also benefit.
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

    // 5b. Enrich no-ref citations in old_string with refs from metadata.
    //     Defense-in-depth: validation normally emits this via
    //     normalized_action_data, but re-running here protects against stale
    //     or skipped validation.
    const enrichedOldString = enrichOldStringCitationRefs(old_string ?? '', metadata);
    if (enrichedOldString !== null) {
        old_string = enrichedOldString;
    }

    // 6. Expand old_string and new_string to raw HTML
    let expandedOld: string;
    let expandedNew: string;
    try {
        expandedOld = expandToRawHtml(old_string ?? '', metadata, 'old');
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

    // 6b. Normalize + strip data-citation-items from raw HTML for matching.
    //     Snapshot the cache first so rebuild can preserve itemData for
    //     URIs that don't resolve in the current library.
    const normalizedOldHtml = normalizeNoteHtml(oldHtml);
    const existingCitationCache = extractDataCitationItems(normalizedOldHtml);
    const strippedHtml = stripDataCitationItems(normalizedOldHtml);

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

    // 7b. Zero matches — NFKC fallback for CJK full-width → half-width drift.
    //     Mirrors the validation-time retry (see validateEditNoteAction). Notes
    //     created by legacy create_note runs may have had full-width CJK
    //     punctuation (，（）) rewritten to half-width ASCII. If the model
    //     rebuilds `old_string` from the original full-width form, the match
    //     fails here. NFKC-normalize symmetrically so the replacement stays
    //     consistent with the note's stored form.
    if (matchCount === 0) {
        const nfkcOld = expandedOld.normalize('NFKC');
        if (nfkcOld !== expandedOld && countOccurrences(strippedHtml, nfkcOld) > 0) {
            expandedOld = nfkcOld;
            expandedNew = expandedNew.normalize('NFKC');
            if (target_before_context != null) target_before_context = target_before_context.normalize('NFKC');
            if (target_after_context != null) target_after_context = target_after_context.normalize('NFKC');
            matchCount = countOccurrences(strippedHtml, expandedOld);
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
                    expandedNew = expandToRawHtml(stripped.strippedNew, metadata, 'new', externalRefContext);
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
                const candidateNew = expandToRawHtml(tagStrip.strippedNew, metadata, 'new', externalRefContext);
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

export { validateEditNoteAction, executeEditNoteAction };
