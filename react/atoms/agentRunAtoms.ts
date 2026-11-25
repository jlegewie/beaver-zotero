/**
 * Chat runs as the window sees them.
 *
 * Execution lives in the run engine (`react/agentRuns/runEngine`), whose atoms
 * this module re-exports. What stays here is the window's half of a send:
 * assembling the prompt from the composer and the window's context, and
 * clearing the composer once the run is accepted. Importing this module
 * installs this renderer's run session (`react/runtime/windowRunSession`).
 */

import { atom, Getter, Setter } from 'jotai';
import { getCredentialGeneration, assertCredentialGeneration } from '@beaver/agent-core/transport/credentials';
import { logger } from '@beaver/agent-core/platform/logger';
import type { ChargingPermissions } from '@beaver/agent-core/protocol/agentProtocol';
import { MessageAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import type { ZoteroCollection } from '@beaver/agent-core/types/zotero';
import { isAnnotationAttachment, isViewAttachment, messageAttachmentKey, zoteroReferenceLookupKeys } from '@beaver/agent-core/types/attachments/apiTypes';
import { BeaverAgentPrompt, MessageSearchFilters, PromptAction, PromptOrigin, ToolRequest } from '@beaver/agent-core/agents/types';
import {
    threadRunsAtom,
    activeRunAtom,
    currentThreadIdAtom,
    currentThreadNameAtom,
    allUserAttachmentKeysAtom,
    resetRunSelectorCaches,
} from '@beaver/agent-core/run-state/atoms';
import { citationsAtom, resetCitationMarkersAtom } from '@beaver/agent-core/citations/atoms';
import { clearAllPendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { clearAllPendingCreditConfirmationsAtom } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { clearAllPendingBatchApprovalsAtom } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import { clearAllPendingTableCardsAtom } from '@beaver/agent-core/run-state/pendingTableCards';
import { selectedModelAtom } from './models';
import { getPref } from '../../src/utils/prefs';
import { toMessageAttachment, toValidatedMessageAttachment, externalFileRecordToAttachment } from '../types/attachments/converters';
import { serializeCollection, serializeZoteroLibrary } from '../../src/utils/zoteroSerializers';
import { searchableLibraryIdsAtom } from './profile';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { completeCreditsFirstRunAtom } from './firstRun';
import {
    readComposerDraft,
    restoreMissingComposerDraft,
    currentMessageItemsAtom,
    currentMessageCollectionsAtom, currentMessageViewsAtom,
    currentMessageExternalFilesAtom,
    currentReaderAttachmentAtom,
    stagedReaderActionContextAtom,
    currentMessageFiltersAtom,
    clearComposerAtom,
} from './messageComposition';
import { isWebSearchEnabledAtom, removePopupMessagesByTypeAtom, isWebSearchAllowedAtom } from './ui';
import { currentNoteItemAtom } from './zoteroContext';
import { getApplicationStateProvider } from './applicationState';
import { uint8ArrayToBase64 } from '../utils/fileUtils';
import { userIdAtom } from './auth';
import { sanitizeMessageFiltersForSearchableLibraries } from '../utils/messageFilters';
import { clearAgentActionsAtom, resetAgentActionSelectorCaches } from '../agents/agentActions';
import { clearParkedAnswersAtom } from './parkedRuns';
import { clearWarningsAtom } from './warnings';
import { clearRunApprovalPolicyAtom } from './runApprovalPolicy';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import { isTargetInLibraries } from '../utils/zoteroReferences';
import { prewarmMuPDFWorker } from '../../src/beaver-extract';
import { isRejectedItemValidation, itemValidationResultsAtom } from './itemValidation';
import '../runtime/windowRunSession';
import { getRunSession, runSessionStore } from '../agentRuns/runSession';
import {
    buildModelSelectionOptions,
    isWSChatPendingAtom,
    messageParksResume,
    parkResumeForMessageAtom,
    prepareForNewRunAtom,
    resetWSStateAtom,
    retryCommitInFlight,
    startMessageRun,
    withThreadWriter,
    wsErrorAtom,
} from '../agentRuns/runEngine';

export * from '../agentRuns/runEngine';

// =============================================================================
// Prompt assembly
// =============================================================================

/**
 * Processes annotation attachments of type image to add base64 data.
 *
 * @param attachments - Array of MessageAttachment objects to process
 * @returns Array of MessageAttachment objects with base64 data
 */
export async function processImageAnnotations(attachments: MessageAttachment[]): Promise<MessageAttachment[]> {
    // Process image annotations to add base64 data
    const processedAttachments = await Promise.all(
        attachments.map(async (attachment) => {
            // Only process AnnotationAttachment of type image
            if (!isAnnotationAttachment(attachment)) return attachment;
            if (attachment.annotation_type !== 'image') return attachment;

            // Create a reference to the Zotero item
            const item = {
                libraryID: attachment.library_id,
                key: attachment.zotero_key
            };

            // Check if image exists in cache
            const hasCachedImage = await Zotero.Annotations.hasCacheImage(item);
            if (!hasCachedImage) {
                logger(`processImageAnnotations: No cached image found for attachment ${attachment.zotero_key}`);
                return attachment;
            }

            try {
                // Get image path
                const imagePath = Zotero.Annotations.getCacheImagePath(item);

                // Read the image file and convert to base64
                const imageData = await IOUtils.read(imagePath);
                const image_base64 = uint8ArrayToBase64(imageData);

                // Return attachment with image data
                return {
                    ...attachment,
                    image_base64: image_base64
                };
            } catch (error) {
                logger(`processImageAnnotations: Failed to process image for attachment ${attachment.zotero_key}: ${error}`);
                return attachment;
            }
        })
    );
    return processedAttachments;
}

/** How a message sent from the window is started. */
export interface SendWSMessageOptions {
    runIdOverride?: string;
    permissionsOverride?: Partial<ChargingPermissions>;
    origin?: PromptOrigin;
    /** Saved actions invoked as /command tokens in the message content */
    actions?: PromptAction[];
    /** The feature-credit task this message was started for, from its setup card. */
    featureTask?: string;
}

/**
 * Send a chat message: assemble the prompt from the composer and the window's
 * context, then hand it to the engine, which starts its run. `set` writes the
 * window's state and `sessionSet` the chat's, in the session's store.
 */
const sendWSMessage = async (
        get: Getter,
        set: Setter,
        sessionSet: Setter,
        message: string,
        options?: SendWSMessageOptions,
    ) => {
        const session = getRunSession();
        const accountGeneration = getCredentialGeneration();
        const inAccount = (target: Setter): Setter => ((...args: Parameters<Setter>) => {
            assertCredentialGeneration(accountGeneration);
            return target(...args);
        }) as Setter;
        set = inAccount(set);
        sessionSet = inAccount(sessionSet);
        const { runIdOverride, permissionsOverride, origin, actions, featureTask } = options ?? {};
        const isPending = get(isWSChatPendingAtom);
        logger('sendWSMessageAtom: Called at ' + Date.now() + ' with message: ' + message.substring(0, 50) + ' (isPending: ' + isPending + ')', 1);

        // Guard: Don't allow concurrent requests. The retry lock is checked
        // separately because the failed run's dying socket can clear the
        // pending flag mid-commit — the lock is released only by the retry
        // flow itself.
        if (isPending) {
            logger('sendWSMessageAtom: Blocked - already have request in progress', 1);
            return;
        }
        if (retryCommitInFlight(get, 'sendWSMessageAtom')) return;

        // A first message ends a feature-credits first run, as picking a task does.
        void set(completeCreditsFirstRunAtom, featureTask ?? 'chat');

        // Dismiss any open diff preview before sending
        session.host.dismissDiffPreview();

        // Reset state
        sessionSet(prepareForNewRunAtom);
        prewarmMuPDFWorker();
        sessionSet(isWSChatPendingAtom, true);

        try {
            const applicationStatePromise = getApplicationStateProvider()(get);
            // Attach a rejection handler immediately while attachment preparation runs.
            void applicationStatePromise.catch(() => {});
            const readerActionContext = get(stagedReaderActionContextAtom);
            // Routed reader actions carry their own document; destination tabs
            // must not add unrelated reader or note attachments.
            const submissionReaderAttachment = readerActionContext ? null : get(currentReaderAttachmentAtom);
            const submissionNoteItem = readerActionContext ? null : get(currentNoteItemAtom);
            // Get current model and build model selection options for the request
            const model = get(selectedModelAtom);
            const modelOptions = buildModelSelectionOptions(model);

            // Log model and model selection info
            logger('Selected model:', model ? {
                id: model.id,
                name: model.name,
                provider: model.provider,
                is_custom: model.is_custom,
                allow_app_key: model.allow_app_key,
                allow_byok: model.allow_byok,
                access_mode: model.access_mode,
            } : null);
            logger('Model selection options:', {
                model_id: modelOptions.model_id || '(not set - using custom model or plan default)',
                hasApiKey: !!modelOptions.api_key,
            });

            // Custom instructions (if any)
        const customInstructions = getPref('customInstructions') || undefined;

        // Build attachments from current message items. Final send gate: drop
        // anything validation already rejected AND anything in a library the user
        // excluded from Beaver
        const validationResults = get(itemValidationResultsAtom);
        const searchableLibraryIds = get(searchableLibraryIdsAtom);
        const rawSelectedItems = get(currentMessageItemsAtom);
        const rejectedSelectedItems = rawSelectedItems.filter((item) =>
            !searchableLibraryIds.includes(item.libraryID) ||
            isRejectedItemValidation(item, validationResults.get(`${item.libraryID}-${item.key}`))
        );
        const selectedItems = rejectedSelectedItems.length > 0
            ? rawSelectedItems.filter((item) => !rejectedSelectedItems.includes(item))
            : rawSelectedItems;
        if (rejectedSelectedItems.length > 0) {
            set(currentMessageItemsAtom, selectedItems);
            set(addPopupMessageAtom, {
                type: 'error',
                title: rejectedSelectedItems.length === 1 ? 'Item Removed' : 'Items Removed',
                text: rejectedSelectedItems.length === 1
                    ? 'An item that Beaver cannot use was removed from this message.'
                    : `${rejectedSelectedItems.length} items that Beaver cannot use were removed from this message.`,
                expire: true,
                duration: 4000,
            });
        }

        // Load note data for any note items (getNoteTitle() requires 'note' data type)
        const currentNoteTabItem = submissionNoteItem;
        const noteItems = selectedItems.filter(item => item.isNote());
        const allNoteItems = currentNoteTabItem
            ? [...noteItems, currentNoteTabItem]
            : noteItems;
        if (allNoteItems.length > 0) {
            await Promise.all(allNoteItems.map(item => item.loadDataType('note')));
        }
        const regularItems = selectedItems.filter(item => item.isRegularItem());
        if (regularItems.length > 0) {
            await Zotero.Items.loadDataTypes(regularItems, ['itemData', 'creators']);
        }
        const attachmentItems = selectedItems.filter(item => item.isAttachment());
        if (attachmentItems.length > 0) {
            await Zotero.Items.loadDataTypes(attachmentItems, ['itemData']);
        }
        const attachmentParentItemsById = new Map<number, Zotero.Item>();
        for (const attachment of attachmentItems) {
            const parent = attachment.parentItem;
            if (parent) attachmentParentItemsById.set(parent.id, parent);
        }
        const attachmentParentItems = Array.from(attachmentParentItemsById.values());
        if (attachmentParentItems.length > 0) {
            await Zotero.Items.loadDataTypes(attachmentParentItems, ['itemData', 'creators']);
        }

        let attachments: MessageAttachment[] =
            (await Promise.all(selectedItems.map(item => toValidatedMessageAttachment(item))))
                .filter((attachment): attachment is MessageAttachment => attachment !== null);
        attachments = await processImageAnnotations(attachments);

        // Add collection attachments if set
        const messageCollections = get(currentMessageCollectionsAtom)
            .filter(col => searchableLibraryIds.includes(col.library_id));
        for (const col of messageCollections) {
            attachments.push({
                type: 'collection',
                collection_id: col.collection_id,
                parent_collection_id: col.parent_collection_id,
                library_id: col.library_id,
                zotero_key: col.zotero_key,
                library_ref: col.library_ref,
                name: col.name,
                parent_key: col.parent_key,
            });
        }

        // Add saved-search and built-in-view attachments (Unfiled Items, …)
        attachments.push(...get(currentMessageViewsAtom)
            .filter(view => isTargetInLibraries(view, searchableLibraryIds)));

        // Add external file attachments (metadata only; content stays local and
        // is served on demand through the read/view request paths). Files whose
        // managed copy disappeared since attach are dropped with a popup.
        const externalFiles = get(currentMessageExternalFilesAtom);
        for (const file of externalFiles) {
            const exists = await IOUtils.exists(file.storedPath).catch(() => false);
            if (!exists) {
                logger(`sendWSMessageAtom: External file copy missing, dropping: ext-${file.extKey} ('${file.filename}')`, 1);
                set(addPopupMessageAtom, {
                    type: 'warning',
                    title: 'File unavailable',
                    text: `"${file.filename}" is no longer available and was removed from the message.`,
                    expire: true,
                });
                continue;
            }
            attachments.push(externalFileRecordToAttachment(file));
        }

        // Add the current reader attachment as a source if it is not already in
        // the thread. Reader position is captured in application state. Send gate:
        // never auto-attach a reader source in a library the user excluded from
        // Beaver — this path bypasses the currentMessageItems gate above.
        const readerAttachment = submissionReaderAttachment;
        // Set when the tab's table is dropped below, so the captured
        // application state stops naming it as the open table.
        let droppedTableContextKey: string | null = null;
        if (readerAttachment && searchableLibraryIds.includes(readerAttachment.libraryID)) {
            const allUserAttachmentKeys = get(allUserAttachmentKeysAtom);
            const existingKeys = new Set([
                // Saved-search keys share the item key format
                ...attachments.filter(a => !isViewAttachment(a)).map(messageAttachmentKey),
                ...allUserAttachmentKeys
            ]);
            logger(`sendWSMessageAtom: Handeling reader attachment - existingKeys: ${JSON.stringify(existingKeys)}`, 1);
            const readerKeys = zoteroReferenceLookupKeys({
                library_id: readerAttachment.libraryID,
                zotero_key: readerAttachment.key,
                library_ref: libraryRefForLibraryID(readerAttachment.libraryID),
            });
            if (!readerKeys.some(key => existingKeys.has(key))) {
                logger(`sendWSMessageAtom: Handeling reader attachment - Adding reader attachment: ${readerKeys[0]}`, 1);
                await Zotero.Items.loadDataTypes([readerAttachment], ['itemData']);
                if (readerAttachment.parentItem) {
                    await Zotero.Items.loadDataTypes([readerAttachment.parentItem], ['itemData', 'creators']);
                }
                // The tab context is attached automatically, so a table that
                // stopped being sendable since it became the context (corrupt,
                // write pending, newly cites an excluded library) is dropped
                // with a notice instead of failing the whole send.
                try {
                    const readerMessageAttachment = await toValidatedMessageAttachment(readerAttachment);
                    if (readerMessageAttachment) attachments.push(readerMessageAttachment);
                } catch (error: any) {
                    droppedTableContextKey = readerAttachment.key;
                    logger(`sendWSMessageAtom: Dropping unavailable tab context ${readerKeys[0]}: ${error?.message ?? error}`, 1);
                    // Stop offering it as context, so the next send does not
                    // warn again; selecting the tab again re-checks it.
                    if (get(currentReaderAttachmentAtom)?.id === readerAttachment.id) {
                        set(currentReaderAttachmentAtom, null);
                    }
                    set(addPopupMessageAtom, {
                        type: 'warning',
                        title: 'Table not attached',
                        text: 'The open table is unavailable and was not added to the message.',
                        expire: true,
                    });
                }
            } else {
                logger(`sendWSMessageAtom: Handeling reader attachment - Skipping reader attachment: ${readerKeys[0]}`, 1);
            }
        }

        // Add current note tab item as note attachment if not already present.
        // Send gate: never auto-attach a note in a library the user excluded from
        // Beaver — this path bypasses the currentMessageItems gate above.
        if (currentNoteTabItem && searchableLibraryIds.includes(currentNoteTabItem.libraryID)) {
            const allUserAttachmentKeys = get(allUserAttachmentKeysAtom);
            const existingKeys = new Set([
                // Saved-search keys share the item key format
                ...attachments.filter(a => !isViewAttachment(a)).map(messageAttachmentKey),
                ...allUserAttachmentKeys
            ]);
            const noteKeys = zoteroReferenceLookupKeys({
                library_id: currentNoteTabItem.libraryID,
                zotero_key: currentNoteTabItem.key,
                library_ref: libraryRefForLibraryID(currentNoteTabItem.libraryID),
            });
            if (!noteKeys.some(key => existingKeys.has(key))) {
                const noteAttachment = toMessageAttachment(currentNoteTabItem);
                if (noteAttachment) {
                    attachments.push(noteAttachment);
                }
            }
        }

        // Build filters payload
        const rawFilterState = get(currentMessageFiltersAtom);
        const sanitizedFilters = sanitizeMessageFiltersForSearchableLibraries(
            rawFilterState,
            searchableLibraryIds,
        );
        const filterState = sanitizedFilters.state;
        if (sanitizedFilters.changed) {
            set(currentMessageFiltersAtom, filterState);
        }
        const filterLibraries = filterState.libraryIds.length > 0
            ? filterState.libraryIds
                .map(id => Zotero.Libraries.get(id))
                .filter((l): l is Zotero.Library => !!l)
                .map(serializeZoteroLibrary)
            : null;
        const filterCollections = filterState.collectionIds.length > 0
            ? (await Promise.all(filterState.collectionIds.map((id) => {
                const collection = Zotero.Collections.get(id);
                return collection ? serializeCollection(collection) : null;
            }))).filter((collection): collection is ZoteroCollection => collection !== null)
            : null;
        const filterTags = filterState.tagSelections.length > 0
            ? filterState.tagSelections.map(tag => ({ ...tag }))
            : null;
        const filtersPayload: MessageSearchFilters = {
            libraries: filterLibraries,
            collections: filterCollections,
            tags: filterTags
        };

        // Tool requests (web search)
        const toolRequests = get(isWebSearchEnabledAtom) && get(isWebSearchAllowedAtom)
            ? [{ function: "search_external_references", parameters: {} } as ToolRequest]
            : undefined;

        // Application state (current view, reader/note state, library context,
        // indexing status). Built via the injectable provider so a non-Zotero
        // host can supply its own document state through the same slot.
        let applicationState = await applicationStatePromise;
        if (droppedTableContextKey && applicationState?.table_state?.zotero_key === droppedTableContextKey) {
            const { table_state: _dropped, ...rest } = applicationState;
            applicationState = rest;
        }
        // Build the message
        const userPrompt: BeaverAgentPrompt = {
            content: message,
            ...(attachments.length > 0 ? { attachments } : {}),
            // TESTING ATTACHMENTS
            // attachments: [{library_id: 1, zotero_key: 'VV4QGPZN', type: 'source', include: 'fulltext'}], // TRASH ATTACHMENT
            // attachments: [{library_id: 1, zotero_key: 'B3ISAGTY', type: 'source', include: 'fulltext'}], // TRASH ITEM
            // attachments: [{library_id: 3, zotero_key: 'FR35E8GK', type: 'source', include: 'fulltext'}], // UNSYNCED LIBRARY ITEM
            // attachments: [{library_id: 3, zotero_key: 'V4W5CH8S', type: 'source', include: 'fulltext'}], // UNSYNCED LIBRARY ATTACHMENT
            // attachments: [{library_id: 1, zotero_key: 'SUEAB6YR', type: 'source', include: 'fulltext'}], // ZOTERO NOTE
            // attachments: [{library_id: 1, zotero_key: '85JCJJKS', type: 'source', include: 'fulltext'}], // ZOTERO SCREENSHOT
            // attachments: [{library_id: 1, zotero_key: '6U4SGES3', type: 'source', include: 'fulltext'}], // UNSYNCED ATTACHMENT
            application_state: applicationState,
            filters: filtersPayload,
            ...(toolRequests ? { tool_requests: toolRequests } : {}),
            ...(origin ? { origin } : {}),
            ...(actions?.length ? { actions } : {}),
            ...(featureTask ? { feature_task: featureTask } : {}),
        };

        // Get current thread ID (null for new thread)
        const threadId = get(currentThreadIdAtom);

            // Set temporary thread name for new threads (mirrors backend thread_name_hint[:35])
            if (!threadId && message) {
                sessionSet(currentThreadNameAtom, message.substring(0, 35));
            }

            assertCredentialGeneration(accountGeneration);
            // Get user ID for the run
            const userId = get(userIdAtom);
            if (!userId) {
                logger('User ID not found', 1);
                sessionSet(isWSChatPendingAtom, false);
                return;
            }

            await startMessageRun(session, session.store.get, sessionSet, {
                prompt: userPrompt,
                threadId,
                userId,
                model,
                modelOptions,
                customInstructions,
                runIdOverride,
                permissionsOverride,
            }, () => {
                const draft = readComposerDraft(get);
                if (!draft.content) draft.content = message;
                // Reset user message input after creating the run
                set(clearComposerAtom);
                set(removePopupMessagesByTypeAtom, ['items_summary']);
                set(currentMessageItemsAtom, []);
                set(currentMessageCollectionsAtom, []);
                set(currentMessageViewsAtom, []);
                set(currentMessageExternalFilesAtom, []);
                return () => restoreMissingComposerDraft(get, set, draft);
            });
        } catch (error) {
            if (accountGeneration !== getCredentialGeneration()) return;
            // Catch any unexpected errors during message preparation
            logger('sendWSMessageAtom: Unexpected error:', error, 1);
            sessionSet(wsErrorAtom, {
                event: 'error',
                type: 'preparation_error',
                message: error instanceof Error ? error.message : 'Failed to prepare message',
                is_retryable: true,
            });
            sessionSet(activeRunAtom, null);
            sessionSet(isWSChatPendingAtom, false);
        }
    };

export const sendWSMessageAtom = atom(null, (get, set, message: string, options?: SendWSMessageOptions) => {
    const send = () => withThreadWriter(set, (guardedSet, guardedSessionSet) =>
        sendWSMessage(get, guardedSet, guardedSessionSet, message, options));
    // Claims the writer in the same tick as the click unless a resume must
    // be parked first, so a second click finds it taken.
    if (!messageParksResume(get)) return send();
    return set(parkResumeForMessageAtom).then((parkedResume) => (parkedResume ? send() : undefined));
});

/**
 * Clear the current thread and start fresh
 */
export const clearThreadAtom = atom(null, (_get, set) => {
    const chat = runSessionStore();
    chat.set(threadRunsAtom, []);
    chat.set(activeRunAtom, null);
    chat.set(currentThreadIdAtom, null);
    chat.set(resetWSStateAtom);
    // Clear agent actions, citations, and warnings for the thread
    set(clearAgentActionsAtom);
    chat.set(citationsAtom, []);
    set(resetCitationMarkersAtom);  // Reset citation markers for cleared thread
    resetRunSelectorCaches();  // Drop scoped run selectors keyed by the cleared thread's runs
    resetAgentActionSelectorCaches();  // ...and the action/approval selectors keyed by its tool calls
    set(clearWarningsAtom);
    // Clear pending questions so a reset never leaves the composer disabled
    // behind an unanswerable card (pending approvals are left as-is here).
    chat.set(clearAllPendingQuestionsAtom);
    chat.set(clearAllPendingCreditConfirmationsAtom);
    chat.set(clearAllPendingBatchApprovalsAtom);
    chat.set(clearAllPendingTableCardsAtom);
    chat.set(clearRunApprovalPolicyAtom);
    chat.set(clearParkedAnswersAtom);
});

