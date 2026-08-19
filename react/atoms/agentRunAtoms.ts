/**
 * WebSocket-based message generation atoms
 * 
 * This module provides Jotai atoms for WebSocket-based chat completion,
 * using AgentRun for structured run management.
 */

import { atom, Getter, Setter } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { connectWithRetry } from '@beaver/agent-core/transport/connectWithRetry';
import { notifyCreditConfirmation, notifyRunComplete, notifyUserQuestion } from '../../src/services/systemNotifications';
import { reportConnectionFailure } from '@beaver/agent-core/transport/clients/diagnosticsService';
import {
    ConnectionFailureEvidence,
    presentConnectionFailure,
} from '@beaver/agent-core/transport/connectionFailure';
import {
    WSCallbacks,
    AgentRunRequest,
    WSReadyData,
    WSRequestAckData,
    WSPartEvent,
    WSToolReturnEvent,
    WSRunCompleteEvent,
    WSRunCitationsEvent,
    WSErrorEvent,
    WSWarningEvent,
    WSRetryEvent,
    WSAgentActionsEvent,
    WSToolCallProgressEvent,
    WSToolCallArgsStreamEvent,
    WSMissingZoteroDataEvent,
    WSDeferredApprovalRequest,
    WSDeferredApprovalStale,
    WSAskUserQuestionRequest,
    WSCreditConfirmationRequest,
    WSCreditConfirmationStale,
    AskUserQuestionAnswer,
    WSStreamingDoneEvent,
    WSThreadNameEvent,
    ChargingPermissions,
} from '@beaver/agent-core/protocol/agentProtocol';
import { threadService } from '@beaver/agent-core/transport/threadService';
import { logger } from '@beaver/agent-core/platform/logger';
import { selectedModelAtom, ModelConfig } from './models';
import { getPref } from '../../src/utils/prefs';
import { MessageAttachment, SourceAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import type { ZoteroCollection } from '@beaver/agent-core/types/zotero';
import { toMessageAttachment } from '../types/attachments/converters';
import { safeStub, serializeAttachmentStub, serializeCollection, serializeItemStub, serializeZoteroLibrary } from '../../src/utils/zoteroSerializers';
import { SubscriptionStatus, ProcessingMode } from '@beaver/agent-core/types/profile';
import {
    isDatabaseSyncSupportedAtom,
    profileSyncStatusAtom,
    searchableLibraryIdsAtom,
    syncWithZoteroAtom,
} from './profile';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import {
    currentMessageItemsAtom,
    currentMessageCollectionsAtom,
    currentMessageExternalFilesAtom,
    currentReaderAttachmentAtom,
    currentMessageFiltersAtom,
    clearComposerAtom,
} from './messageComposition';
import { isWebSearchEnabledAtom, removePopupMessagesByTypeAtom, isWebSearchAllowedAtom } from './ui';
import { currentNoteItemAtom } from './zoteroContext';
import { isAnnotationAttachment, messageAttachmentKey, zoteroReferenceLookupKeys } from '@beaver/agent-core/types/attachments/apiTypes';
import type { ExternalFileAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import { getApplicationStateProvider } from './applicationState';
import { uint8ArrayToBase64 } from '../utils/fileUtils';
import { isAttachmentOnServer } from '../../src/utils/webAPI';
import { AgentRun, BeaverAgentPrompt, MessageSearchFilters, PromptAction, PromptOrigin, ToolRequest, isRunActive } from '@beaver/agent-core/agents/types';
import {
    threadRunsAtom,
    activeRunAtom,
    currentThreadIdAtom,
    updateRunWithPart,
    updateRunWithToolReturn,
    updateRunComplete,
    updateRunWithToolCallProgress,
    updateRunWithToolCallArgsStream,
    allUserAttachmentKeysAtom,
    resetRunMessages,
} from '@beaver/agent-core/run-state/atoms';
import { userIdAtom } from './auth';
import { citationsAtom, processCitationsAtom, resetCitationMarkersAtom, mergePageLabelsByAttachmentIdAtom } from '@beaver/agent-core/citations/atoms';
import { maybeShowCitationTipAtom } from './citationTip';
import type { Citation } from '@beaver/agent-core/types/citations';
import { preloadPageLabelsForCitations } from '../utils/pageLabels';
import { sanitizeMessageFiltersForSearchableLibraries } from '../utils/messageFilters';
import {
    addAgentActionsAtom,
    upsertAgentActionsAtom,
    toAgentAction,
    clearAgentActionsAtom,
    threadAgentActionsAtom,
    isAnnotationAgentAction,
    isEditAnnotationsAgentAction,
    isEditMetadataAgentAction,
    isZoteroNoteAgentAction,
    isCreateItemAgentAction,
    isCreateCollectionAgentAction,
    isOrganizeItemsAgentAction,
    isManageTagsAgentAction,
    isManageCollectionsAgentAction,
    isEditNoteAgentAction,
    isEditNoteBatchAgentAction,
    isAnyEditNoteAgentAction,
    isCreateNoteAgentAction,
    hasAppliedZoteroItem,
    hasAppliedBulkAnnotations,
    isCreateAnnotationsAgentAction,
    undoAgentActionAtom,
    AgentAction,
    addPendingApprovalAtom,
    removePendingApprovalAtom,
    removePendingApprovalsAtom,
    pendingApprovalsAtom,
    clearAllPendingApprovalsAtom,
} from '../agents/agentActions';
import {
    addPendingQuestionAtom,
    removePendingQuestionAtom,
    clearAllPendingQuestionsAtom,
} from '@beaver/agent-core/run-state/pendingQuestions';
import {
    addPendingCreditConfirmationAtom,
    removePendingCreditConfirmationAtom,
    clearAllPendingCreditConfirmationsAtom,
} from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { readCreditThreshold } from '../utils/creditThreshold';
import { getAppliedPdfAnnotationCount } from '../agents/agentActionCounts';
import { undoEditMetadataAction } from '../utils/editMetadataActions';
import { undoCreateItemAction } from '../utils/createItemActions';
import { undoCreateCollectionAction } from '../utils/createCollectionActions';
import { undoOrganizeItemsAction } from '../utils/organizeItemsActions';
import { undoManageTagsAction } from '../utils/manageTagsActions';
import { undoManageCollectionsAction } from '../utils/manageCollectionsActions';
import { undoEditNoteAction, undoEditNoteBatchAction } from '../utils/editNoteActions';
import { undoCreateNoteAction } from '../utils/createNoteActions';
import { undoCreateAnnotationsAction } from '../utils/createAnnotationsActions';
import { undoEditAnnotationsAction } from '../utils/editAnnotationsActions';
import { processToolReturnResults } from '../agents/toolResultProcessing';
import { upgradeToolReturn } from '../compat/legacyToolResults';
import { isToolResultView } from '@beaver/agent-core/run-state/toolResultViews';
import { addWarningAtom, clearWarningsAtom } from './warnings';
import { backendHighTokenUsageRunsAtom } from './messageUIState';
import { currentThreadNameAtom, loadThreadAtom } from './threads';
import { loadItemDataForAgentActions, autoApplyAnnotationAgentActions, autoCreateNoteAgentActions } from '../utils/agentActionUtils';
import { extractZoteroReferencesFromToolCall } from '@beaver/agent-core/run-state/toolLabels';
import {
    clearRunApprovalPolicyAtom,
    getPendingApprovalIdsForToolGroup,
    getToolGroup,
    grantToolGroupForRunAtom,
    isActionApprovedForCurrentRun,
    runApprovalPolicyAtom,
} from './runApprovalPolicy';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';
import { dismissDiffPreview } from '../utils/noteEditorDiffPreview';
import { store } from '../store';
import { triggerProfileRefresh } from '../hooks/useProfileSync';
import { agentItemFilterAsync, isAgentSupportedItem } from '../../src/utils/agentItemSupport';
import { safeIsInTrash } from '../../src/utils/zoteroUtils';
import { wasItemAddedBeforeLastSync } from '../utils/sourceUtils';
import { libraryRefForLibraryID, resolveItemReference, resolveLibraryRef } from '../../src/utils/libraryIdentity';
import { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { createZoteroItemReference } from '../utils/zoteroReferences';
import { markExternalReferenceImportedAtom } from './externalReferences';
import type { CreateItemProposedData, CreateItemResultData } from '@beaver/agent-core/types/agentActions/items';
import { appendRunIfMissing, findResumeChainRoot, findRunForResume, hasOnlyThinkingParts, lingeringCompletedRun, resolveErrorRunId, toRunError } from '@beaver/agent-core/run-state/runResumeHelpers';
import { prewarmMuPDFWorker } from '../../src/beaver-extract';
import { BeaverTemporaryAnnotations } from '../utils/annotationUtils';
import { isRejectedItemValidation, itemValidationResultsAtom } from './itemValidation';

// =============================================================================
// Helper Functions
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

/**
 * Get the user's API key for a model.
 * 
 * Returns a key in these cases:
 * - Custom models: Use the API key from the custom model config
 * - BYOK models (access_mode='byok'): Use the user's configured API key for the provider
 * - App-key models (access_mode='app_key'): No user API key needed (returns undefined)
 * - Legacy models without access_mode: Use app_key if available, otherwise BYOK if only BYOK is allowed
 */
function getUserApiKey(model: ModelConfig): string | undefined {
    // Custom models use the API key from their config
    if (model.is_custom && model.custom_model?.api_key) {
        return model.custom_model.api_key;
    }

    // Check access_mode to determine key usage
    // If access_mode is explicitly 'app_key', don't provide user API key
    if (model.access_mode === 'app_key') return undefined;

    // If access_mode is 'byok', use user's key
    if (model.access_mode === 'byok') {
        if (model.provider === 'google') {
            return getPref('googleGenerativeAiApiKey') || undefined;
        } else if (model.provider === 'openai') {
            return getPref('openAiApiKey') || undefined;
        } else if (model.provider === 'anthropic') {
            return getPref('anthropicApiKey') || undefined;
        }
        return undefined;
    }

    // Legacy handling: no access_mode set (e.g., from old saved preferences)
    // Default to app_key behavior if available, otherwise fall back to BYOK if only BYOK is allowed
    if (!model.access_mode) {
        if (model.allow_app_key) {
            // Prefer app_key when both are available
            return undefined;
        } else if (model.allow_byok) {
            // Only use BYOK if app_key is not available
            if (model.provider === 'google') {
                return getPref('googleGenerativeAiApiKey') || undefined;
            } else if (model.provider === 'openai') {
                return getPref('openAiApiKey') || undefined;
            } else if (model.provider === 'anthropic') {
                return getPref('anthropicApiKey') || undefined;
            }
        }
    }

    return undefined;
}

/** Model selection options to be included in the AgentRunRequest */
interface ModelSelectionOptions {
    model_id?: string;
    api_key?: string;
}

/**
 * Build model selection options to include in the AgentRunRequest.
 * - Custom models: Use the custom_model field in the request (no model_id/api_key)
 * - App-key models (access_mode='app_key' or default): model_id only, no api_key
 * - BYOK models (access_mode='byok'): model_id + user's api_key
 */
function buildModelSelectionOptions(model: ModelConfig | null): ModelSelectionOptions {
    if (!model) return {};

    // Custom models use the custom_model field in the request, not model_id/api_key
    if (model.is_custom) return {};

    const options: ModelSelectionOptions = {};

    // Include model_id for non-custom models
    options.model_id = model.id;

    // Include api_key only for BYOK access mode
    // Legacy models without access_mode default to app_key if available
    if (model.access_mode === 'byok' || (!model.access_mode && !model.allow_app_key && model.allow_byok)) {
        const apiKey = getUserApiKey(model);
        if (apiKey) {
            options.api_key = apiKey;
        }
    }

    return options;
}

/**
 * Clear reader-only citation highlights before removing the runs that created them.
 */
async function cleanupTemporaryAnnotationsForRunReplacement(logPrefix: string): Promise<void> {
    try {
        await BeaverTemporaryAnnotations.cleanupAll();
    } catch (error) {
        logger(`${logPrefix}: Error cleaning up temporary annotations: ${error}`);
    }
}

// =============================================================================
// Retry truncation
// =============================================================================

/**
 * Move a terminal run out of the active slot into thread history.
 *
 * Failed and canceled runs stay in `activeRunAtom` (there is no terminal
 * `done` to archive them). A send or resume that is not replacing that run
 * has to keep it — the run is persisted server-side, and dropping it locally
 * would make the history on screen diverge from the history the model reads.
 *
 * Live runs (`in_progress`, `awaiting_deferred`) are left in place. Callers
 * overwrite `activeRunAtom` with the new shell immediately after, so this
 * does not null the slot.
 */
function archiveTerminalActiveRun(get: Getter, set: Setter): void {
    const activeRun = get(activeRunAtom);
    if (!activeRun || isRunActive(activeRun)) return;
    set(threadRunsAtom, (runs) => appendRunIfMissing(runs, activeRun));
}

/**
 * Archive a terminal active run into thread history and clear the slot.
 *
 * The retry paths use this instead of `archiveTerminalActiveRun`: they await
 * a truncate POST before installing the replacement shell, and `allRunsAtom`
 * concatenates thread history and the active slot without deduplication, so a
 * run left in both places would render twice for the whole round trip.
 *
 * Folding the run into `threadRunsAtom` first is also what puts a failed run
 * that sits in the active slot into the retry's removed set — its applied
 * actions belong in the confirm dialog, and its ID in the POSTed removal.
 */
function archiveAndClearTerminalActiveRun(get: Getter, set: Setter): void {
    const activeRun = get(activeRunAtom);
    if (!activeRun || isRunActive(activeRun)) return;
    set(threadRunsAtom, (runs) => appendRunIfMissing(runs, activeRun));
    set(activeRunAtom, null);
}

/**
 * The run whose retry is in its pre-send phase — set while the truncate POST
 * and any undo work run, cleared once the replacement shell is installed (or
 * the retry aborts). Drives the loading state of the retry controls; the
 * replacement run's own status takes over from there.
 *
 * Doubles as the retry lock. While set, no other retry, resume, or send may
 * start (`retryCommitInFlight`), and the failed run's dying socket must not
 * release `isWSChatPendingAtom` — the close event of the run being replaced
 * arrives mid-commit, and clearing the flag there would re-enable the
 * composer while the truncation is still in flight. Only the retry flow
 * itself clears this atom, on every one of its exits.
 */
export const retryPendingRunIdAtom = atom<string | null>(null);

/**
 * Whether a retry is between its truncate POST and its replacement shell.
 * Guards every path that would mutate run state concurrently: a second
 * truncation issued in this window would commit against a thread the first
 * is about to rewrite.
 */
function retryCommitInFlight(get: Getter, logPrefix: string): boolean {
    const pendingRetryRunId = get(retryPendingRunIdAtom);
    if (!pendingRetryRunId) return false;
    logger(`${logPrefix}: Blocked — retry of run ${pendingRetryRunId} is still committing`, 1);
    return true;
}

/**
 * Commit a retry's removal on the backend before anything local changes.
 *
 * This ordering is what the retry design hangs on: no run leaves the screen
 * and no Zotero change is undone until the backend confirms the deletion.
 * On 'failed' and 'refused' the caller must leave local state untouched —
 * client and server still agree, because neither moved.
 *
 * `expectedTailRunId` names the run the client expects to survive as the
 * thread's last (null when the whole thread is removed); the backend refuses
 * when the actual survivor differs, which catches a thread rewritten by
 * another client even when every named run is already gone.
 *
 * The transport already re-POSTs once on network-shaped failures (the
 * endpoint is idempotent), so 'failed' here means the retry genuinely could
 * not reach the backend.
 */
async function truncateThreadOnServer(
    threadId: string,
    removedRunIds: string[],
    expectedTailRunId: string | null,
    logPrefix: string,
): Promise<'ok' | 'refused' | 'failed'> {
    try {
        const report = await threadService.truncateThread(
            threadId,
            removedRunIds,
            expectedTailRunId,
        );
        if (report.reason) {
            logger(
                `${logPrefix}: truncation refused (${report.reason}) — thread rewritten elsewhere ` +
                    `(named ${removedRunIds.length}, refused ${report.refused_run_ids.length})`,
                1,
            );
            return 'refused';
        }
        logger(
            `${logPrefix}: truncation confirmed ` +
                `(deleted ${report.deleted_run_ids.length} of ${removedRunIds.length} named run(s))`,
            1,
        );
        return 'ok';
    } catch (error) {
        logger(`${logPrefix}: truncation failed: ${error}`, 1);
        return 'failed';
    }
}

/**
 * Create the initial AgentRun shell when user presses send.
 * This happens BEFORE WebSocket connection.
 */
function createAgentRunShell(
    userPrompt: BeaverAgentPrompt,
    threadId: string | null,
    userId: string,
    modelName: string,
    modelSelectionOptions: ModelSelectionOptions,
    providerName?: string,
    customInstructions?: string,
    customModel?: ModelConfig['custom_model'],
    runIdOverride?: string,
    permissionsOverride?: Partial<ChargingPermissions>,
): { run: AgentRun; request: AgentRunRequest } {
    const runId = runIdOverride ?? uuidv4();

    // Get user preferences for charging permissions, then apply any partial override.
    // What a request may spend is one run-level preference: the credit limit,
    // or no limit at all. The per-tool cost booleans and the turn pause this
    // build no longer sets are left to their default on a backend old enough to
    // read them, so such a backend asks per tool and keeps pausing long runs
    // rather than charging silently.
    const confirmCredits = getPref('confirmCredits');
    const permissions: ChargingPermissions = {
        confirm_credits: confirmCredits,
        credit_confirm_threshold: confirmCredits ? readCreditThreshold() : null,
        ...permissionsOverride,
    };

    // Send request_plus_tools when pref is enabled and request uses a user API key
    const usesUserKey = !!modelSelectionOptions.api_key || !!customModel;
    const requestPlusTools = getPref('requestPlusTools') && usesUserKey;

    // Create the request that will be sent to the backend
    // thread_id is null for new threads - backend generates the ID
    // Model selection is included in the request (model_id/api_key for backend models, custom_model for custom)
    const request: AgentRunRequest = {
        type: 'chat',
        run_id: runId,
        thread_id: threadId,
        user_prompt: {
            ...userPrompt,
            ...(customInstructions ? { custom_instructions: customInstructions } : {}),
        },
        permissions: permissions,
        ...(requestPlusTools ? { request_plus_tools: true } : {}),
        ...(modelSelectionOptions.model_id ? { model_id: modelSelectionOptions.model_id } : {}),
        ...(modelSelectionOptions.api_key ? { api_key: modelSelectionOptions.api_key } : {}),
        ...(customModel ? { custom_model: customModel } : {}),
    };

    // Create the shell AgentRun for immediate UI rendering
    // thread_id will be updated when we receive the 'thread' event from backend
    const run: AgentRun = {
        id: runId,
        user_id: userId,
        thread_id: threadId,
        agent_name: 'beaver',
        user_prompt: userPrompt,
        status: 'in_progress',
        model_messages: [],
        model_name: modelName,
        provider_name: providerName,
        created_at: new Date().toISOString(),
        consent_to_share: false,
    };

    return { run, request };
}

type StartResumeRunOptions = {
    requireResumable: boolean;
    logPrefix: string;
    failureErrorType: string;
    failureMessage: string;
};

async function startResumeRun(
    get: Getter,
    set: Setter,
    failedRunId: string,
    options: StartResumeRunOptions,
): Promise<void> {
    logger(`${options.logPrefix}: Resuming from run ${failedRunId}`, 1);

    // A resume overwriting the active slot mid-commit would be clobbered
    // when the retry installs its own replacement shell.
    if (retryCommitInFlight(get, options.logPrefix)) return;

    let newRunId: string | null = null;

    try {
        const model = get(selectedModelAtom);
        if (!model) {
            logger(`${options.logPrefix}: No model selected`, 1);
            return;
        }

        const userId = get(userIdAtom);
        if (!userId) {
            logger(`${options.logPrefix}: No user ID found`, 1);
            return;
        }

        const threadRuns = get(threadRunsAtom);
        const activeRun = get(activeRunAtom);
        const failedRun = findRunForResume(threadRuns, activeRun, failedRunId);

        if (!failedRun) {
            logger(`${options.logPrefix}: Failed run ${failedRunId} not found`, 1);
            return;
        }

        if (
            failedRun.status !== 'error' ||
            (options.requireResumable && !failedRun.error?.is_resumable)
        ) {
            logger(`${options.logPrefix}: Run ${failedRunId} is not resumable`, 1);
            return;
        }

        const threadId = get(currentThreadIdAtom) || failedRun.thread_id;
        if (!threadId) {
            logger(`${options.logPrefix}: No thread ID found`, 1);
            return;
        }

        // Keep the failed run in local history: the resume continues from it
        // rather than replacing it, so the next request has to still hold it.
        archiveTerminalActiveRun(get, set);

        set(prepareForNewRunAtom);
        prewarmMuPDFWorker();
        set(isWSChatPendingAtom, true);

        const modelOptions = buildModelSelectionOptions(model);
        const customInstructions = getPref('customInstructions') || undefined;

        const resumePrompt: BeaverAgentPrompt = {
            content: '',
            is_resume: true,
            resumes_run_id: failedRunId,
        };

        const { run: newRun, request } = createAgentRunShell(
            resumePrompt,
            threadId,
            userId,
            model.name,
            modelOptions,
            model.provider,
            customInstructions,
            model.is_custom ? model.custom_model : undefined,
        );

        newRunId = newRun.id;
        set(activeRunAtom, newRun);

        await executeWSRequest(newRun, request, get, set);
    } catch (error) {
        logger(`${options.logPrefix}: Unexpected error:`, error, 1);
        set(wsErrorAtom, {
            event: 'error',
            type: options.failureErrorType,
            message: error instanceof Error ? error.message : options.failureMessage,
            is_retryable: true,
        });
        set(activeRunAtom, prev => (newRunId && prev?.id === newRunId ? null : prev));
        set(isWSChatPendingAtom, false);
    }
}

/**
 * Retry a failed run by deleting it (and any preceding resume-chain runs) and
 * starting fresh from the original user prompt. Used by auto-retry when the
 * frontend has only received thinking content — nothing user-visible to keep.
 *
 * Like the user-driven retries, the removal is committed on the backend
 * first. There is no confirm dialog and no undo — applied actions in the
 * removed runs stay in place, as before. A failed or refused truncation
 * takes the ordinary auto-retry error path with nothing local to unwind.
 */
async function startAutoRetryRun(
    get: Getter,
    set: Setter,
    failedRunId: string,
): Promise<void> {
    const logPrefix = 'autoRetryErroredRunAtom';
    logger(`${logPrefix}: Retrying from run ${failedRunId}`, 1);

    if (retryCommitInFlight(get, logPrefix)) return;

    let newRunId: string | null = null;

    try {
        const model = get(selectedModelAtom);
        if (!model) {
            logger(`${logPrefix}: No model selected`, 1);
            return;
        }

        const userId = get(userIdAtom);
        if (!userId) {
            logger(`${logPrefix}: No user ID found`, 1);
            return;
        }

        // Fold the failed run out of the active slot into thread history so
        // the removal below names it — the backend persisted it, and leaving
        // it out would strand an error run in the middle of the thread.
        archiveAndClearTerminalActiveRun(get, set);

        const threadRuns = get(threadRunsAtom);
        const failedRun = findRunForResume(threadRuns, get(activeRunAtom), failedRunId);

        if (!failedRun) {
            logger(`${logPrefix}: Failed run ${failedRunId} not found`, 1);
            return;
        }

        if (failedRun.status !== 'error') {
            logger(`${logPrefix}: Run ${failedRunId} is not in error state`, 1);
            return;
        }

        const threadId = get(currentThreadIdAtom) || failedRun.thread_id;
        if (!threadId) {
            logger(`${logPrefix}: No thread ID found`, 1);
            return;
        }

        // Walk back to the original user message — resume runs carry an empty
        // user_prompt.content, so we need the root to preserve the question.
        const rootRun = findResumeChainRoot(failedRun, threadRuns);
        const chainRootIndex = threadRuns.findIndex(r => r.id === rootRun.id);
        const truncateFromIndex = chainRootIndex >= 0 ? chainRootIndex : threadRuns.length;
        const runIdsToRemove = threadRuns.slice(truncateFromIndex).map(r => r.id);

        // The failed run's error card shows a loading state while the
        // truncate round trip runs; every exit below clears it (the catch
        // handles the throw on a failed POST).
        set(retryPendingRunIdAtom, failedRunId);
        set(isWSChatPendingAtom, true);

        // Commit the removal on the backend before anything local changes.
        // Skipped when nothing was removed (nothing persisted to delete).
        if (runIdsToRemove.length > 0) {
            const expectedTailRunId =
                truncateFromIndex > 0 ? threadRuns[truncateFromIndex - 1].id : null;
            const outcome = await truncateThreadOnServer(
                threadId,
                runIdsToRemove,
                expectedTailRunId,
                logPrefix,
            );
            if (outcome === 'refused') {
                // The thread was rewritten by another client. There is no
                // user decision to retry against a history this client has
                // never seen — reload instead, so the UI shows the thread
                // whole (including the failed run's error card, from which
                // the user can retry deliberately).
                set(retryPendingRunIdAtom, null);
                set(isWSChatPendingAtom, false);
                set(addPopupMessageAtom, {
                    type: 'warning',
                    title: 'Chat changed elsewhere',
                    text: 'This chat was changed somewhere else, so the failed run was not retried automatically. Reloading the chat.',
                    expire: true,
                });
                await set(loadThreadAtom, {
                    user_id: userId,
                    threadId,
                    skipInstanceMismatchConfirm: true,
                });
                return;
            }
            if (outcome === 'failed') {
                throw new Error('Failed to automatically retry run');
            }

            await cleanupTemporaryAnnotationsForRunReplacement(logPrefix);

            set(threadRunsAtom, prev => prev.filter(r => !runIdsToRemove.includes(r.id)));
            set(threadAgentActionsAtom, prev => prev.filter(a => !runIdsToRemove.includes(a.run_id)));
            set(citationsAtom, prev => prev.filter(c => !runIdsToRemove.includes(c.run_id ?? '')));
            set(processCitationsAtom);
            set(maybeShowCitationTipAtom);
        }

        set(prepareForNewRunAtom);
        prewarmMuPDFWorker();
        set(isWSChatPendingAtom, true);

        const modelOptions = buildModelSelectionOptions(model);
        const customInstructions = getPref('customInstructions') || undefined;

        const { run: newRun, request } = createAgentRunShell(
            rootRun.user_prompt,
            threadId,
            userId,
            model.name,
            modelOptions,
            model.provider,
            customInstructions,
            model.is_custom ? model.custom_model : undefined,
        );

        newRunId = newRun.id;
        set(activeRunAtom, newRun);
        set(retryPendingRunIdAtom, null);

        await executeWSRequest(newRun, request, get, set);
    } catch (error) {
        logger(`${logPrefix}: Unexpected error:`, error, 1);
        const failureMessage = error instanceof Error ? error.message : 'Failed to automatically retry run';
        set(wsErrorAtom, {
            event: 'error',
            type: 'auto_retry_error',
            message: failureMessage,
            is_retryable: true,
        });
        set(activeRunAtom, prev => (newRunId && prev?.id === newRunId ? null : prev));
        set(retryPendingRunIdAtom, prev => (prev === failedRunId ? null : prev));
        set(isWSChatPendingAtom, false);
    }
}

/**
 * Undo all applied agent actions from removed runs in reverse chronological order.
 *
 * A single ordered loop is required because actions have cross-type dependencies.
 * Undoing in reverse chronological order restores the original state.
 *
 * Per-action failures are logged and do not stop the loop.
 */
async function undoAppliedActionsInReverse(actions: AgentAction[]): Promise<void> {
    // Filter applied actions, keeping their original array position as the
    // tiebreaker for chronological ordering.
    const indexed = actions
        .map((action, index) => ({ action, index }))
        .filter(({ action }) => {
            if (isCreateAnnotationsAgentAction(action)) {
                return hasAppliedBulkAnnotations(action);
            }
            if (isAnnotationAgentAction(action) || isZoteroNoteAgentAction(action)) {
                return hasAppliedZoteroItem(action);
            }
            return action.status === 'applied';
        });

    // Sort reverse-chronologically by `created_at`, falling back to array
    // position (which reflects insertion order in threadAgentActionsAtom).
    indexed.sort((a, b) => {
        const ta = a.action.created_at ? Date.parse(a.action.created_at) : NaN;
        const tb = b.action.created_at ? Date.parse(b.action.created_at) : NaN;
        if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
        return b.index - a.index;
    });

    for (const { action } of indexed) {
        try {
            if (isCreateAnnotationsAgentAction(action)) {
                await undoCreateAnnotationsAction(action);
            } else if (isEditAnnotationsAgentAction(action)) {
                // Preserve fields the user manually modified after apply, as
                // the other edit-action retry paths do.
                await undoEditAnnotationsAction(action, false);
            } else if (isAnnotationAgentAction(action) || isZoteroNoteAgentAction(action)) {
                const ref = action.result_data as ZoteroItemReference | undefined;
                if (!ref) continue;
                const resolved = await resolveItemReference(ref);
                if (resolved.status === 'found') await resolved.item.eraseTx();
            } else if (isEditMetadataAgentAction(action)) {
                // false = preserve fields the user manually modified after apply
                await undoEditMetadataAction(action, false);
            } else if (isEditNoteAgentAction(action)) {
                await undoEditNoteAction(action);
            } else if (isEditNoteBatchAgentAction(action)) {
                await undoEditNoteBatchAction(action);
            } else if (isCreateItemAgentAction(action)) {
                await undoCreateItemAction(action);
            } else if (isCreateCollectionAgentAction(action)) {
                await undoCreateCollectionAction(action);
            } else if (isOrganizeItemsAgentAction(action)) {
                await undoOrganizeItemsAction(action);
            } else if (isManageTagsAgentAction(action)) {
                await undoManageTagsAction(action);
            } else if (isManageCollectionsAgentAction(action)) {
                await undoManageCollectionsAction(action);
            } else if (isCreateNoteAgentAction(action)) {
                await undoCreateNoteAction(action);
            }
        } catch (error) {
            logger(`undoAppliedActionsInReverse: Failed to undo action ${action.id} (${action.action_type}): ${error}`, 1);
        }
    }
}

/**
 * Actions to undo when regenerating a run.
 */
interface ActionsToUndo {
    annotations: AgentAction[];
    annotationEdits: AgentAction[];
    zoteroNotes: AgentAction[];
    metadataEdits: AgentAction[];
    noteEdits: AgentAction[];
    createItems: AgentAction[];
    createCollections: AgentAction[];
    organizeItems: AgentAction[];
    manageTags: AgentAction[];
    manageCollections: AgentAction[];
    createNotes: AgentAction[];
}

type UndoConfirmResult = 'undo' | 'skip' | 'cancel';

/**
 * Prompt user to confirm undoing applied agent actions during regeneration.
 * Shows a combined dialog listing all types of changes that will be undone.
 * Returns 'undo' to undo and regenerate, 'skip' to regenerate without undoing,
 * or 'cancel' to abort regeneration entirely.
 */
function confirmUndoAppliedActions(actions: ActionsToUndo): UndoConfirmResult {
    const { annotations, annotationEdits, zoteroNotes, metadataEdits, noteEdits, createItems, createCollections, organizeItems, manageTags, manageCollections, createNotes } = actions;
    const totalActions = annotations.length + annotationEdits.length + zoteroNotes.length + metadataEdits.length +
                         noteEdits.length + createItems.length + createCollections.length + organizeItems.length +
                         manageTags.length + manageCollections.length + createNotes.length;

    if (totalActions === 0) return 'skip';

    // Build a list of changes
    const changeLines: string[] = [];
    if (annotations.length > 0) {
        const annotationCount = annotations.reduce(
            (sum, action) => sum + getAppliedPdfAnnotationCount(action),
            0,
        );
        changeLines.push(`• ${annotationCount} PDF annotation${annotationCount === 1 ? '' : 's'}`);
    }
    if (annotationEdits.length > 0) {
        const annotationCount = annotationEdits.reduce((sum, action) => {
            const before = action.result_data?.before;
            const appliedRefs = action.result_data?.applied_refs;
            const count = Array.isArray(before)
                ? before.length
                : Array.isArray(appliedRefs)
                    ? appliedRefs.length
                    : 1;
            return sum + count;
        }, 0);
        changeLines.push(`• ${annotationCount} PDF annotation change${annotationCount === 1 ? '' : 's'}`);
    }
    if (zoteroNotes.length > 0) {
        changeLines.push(`• ${zoteroNotes.length} Zotero note${zoteroNotes.length === 1 ? '' : 's'}`);
    }
    if (metadataEdits.length > 0) {
        changeLines.push(`• ${metadataEdits.length} metadata edit${metadataEdits.length === 1 ? '' : 's'}`);
    }
    if (noteEdits.length > 0) {
        changeLines.push(`• ${noteEdits.length} note edit${noteEdits.length === 1 ? '' : 's'}`);
    }
    if (createItems.length > 0) {
        changeLines.push(`• ${createItems.length} created item${createItems.length === 1 ? '' : 's'}`);
    }
    if (createCollections.length > 0) {
        changeLines.push(`• ${createCollections.length} created collection${createCollections.length === 1 ? '' : 's'}`);
    }
    if (organizeItems.length > 0) {
        changeLines.push(`• ${organizeItems.length} organize action${organizeItems.length === 1 ? '' : 's'}`);
    }
    if (manageTags.length > 0) {
        changeLines.push(`• ${manageTags.length} tag change${manageTags.length === 1 ? '' : 's'}`);
    }
    if (manageCollections.length > 0) {
        changeLines.push(`• ${manageCollections.length} collection change${manageCollections.length === 1 ? '' : 's'}`);
    }
    if (createNotes.length > 0) {
        changeLines.push(`• ${createNotes.length} created note${createNotes.length === 1 ? '' : 's'}`);
    }
    
    const title = 'Retry?';
    const message = `The following changes were applied and can be undone:\n\n${changeLines.join('\n')}\n\nUndo them and retry, or retry without undoing?`;

    const buttonIndex = Zotero.Prompt.confirm({
        window: Zotero.getMainWindow(),
        title,
        text: message,
        button0: 'Undo && Retry',
        // Cancel must be at button1 so Escape/dialog-close routes here
        // (Services.prompt.confirmEx returns index 1 on Esc).
        button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
        button2: 'Retry',
        defaultButton: 1,
    });

    if (buttonIndex === 0) return 'undo';
    if (buttonIndex === 2) return 'skip';
    return 'cancel';
}


// =============================================================================
// Missing Zotero Data Handling
// =============================================================================

/** Reason why an item might be missing from the backend */
type MissingItemReason = 
    | 'not_found'           // Item doesn't exist in Zotero
    | 'library_unavailable' // Library is not available on this computer
    | 'in_trash'            // Item is in trash
    | 'library_not_synced'  // Library not configured to sync
    | 'filtered_from_sync'  // Doesn't pass sync filters (e.g., not a PDF)
    | 'pending_sync'        // Added after last sync
    | 'file_unavailable_locally_and_on_server' // File unavailable locally and on server
    | 'unknown';            // Unknown reason

/**
 * Determine why an item is missing from the backend.
 * Returns the most likely reason based on item status checks.
 */
async function determineMissingReason(ref: ZoteroItemReference, userId: string | null): Promise<MissingItemReason> {
    try {
        // Get searchable libraries from store
        const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
        const syncWithZotero = store.get(syncWithZoteroAtom);
        const resolvedLibraryId = resolveLibraryRef(ref);
        if (!resolvedLibraryId) {
            return 'library_unavailable';
        }

        // Check if library is searchable (synced for Pro, all local for Free)
        if (!searchableLibraryIds.includes(resolvedLibraryId)) {
            return 'library_not_synced';
        }

        // Try to get the item from Zotero
        const item = await Zotero.Items.getByLibraryAndKeyAsync(resolvedLibraryId, ref.zotero_key);
        if (!item) {
            return 'not_found';
        }

        // Load item and parent item data for proper status checks
        await Zotero.Items.loadDataTypes([item], ["primaryData"]);
        if (item.parentID) {
            const parentItem = await Zotero.Items.getAsync(item.parentID);
            if (parentItem) {
                await Zotero.Items.loadDataTypes([parentItem], ["primaryData"]);
            }
        }

        // Check if in trash
        const trashState = safeIsInTrash(item);
        if (trashState === true) {
            return 'in_trash';
        }

        // Check if the item is a kind Beaver supports and is available
        const passesAgentFilters = await agentItemFilterAsync(item);
        if (!passesAgentFilters) {
            return 'filtered_from_sync';
        }

        // Check if available locally or on server
        const availableLocallyOrOnServer = !item.isAttachment() || (await item.fileExists()) || isAttachmentOnServer(item);
        if (!availableLocallyOrOnServer) {
            return 'file_unavailable_locally_and_on_server';
        }

        // Check if pending sync (added after last sync)
        if (userId) {
            try {
                const wasAddedBeforeSync = await wasItemAddedBeforeLastSync(item, syncWithZotero, userId);
                if (!wasAddedBeforeSync) {
                    return 'pending_sync';
                }
            } catch {
                // Unable to determine pending status
            }
        }

        // If we get here and item exists but wasn't found in backend, it's unknown
        return 'unknown';
    } catch (error) {
        logger(`determineMissingReason: Error checking item ${ref.library_id}-${ref.zotero_key}: ${error}`, 1);
        return 'unknown';
    }
}

/** Human-readable messages for each missing reason */
const MISSING_REASON_MESSAGES: Record<MissingItemReason, string> = {
    'not_found': 'Item not found in your Zotero library',
    'library_unavailable': "Library is not available on this computer. It may be a group library you haven't joined on this device",
    'in_trash': 'Item is in trash',
    'library_not_synced': 'Library is not configured to sync with Beaver',
    'filtered_from_sync': 'Item type not supported',
    'pending_sync': 'Item was added after the last sync. Please wait for sync to complete or sync manually in settings',
    'file_unavailable_locally_and_on_server': 'File is unavailable',
    'unknown': `Unexpected error. Please read about <a href="${process.env.WEBAPP_BASE_URL + '/docs/trouble-file-sync'}" className="text-link">sync issues</a> in the documentation and contact support if the issue persists.`,
};

/**
 * Process missing Zotero data event and generate a warning message.
 * Determines reasons for all items and creates a warning with a list of reasons and counts.
 */
async function handleMissingZoteroData(
    event: WSMissingZoteroDataEvent,
    userId: string | null,
    addWarning: (params: { run_id: string; type: string; message: string; data?: Record<string, unknown> }) => void
): Promise<void> {
    if (event.items.length === 0) return;

    // Determine reasons for each item
    const reasons = await Promise.all(
        event.items.map(async (item) => ({
            item,
            reason: await determineMissingReason(item, userId)
        }))
    );
    logger('handleMissingZoteroData: reasons', reasons, 1);

    // Count reasons
    const reasonCounts = new Map<MissingItemReason, number>();
    for (const { reason } of reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }

    // Sort reasons by count (descending) for better readability
    const sortedReasons = Array.from(reasonCounts.entries())
        .sort((a, b) => b[1] - a[1]);

    // Determine the primary reason to show
    // Prioritize 'unknown' as it's most severe, otherwise show the most common reason
    const unknownEntry = sortedReasons.find(([reason]) => reason === 'unknown');
    const [primaryReason, primaryCount] = unknownEntry || sortedReasons[0];
    
    // Build user-friendly message
    const itemCount = event.items.length;
    const itemWord = itemCount === 1 ? 'attachment' : 'attachments';
    const otherCount = itemCount - primaryCount;
    
    let message = `Unable to process ${itemCount} ${itemWord}: ${MISSING_REASON_MESSAGES[primaryReason]}`;
    
    // Add count if not all items have the same reason
    if (primaryCount < itemCount) {
        message += ` (${primaryCount}/${itemCount})`;
    }
    
    // Mention other reasons exist without listing them all
    if (otherCount > 0) {
        message += `\n\n${otherCount} other ${itemWord} ${otherCount === 1 ? 'has a' : 'have'} different reason.`;
    }
    
    // Add sync documentation link if any sync-related reasons are present
    const syncRelatedReasons: MissingItemReason[] = ['pending_sync'];
    const hasSyncRelatedReason = sortedReasons.some(([reason]) => syncRelatedReasons.includes(reason));
    if (hasSyncRelatedReason) {
        const syncDocUrl = process.env.WEBAPP_BASE_URL + '/docs/trouble-file-sync';
        message += `\n\n<a href="${syncDocUrl}" className="text-link">Learn more</a> about fixing sync issues.`;
    }

    // Add warning
    addWarning({
        run_id: event.run_id,
        type: 'missing_zotero_data',
        message,
        data: {
            items: event.items,
            reason_counts: Object.fromEntries(reasonCounts),
        },
    });
}

// =============================================================================
// State Atoms
// =============================================================================

/** Whether a WebSocket chat request is currently in progress */
export const isWSChatPendingAtom = atom(false);

/** Run IDs where LLM streaming finished but post-processing (citations) is still in progress */
export const streamingDoneRunIdsAtom = atom<Set<string>>(new Set<string>());

/** Whether the WebSocket is currently connected */
export const isWSConnectedAtom = atom(false);

/** Whether the server has sent the ready event (validation complete) */
export const isWSReadyAtom = atom(false);

/** Ready event data from server (subscription, processing info) */
export const wsReadyDataAtom = atom<WSReadyData | null>(null);

/** Request acknowledgment data from server (model, charge type info) */
export const wsRequestAckDataAtom = atom<WSRequestAckData | null>(null);

/** Last error from WebSocket */
export const wsErrorAtom = atom<WSErrorEvent | null>(null);

/** Last warning from WebSocket */
export const wsWarningAtom = atom<WSWarningEvent | null>(null);

/** Retry state from WebSocket (when backend is retrying a failed request) */
export interface RetryState {
    runId: string;
    attempt: number;
    maxAttempts: number;
    reason: string;
    waitSeconds?: number | null;
}
export const wsRetryAtom = atom<RetryState | null>(null);
/** Deduplicates concurrent auto-resume/auto-retry scheduling for the same run. */
const scheduledAutoResumeRunIdsAtom = atom<Set<string>>(new Set<string>());

/**
 * Transient reconnect state while the client automatically retries a failed
 * connect attempt. Drives the status indicator's "Reconnecting…" copy instead
 * of a user-visible error.
 */
export interface ReconnectState {
    attempt: number;
    maxAttempts: number;
}
export const wsReconnectingAtom = atom<ReconnectState | null>(null);

// =============================================================================
// Action Atoms
// =============================================================================

/**
 * Reset all WebSocket state atoms
 */
export const resetWSStateAtom = atom(null, (_get, set) => {
    set(isWSChatPendingAtom, false);
    set(isWSConnectedAtom, false);
    set(isWSReadyAtom, false);
    set(wsReadyDataAtom, null);
    set(wsRequestAckDataAtom, null);
    set(wsErrorAtom, null);
    set(wsWarningAtom, null);
    set(wsRetryAtom, null);
    set(wsReconnectingAtom, null);
    set(streamingDoneRunIdsAtom, new Set<string>());
});

/**
 * Clear transient frontend state before starting a replacement run.
 * This is separate from transport-level onClose cleanup so reconnect handoffs
 * do not leak per-run approval UI or auto-approve settings into the new run.
 */
export const prepareForNewRunAtom = atom(null, (_get, set) => {
    set(resetWSStateAtom);
    set(clearAllPendingApprovalsAtom);
    set(clearAllPendingQuestionsAtom);
    set(clearAllPendingCreditConfirmationsAtom);
    set(clearApprovalResponseIntentsAtom);
    set(clearStaleApprovalsAtom);
    set(clearRunApprovalPolicyAtom);
});

/**
 * Find the args of the tool-call part that produced a given tool return, by
 * scanning the run's response messages. Used to derive the annotation-list
 * variant when synthesizing a legacy view; null when the call can't be found.
 */
function findToolCallArgs(
    run: AgentRun | null,
    toolCallId: string,
): string | Record<string, any> | null {
    if (!run) return null;
    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'tool-call' && part.tool_call_id === toolCallId) {
                return part.args;
            }
        }
    }
    return null;
}

function surfaceAndDiagnoseConnectionFailure(
    set: Setter,
    runId: string,
    evidence: ConnectionFailureEvidence,
    connectAttempts?: number,
): void {
    const applyPresentation = (
        diagnostic?: Awaited<ReturnType<typeof reportConnectionFailure>>,
    ) => {
        const presentation = presentConnectionFailure(evidence, diagnostic);
        // The diagnostic POST can take several seconds; if the user retried in
        // the meantime, this run is no longer active and the refined
        // presentation must not resurface its error over the new run's state.
        const activeId = store.get(activeRunAtom)?.id ?? null;
        if (activeId !== runId) return;
        set(wsErrorAtom, (current) =>
            current?.type && current.type !== 'connection_error'
                ? current
                : current?.run_id && current.run_id !== runId
                  ? current
                  : {
                        event: 'error',
                        type: 'connection_error',
                        message: presentation.message,
                        run_id: runId,
                        is_retryable: true,
                    },
        );
        set(activeRunAtom, (prev) =>
            prev?.id === runId &&
            (prev.status === 'in_progress' ||
                prev.status === 'awaiting_deferred' ||
                (prev.status === 'error' && prev.error?.type === 'connection_error'))
                ? {
                      ...prev,
                      status: 'error',
                      error: {
                          type: 'connection_error',
                          message: presentation.message,
                          user_facing_details: presentation.details,
                          is_retryable: true,
                      },
                  }
                : prev,
        );
    };

    applyPresentation();
    // Refine the error card once the reachability check finishes.
    void reportConnectionFailure({
        evidence,
        run_id: runId,
        connect_attempts: connectAttempts ?? null,
    }).then((diagnostic) => applyPresentation(diagnostic));
}

/**
 * Apply a run's resolved citations, whichever frame carried them.
 *
 * Citations reach the client two ways. Current backends send them on their own
 * `run_citations` event, so `run_complete` no longer has to wait out a Zotero
 * lookup. Backends that predate CLIENT_FEATURES.CITATIONS_EVENT embed them in
 * `run_complete` instead. The two frames differ in when they arrive, not in
 * what the client does with what is inside them.
 */
function applyRunCitations(
    set: Setter,
    runId: string,
    citations: Citation[] | null | undefined,
): void {
    if (!citations || citations.length === 0) return;

    logger(`WS: Processing ${citations.length} citations for run ${runId}`, 1);
    set(citationsAtom, (prev) => [
        ...prev,
        ...citations.map(c => ({ ...c, run_id: runId }))
    ]);
    set(processCitationsAtom);
    set(maybeShowCitationTipAtom);

    // Preload PDF page labels for cited attachments so the rendering path can
    // resolve page numbers from explicit render state. Runs after metadata is
    // exposed to avoid blocking the UI on PDF extraction.
    preloadPageLabelsForCitations(citations)
        .then((labelsByAttachmentId) => {
            set(mergePageLabelsByAttachmentIdAtom, labelsByAttachmentId);
        })
        .catch((err) =>
            logger(`WS: Failed to preload page labels: ${err}`, 1)
        );
}

/**
 * Create WebSocket callbacks for handling streaming events.
 * Shared between sendWSMessageAtom and regenerateFromRunAtom.
 */
function createWSCallbacks(set: Setter): WSCallbacks {
    return {
        onReady: (data: WSReadyData) => {
            logger('WS onReady:', data, 1);
            set(isWSReadyAtom, true);
            set(wsReadyDataAtom, data);

            // A successful WS handshake proves the backend is reachable and the session is valid.
            // If the profile sync was stuck in transient/fatal (and its retry backoff or the OS
            // online event hasn't cleared it), force a refresh so the header indicator drops
            // promptly instead of lingering until the next backoff tick.
            if (store.get(profileSyncStatusAtom).kind !== 'ok') {
                triggerProfileRefresh();
            }

            // Show popup if subscription is active but using frontend processing
            if (data.subscriptionStatus === SubscriptionStatus.ACTIVE &&
                store.get(isDatabaseSyncSupportedAtom) &&
                data.processingMode === ProcessingMode.FRONTEND
            ) {
                set(addPopupMessageAtom, {
                    type: 'info',
                    title: 'Indexing your library',
                    text: 'We are processing your library to enable Beta features. You can use standard features in the meantime.',
                    expire: true,
                    duration: 10000
                });
            }
        },

        onRequestAck: (data: WSRequestAckData) => {
            logger('WS onRequestAck:', data, 1);
            set(wsRequestAckDataAtom, data);
        },

        onPart: async (event: WSPartEvent) => {
            // Load item data for tool call
            if (event.part.part_kind === "tool-call") {
                logger(`WS onPart (${event.part.part_kind}):`, {
                    runId: event.run_id,
                    messageIndex: event.message_index,
                    part: event.part,
                });
                const itemReferences = extractZoteroReferencesFromToolCall(event.part);
                if (itemReferences.length > 0) {
                    logger(`WS onPart: Loading ${itemReferences.length} item data for tool call`, 1);
                    const itemPromises = itemReferences.map(async ref => {
                        const resolved = await resolveItemReference(ref);
                        return resolved.status === 'found' ? resolved.item : null;
                    });
                    const items = (await Promise.all(itemPromises)).filter((item): item is Zotero.Item => !!item);
                    if (items.length > 0) {
                        await loadFullItemDataWithAllTypes(items).catch(err => 
                            logger(`WS onPart: Failed to load item data for tool call: ${err}`, 1)
                        );
                    }
                }
            }
            // Update run with part
            set(activeRunAtom, (prev) => prev ? updateRunWithPart(prev, event) : prev);
        },

        onToolReturn: async (event: WSToolReturnEvent) => {
            logger('WS onToolReturn:', {
                runId: event.run_id,
                messageIndex: event.message_index,
                toolName: event.part.part_kind === "tool-return" ? event.part.tool_name : undefined,
                toolCallId: event.part.part_kind === "tool-return" ? event.part.tool_call_id : undefined,
            });

            // Process tool return results
            if (event.part.part_kind === "tool-return") {
                await processToolReturnResults(event.part, set);

                // Safety net: the current backend ships a hydrated `metadata.view`
                // on every tool return, but synthesize one from the legacy summary
                // when it is missing OR malformed so the shared render layer always
                // has a valid view to render. The `isToolResultView` check matches
                // the render-time predicate; `upgradeToolReturn` no-ops on a valid view.
                if (!isToolResultView(event.part.metadata?.view)) {
                    logger(`WS onToolReturn: No view model available for tool call ${event.part.tool_call_id}`, 1);
                    const toolCallArgs = findToolCallArgs(store.get(activeRunAtom), event.part.tool_call_id);
                    await upgradeToolReturn(event.part, toolCallArgs);
                }
            }

            // Update run with tool return (event.part now carries a synthesized
            // `view` when the backend omitted one).
            set(activeRunAtom, (prev) => prev ? updateRunWithToolReturn(prev, event) : prev);

            // Remove pending approval for this specific tool call (if any)
            // Note: We find approval by toolCallId since that's what we have in the event
            if (event.part.part_kind === "tool-return") {
                const toolCallId = event.part.tool_call_id;
                // Get current pending approvals and find the one for this tool call
                const pendingMap = store.get(pendingApprovalsAtom);
                for (const [actionId, pending] of pendingMap.entries()) {
                    if (pending.toolcallId === toolCallId) {
                        set(removePendingApprovalAtom, actionId);
                        break;
                    }
                }

                // Remove any pending question for this tool call. This covers
                // the backend-timeout path: after the wait expires the tool
                // returns 'no_response' and the run continues — without this
                // removal the stale card would keep the composer disabled for
                // the rest of the run (the full-clear sites only fire on run
                // end / disconnect / thread switch).
                set(removePendingQuestionAtom, toolCallId);
            }
        },

        onToolCallProgress: (event: WSToolCallProgressEvent) => {
            logger(`WS onToolCallProgress: ${event.run_id} - ${event.tool_call_id} - ${event.progress}`, 1);
            set(activeRunAtom, (prev) => prev ? updateRunWithToolCallProgress(prev, event) : prev);
        },

        onToolCallArgsStream: (event: WSToolCallArgsStreamEvent) => {
            set(activeRunAtom, (prev) => prev ? updateRunWithToolCallArgsStream(prev, event) : prev);
        },

        onStreamingDone: (event: WSStreamingDoneEvent) => {
            logger('WS onStreamingDone:', { runId: event.run_id }, 1);
            set(streamingDoneRunIdsAtom, (prev) => new Set([...prev, event.run_id]));
        },

        onRunComplete: async (event: WSRunCompleteEvent) => {
            logger('WS onRunComplete:', {
                runId: event.run_id,
                usage: event.usage,
                cost: event.cost,
                citationsCount: event.citations?.length ?? 0,
                actionsCount: event.agent_actions?.length ?? 0,
                highTokenUsage: event.high_token_usage,
            }, 1);
            set(activeRunAtom, (prev) => prev ? updateRunComplete(prev, event) : prev);
            // Streaming-done is deliberately left set: this frame now arrives
            // as soon as the run is durable, with the citation lookup still
            // running, and that state is what tells the user their sources are
            // still being linked. `onRunCitations` ends it. A backend too old
            // to send that event embeds the citations below, and `onDone` —
            // which follows immediately — is the backstop there.

            // Clear retry state when run completes
            set(wsRetryAtom, null);

            // Store transient backend flags (not persisted on AgentRun)
            if (event.high_token_usage) {
                set(backendHighTokenUsageRunsAtom, (prev) => ({ ...prev, [event.run_id]: true }));
            }

            // Citations, for a backend that still embeds them here. Current
            // ones send `citations: null` and follow with `run_citations`.
            applyRunCitations(set, event.run_id, event.citations);

            // Process agent actions from run complete event
            if (event.agent_actions && event.agent_actions.length > 0) {
                logger(`WS onRunComplete: Processing ${event.agent_actions.length} agent actions`, 1);
                const actions = event.agent_actions.map(toAgentAction);
                set(addAgentActionsAtom, actions);
                // Load item data for agent actions
                await loadItemDataForAgentActions(actions).catch(err => 
                    logger(`WS onRunComplete: Failed to load item data for agent actions: ${err}`, 1)
                );
                // Auto-apply annotations if enabled
                autoApplyAnnotationAgentActions(event.run_id, actions);
                // Auto-create notes if enabled
                await autoCreateNoteAgentActions(event.run_id, actions, set).catch(err =>
                    logger(`WS onRunComplete: Failed to auto-create notes: ${err}`, 1)
                );
            }

            // Surface an OS-native notification if the user can't currently see
            // the completed response (e.g. working in another app).
            notifyRunComplete();
        },

        onRunCitations: (event: WSRunCitationsEvent) => {
            logger('WS onRunCitations:', {
                runId: event.run_id,
                citationsCount: event.citations?.length ?? 0,
            }, 1);

            applyRunCitations(set, event.run_id, event.citations);

            // The lookup is over — whatever it found, including nothing. Every
            // other way it can end (`done`, an error, a cancel, the socket
            // closing) clears this state wholesale; only the ordinary success
            // path needs it retired one run at a time.
            set(streamingDoneRunIdsAtom, (prev) => {
                if (!prev.has(event.run_id)) return prev;
                const next = new Set(prev);
                next.delete(event.run_id);
                return next;
            });
        },

        // The event's `retry_truncation` report is deliberately not consumed:
        // this client never asks the server to reconcile a thread mid-request
        // — retries commit their removal through `POST /truncate` before the
        // run request is sent.
        onThread: (newThreadId: string) => {
            logger('WS onThread:', { threadId: newThreadId }, 1);
            set(currentThreadIdAtom, newThreadId);
            set(activeRunAtom, (prev) => prev ? { ...prev, thread_id: newThreadId } : prev);
        },

        onThreadName: (event: WSThreadNameEvent) => {
            logger('WS onThreadName:', { threadId: event.thread_id, name: event.name }, 1);
            set(currentThreadNameAtom, event.name);
        },

        onDone: () => {
            logger('WS onDone: Request fully complete', 1);

            // Clear any remaining streaming-done state (safety net)
            set(streamingDoneRunIdsAtom, new Set<string>());

            // Move active run to completed runs
            set(activeRunAtom, (prev) => {
                if (prev) {
                    const finalRun: AgentRun = {
                        ...prev,
                        status: prev.status === 'in_progress' ? 'completed' : prev.status,
                        completed_at: prev.completed_at || new Date().toISOString(),
                    };
                    set(threadRunsAtom, (runs) => [...runs, finalRun]);
                }
                return null;
            });

            agentService.close();
            set(isWSChatPendingAtom, false);
            // Clear pending approvals and dismiss diff preview
            set(clearAllPendingApprovalsAtom);
            set(clearAllPendingQuestionsAtom);
            set(clearAllPendingCreditConfirmationsAtom);
            set(clearRunApprovalPolicyAtom);
        },

        onError: (event: WSErrorEvent) => {
            logger('WS onError:', event, 1);
            const errorRunId = resolveErrorRunId(event, store.get(activeRunAtom));

            // Clear streaming-done state
            set(streamingDoneRunIdsAtom, new Set<string>());

            // The connect loop in executeWSRequest reads this atom to tell a
            // server application error from a transport failure. Leaving it
            // null makes the connect rejection that follows a pre-ready error
            // look like a connection failure, which files a false connection
            // diagnostic.
            set(wsErrorAtom, event);
            set(activeRunAtom, (prev) => {
                if (!prev) return prev;
                if (errorRunId && prev.id !== errorRunId) return prev;
                return {
                    ...prev,
                    status: 'error',
                    error: toRunError(event),
                };
            });
            set(isWSChatPendingAtom, false);
            // Clear retry state on error
            set(wsRetryAtom, null);
            // Clear pending approvals and dismiss diff preview (run failed)
            set(clearAllPendingApprovalsAtom);
            set(clearAllPendingQuestionsAtom);
            set(clearAllPendingCreditConfirmationsAtom);
            set(clearRunApprovalPolicyAtom);

            // Run quality flag for a run that did not complete. Keyed by run id
            // in an atom that never consults run status, so a failed run drives
            // the same composer warning a finished one does — the composer's
            // own fallback reads `total_usage`, which a failed run has none of.
            // Defensive: the backend carries this on the `run_complete` frame it
            // sends ahead of the error, so `onRunComplete` normally has it first.
            if (errorRunId && event.high_token_usage) {
                set(backendHighTokenUsageRunsAtom, (prev) => ({ ...prev, [errorRunId]: true }));
            }

            if (
                event.try_auto_resume &&
                errorRunId &&
                !store.get(scheduledAutoResumeRunIdsAtom).has(errorRunId)
            ) {
                // Retry when only thinking has streamed so far (nothing
                // user-visible to preserve). Otherwise resume from the
                // failure point so streamed text/tool calls are kept.
                //
                // If the failed run is itself a resume run, always auto-resume
                // — earlier runs in the resume chain may hold user-visible
                // content, and a retry would truncate the chain from its root.
                const failedRun = findRunForResume(
                    store.get(threadRunsAtom),
                    store.get(activeRunAtom),
                    errorRunId,
                );
                const retryInsteadOfResume =
                    !failedRun?.user_prompt.is_resume &&
                    hasOnlyThinkingParts(failedRun);

                set(scheduledAutoResumeRunIdsAtom, (prev: Set<string>) => {
                    const next = new Set(prev);
                    next.add(errorRunId);
                    return next;
                });

                // Run synchronously so the replacement run is set in the
                // same batch as the error state — React renders once with the
                // final state, avoiding an intermediate flash of the error or
                // resume placeholder.
                if (retryInsteadOfResume) {
                    store.set(autoRetryErroredRunAtom, errorRunId);
                } else {
                    store.set(autoResumeErroredRunAtom, errorRunId);
                }
            }
        },

        onWarning: (event: WSWarningEvent) => {
            logger('WS onWarning:', event, 1);
            set(wsWarningAtom, event);
            // Add to dismissable warnings
            set(addWarningAtom, {
                run_id: event.run_id,
                type: event.type,
                message: event.message,
                data: event.data,
            });
        },

        onRetry: (event: WSRetryEvent) => {
            logger('WS onRetry:', event, 1);
            set(wsRetryAtom, {
                runId: event.run_id,
                attempt: event.attempt,
                maxAttempts: event.max_attempts,
                reason: event.reason,
                waitSeconds: event.wait_seconds,
            });

            // If reset is true, clear any partial content that was streamed
            if (event.reset) {
                logger(`WS onRetry: resetting run messages for run ${event.run_id}`, 1);
                set(activeRunAtom, (prev) => prev ? resetRunMessages(prev) : prev);
            }
        },

        onAgentActions: async (event: WSAgentActionsEvent) => {
            logger('WS onAgentActions:', {
                runId: event.run_id,
                actionsCount: event.actions.length,
            }, 1);
            const actions = event.actions.map(toAgentAction);
            set(upsertAgentActionsAtom, actions);
            
            // Mark external references as imported for applied create_items actions
            // This handles cases where actions are applied via PendingActionsBar
            for (const action of actions) {
                if (
                    action.action_type === 'create_item' &&
                    action.status === 'applied' &&
                    action.result_data
                ) {
                    const proposedData = action.proposed_data as CreateItemProposedData;
                    const resultData = action.result_data as CreateItemResultData;
                    
                    if (proposedData?.item?.source_id && resultData.library_id && resultData.zotero_key) {
                        set(markExternalReferenceImportedAtom, proposedData.item.source_id, {
                            library_id: resultData.library_id,
                            zotero_key: resultData.zotero_key,
                            library_ref: resultData.library_ref,
                        });
                        logger(`WS onAgentActions: Marked external reference ${proposedData.item.source_id} as imported`, 1);
                    }
                }
            }
            
            // Load item data for agent actions
            await loadItemDataForAgentActions(actions).catch(err => 
                logger(`WS onAgentActions: Failed to load item data for agent actions: ${err}`, 1)
            );
            // Auto-apply annotations if enabled
            autoApplyAnnotationAgentActions(event.run_id, actions);
        },

        onMissingZoteroData: (event: WSMissingZoteroDataEvent) => {
            logger('WS onMissingZoteroData:', {
                runId: event.run_id,
                itemCount: event.items.length,
                items: event.items,
            }, 1);
            // Get userId from store for pending sync check
            const userId = store.get(userIdAtom);
            // Process asynchronously to determine reasons and add warning
            handleMissingZoteroData(
                event,
                userId,
                (params) => set(addWarningAtom, params)
            ).catch(err => 
                logger(`WS onMissingZoteroData: Failed to handle missing data: ${err}`, 1)
            );
        },

        onDeferredApprovalRequest: (event: WSDeferredApprovalRequest) => {
            logger('WS onDeferredApprovalRequest:', {
                actionId: event.action_id,
                toolcallId: event.toolcall_id,
                actionType: event.action_type,
            }, 1);

            // Cost confirmations arrive this way only from a backend that
            // predates the run-level credit confirmation. They are shown like
            // any other approval: what a request may spend is decided once per
            // run by the credit limit, never per tool call.

            // A grant can be selected while other validation requests are
            // already in flight. Catch those requests here even though future
            // validations will return always_apply directly.
            const runPolicy = store.get(runApprovalPolicyAtom);
            const activeRunId = store.get(activeRunAtom)?.id ?? null;
            if (isActionApprovedForCurrentRun(
                runPolicy,
                activeRunId,
                event.action_type,
                event.action_data,
            )) {
                logger(`Auto-approving ${event.action_type} for the current run`, 1);
                agentService.sendApprovalResponse(event.action_id, true);
                return;
            }

            // Default: add to pending approvals map for UI rendering
            set(addPendingApprovalAtom, event);
        },

        onDeferredApprovalStale: (event: WSDeferredApprovalStale) => {
            logger('WS onDeferredApprovalStale:', {
                actionId: event.action_id,
                reason: event.reason,
            }, 1);
            // The decision arrived after the backend stopped waiting, so the run
            // never saw it. Retire the approval and let the card fall back to
            // applying the (still valid) proposal locally.
            set(markApprovalStaleAtom, event.action_id);
            set(removePendingApprovalAtom, event.action_id);
            set(removeApprovalResponseIntentAtom, event.action_id);
        },

        onCreditConfirmationRequest: (event: WSCreditConfirmationRequest) => {
            logger('WS onCreditConfirmationRequest:', {
                confirmationId: event.confirmation_id,
                runId: event.run_id,
                pendingCredits: event.pending_credits,
                projectedTotalCredits: event.projected_total_credits,
                threshold: event.threshold,
            }, 1);
            // Always surface the card. Whether to ask at all, and above which
            // projected total, is decided by the backend from the preferences
            // sent with the run request.
            set(addPendingCreditConfirmationAtom, event);

            // Surface an OS-native notification if the user can't currently see
            // the card — the run stays parked until they decide.
            notifyCreditConfirmation(event);
        },

        onCreditConfirmationStale: (event: WSCreditConfirmationStale) => {
            logger('WS onCreditConfirmationStale:', {
                confirmationId: event.confirmation_id,
                reason: event.reason,
            }, 1);
            // The run moved on without the answer and there is nothing to apply
            // locally, so the card is simply retired.
            set(removePendingCreditConfirmationAtom, event.confirmation_id);
        },

        onAskUserQuestionRequest: (event: WSAskUserQuestionRequest) => {
            logger('WS onAskUserQuestionRequest:', {
                questionId: event.question_id,
                toolcallId: event.toolcall_id,
                questionCount: event.questions.length,
            }, 1);
            set(addPendingQuestionAtom, event);

            // Surface an OS-native notification if the user can't currently see
            // the question panel (e.g. working in another app), mirroring the
            // deferred-approval path.
            notifyUserQuestion(event);
        },

        onOpen: () => {
            logger('WS onOpen: Connection established, waiting for ready...', 1);
            set(isWSConnectedAtom, true);
        },

        onClose: (code: number, reason: string, wasClean: boolean, transportEvidence) => {
            logger(`WS onClose: code=${code}, reason=${reason}, clean=${wasClean}`, 1);
            // Whether this connection had received the `ready` event, read
            // before the flag is cleared below. Distinguishes a connect-phase
            // failure (reported once by executeWSRequest's catch) from a
            // post-ready drop (handled here).
            const hadReachedReady = store.get(isWSReadyAtom);
            // set(activeRunAtom, null);
            set(isWSConnectedAtom, false);
            set(isWSReadyAtom, false);
            // A retry commit in flight owns the pending flag: this close
            // belongs to the failed run the retry is replacing (onError
            // dispatched it before the server closed the socket), and
            // clearing here would re-enable the composer mid-commit. The
            // retry flow clears or re-asserts the flag on every exit.
            if (!store.get(retryPendingRunIdAtom)) {
                set(isWSChatPendingAtom, false);
            }
            // Clear streaming-done state (connection lost during post-processing)
            set(streamingDoneRunIdsAtom, new Set<string>());
            // Clear pending approvals and dismiss diff preview (connection lost)
            set(clearAllPendingApprovalsAtom);
            set(clearAllPendingQuestionsAtom);
            set(clearAllPendingCreditConfirmationsAtom);
            set(clearRunApprovalPolicyAtom);

            // A run that reached `completed` (run_complete processed) but whose
            // terminal `done` never arrived — the socket closed while run_complete
            // post-processing was still draining the message queue, so the queued
            // `done` was skipped by the connection-generation guard — lingers in
            // activeRunAtom. Finalize it the way onDone would, so the next send does
            // not overwrite and drop it from local history. Idempotent: the normal
            // path nulls activeRunAtom in onDone before close, making this a no-op.
            set(activeRunAtom, (prev) => {
                const finalRun = lingeringCompletedRun(prev);
                if (finalRun) {
                    set(threadRunsAtom, (runs) => appendRunIfMissing(runs, finalRun));
                    return null;
                }
                return prev;
            });

            // A post-ready close that carries transport evidence came from the real
            // socket (the client's own close()/cancel() paths notify without
            // evidence). When it lands while the run is still nonterminal the server
            // never delivered a terminal event — including a clean code-1000 close,
            // which would otherwise leave the run spinning forever with no error and
            // no retry. Connect-phase failures (before ready) are reported by
            // executeWSRequest's catch, so gate on hadReachedReady to avoid
            // double-reporting them.
            if (hadReachedReady && transportEvidence) {
                const activeRun = store.get(activeRunAtom);
                if (
                    activeRun &&
                    (activeRun.status === 'in_progress' ||
                        activeRun.status === 'awaiting_deferred')
                ) {
                    surfaceAndDiagnoseConnectionFailure(set, activeRun.id, transportEvidence);
                }
            }
        }
    };
}

/**
 * Execute a WebSocket request with the given run and request.
 * Handles connection, callbacks, and error handling.
 * Model selection options are included in the request itself.
 *
 * Transient pre-`ready` transport failures (1005/1006, connect timeout) are
 * retried automatically with jittered backoff before anything is surfaced to
 * the user: a cold-starting instance or momentary network block routinely
 * succeeds on the next attempt. The shared loop owns that policy, including
 * which failures never qualify; this function owns only what the user and the
 * store see. One error surface and one diagnostics report (carrying the attempt
 * count) happen only after the final attempt fails.
 */
async function executeWSRequest(
    run: AgentRun,
    request: AgentRunRequest,
    get: Getter,
    set: Setter
): Promise<void> {
    const result = await connectWithRetry({
        service: agentService,
        request,
        callbacks: createWSCallbacks(set),
        logLabel: `run ${run.id}`,
        // Every attempt starts from a clean ready state.
        onAttempt: () => set(isWSReadyAtom, false),
        onRetrying: (progress) => {
            if (!progress) {
                set(wsReconnectingAtom, null);
                return;
            }
            // The loop's teardown of the failed attempt cleared the pending flag
            // via onClose; restore it so the composer stays blocked while we
            // quietly retry.
            set(isWSChatPendingAtom, true);
            set(wsReconnectingAtom, progress);
        },
        // An error already set by the onError callback must not be overwritten
        // with a generic connection_error.
        isAlreadyReported: () => {
            const currentError = get(wsErrorAtom);
            return !!currentError && currentError.type !== 'connection_error';
        },
        // The run may have been cancelled, replaced, or rolled back during the
        // backoff wait — a retry whose tail was restored drops its shell here.
        isStillWanted: () => {
            const activeRun = store.get(activeRunAtom);
            return (
                activeRun?.id === run.id &&
                (activeRun.status === 'in_progress' || activeRun.status === 'awaiting_deferred')
            );
        },
    });

    if (result.kind === 'connected') return;

    if (result.kind === 'abandoned') {
        if (result.reason === 'already_reported') {
            logger('WS connection error: Error already set by onError callback, not overwriting', 1);
            // The onError that set this error may have dispatched an auto-retry
            // whose commit is now in flight and owns the pending flag (see
            // retryPendingRunIdAtom).
            if (!get(retryPendingRunIdAtom)) {
                set(isWSChatPendingAtom, false);
            }
            return;
        }
        logger(`WS connect retry abandoned: run ${run.id} is no longer active`, 1);
        // Release the flag the quiet retry raised. Nothing downstream clears it
        // on this path, and a stuck flag leaves the composer blocked with no run
        // to finish and no error to show.
        set(isWSChatPendingAtom, false);
        return;
    }

    surfaceAndDiagnoseConnectionFailure(set, run.id, result.evidence, result.attemptsMade);
    set(isWSChatPendingAtom, false);
}

/**
 * Send a chat message via WebSocket
 * 
 * Flow:
 * 1. Create AgentRun shell → set activeRunAtom → UI shows user message + spinner
 * 2. Connect WebSocket with auth params
 * 3. Receive "ready" event → send AgentRunRequest
 * 4. "part" events → update model_messages with text/thinking/tool_call
 * 5. "tool_return" events → add ToolReturnPart to model_messages
 * 6. "run_complete" event → update usage, set status="completed"
 * 7. "done" event → move activeRun to threadRuns, close connection
 */
export interface SendWSMessageOptions {
    runIdOverride?: string;
    permissionsOverride?: Partial<ChargingPermissions>;
    origin?: PromptOrigin;
    /** Saved actions invoked as /command tokens in the message content */
    actions?: PromptAction[];
}

export const sendWSMessageAtom = atom(
    null,
    async (
        get,
        set,
        message: string,
        options?: SendWSMessageOptions,
    ) => {
        const { runIdOverride, permissionsOverride, origin, actions } = options ?? {};
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
        
        // Dismiss any open diff preview before sending
        dismissDiffPreview();

        // Reset state
        set(prepareForNewRunAtom);
        prewarmMuPDFWorker();
        set(isWSChatPendingAtom, true);

        try {
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
        const currentNoteTabItem = get(currentNoteItemAtom);
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
            selectedItems
                .map(item => toMessageAttachment(item))
                .filter((attachment): attachment is MessageAttachment => attachment !== null);
        attachments = await processImageAnnotations(attachments);

        // Add collection attachments if set
        const messageCollections = get(currentMessageCollectionsAtom)
            .filter(col => searchableLibraryIds.includes(col.library_id));
        for (const col of messageCollections) {
            attachments.push({
                type: 'collection',
                library_id: col.library_id,
                zotero_key: col.zotero_key,
                library_ref: col.library_ref,
                name: col.name,
                parent_key: col.parent_key,
            });
        }

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
            const externalAttachment: ExternalFileAttachment = {
                type: 'external_file',
                ext_key: file.extKey,
                filename: file.filename,
                content_kind: file.contentKind,
                mime_type: file.mimeType,
                file_size: file.fileSize,
                ...(file.pageCount ? { page_count: file.pageCount } : {}),
                date_added: new Date(file.createdAt).toISOString(),
            };
            attachments.push(externalAttachment);
        }

        // Add the current reader attachment as a source if it is not already in
        // the thread. Reader position is captured in application state. Send gate:
        // never auto-attach a reader source in a library the user excluded from
        // Beaver — this path bypasses the currentMessageItems gate above.
        const readerAttachment = get(currentReaderAttachmentAtom);
        if (readerAttachment && searchableLibraryIds.includes(readerAttachment.libraryID)) {
            const allUserAttachmentKeys = get(allUserAttachmentKeysAtom);
            const existingKeys = new Set([
                ...attachments.map(messageAttachmentKey),
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
                attachments.push({
                    library_id: readerAttachment.libraryID,
                    zotero_key: readerAttachment.key,
                    library_ref: libraryRefForLibraryID(readerAttachment.libraryID) ?? undefined,
                    type: 'source',
                    attachment: safeStub(() => serializeAttachmentStub(readerAttachment)),
                    parent_item: safeStub(() => readerAttachment.parentItem ? serializeItemStub(readerAttachment.parentItem) : undefined),
                    include: 'fulltext'
                } as SourceAttachment);
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
                ...attachments.map(messageAttachmentKey),
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
        const applicationState = await getApplicationStateProvider()(get);

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
        };

        // Get current thread ID (null for new thread)
        const threadId = get(currentThreadIdAtom);

            // Set temporary thread name for new threads (mirrors backend thread_name_hint[:35])
            if (!threadId && message) {
                set(currentThreadNameAtom, message.substring(0, 35));
            }

            // Get user ID for the run
            const userId = get(userIdAtom);
            if (!userId) {
                logger('User ID not found', 1);
                set(isWSChatPendingAtom, false);
                return;
            }

            // A failed run still in the active slot has to stay in local
            // history: the server persisted it, and overwriting the slot
            // without archiving would drop it from the client's view — a
            // ghost in the middle of the server thread.
            archiveTerminalActiveRun(get, set);

            // Create AgentRun shell and request
            const { run, request } = createAgentRunShell(
                userPrompt,
                threadId,
                userId,
                model?.name ?? 'unknown',
                modelOptions,
                model?.provider,
                customInstructions,
                model?.is_custom ? model.custom_model : undefined,
                runIdOverride,
                permissionsOverride,
            );

            // Set active run - UI now shows user message + spinner
            set(activeRunAtom, run);

            // Reset user message input after creating the run
            set(clearComposerAtom);
            set(removePopupMessagesByTypeAtom, ['items_summary']);
            set(currentMessageItemsAtom, []);
            set(currentMessageCollectionsAtom, []);
            set(currentMessageExternalFilesAtom, []);

            // Execute the WebSocket request
            await executeWSRequest(run, request, get, set);
        } catch (error) {
            // Catch any unexpected errors during message preparation
            logger('sendWSMessageAtom: Unexpected error:', error, 1);
            set(wsErrorAtom, {
                event: 'error',
                type: 'preparation_error',
                message: error instanceof Error ? error.message : 'Failed to prepare message',
                is_retryable: true,
            });
            set(activeRunAtom, null);
            set(isWSChatPendingAtom, false);
        }
    }
);

/** How a regenerate path replaces the target run. */
interface RegenerateRunOptions {
    logPrefix: string;
    /**
     * Walk a resume chain back to its root so the regeneration starts from
     * the original user message (retry buttons). Edited-prompt retries target
     * the named run itself.
     */
    walkResumeChain: boolean;
    /** Replacement prompt; defaults to the target run's own prompt. */
    editedPrompt?: BeaverAgentPrompt;
    /** Failure message for the generic error card. */
    failureMessage: string;
}

/**
 * Regenerate a response from a specific run. The single implementation behind
 * every user-driven retry (retry button, error-card retry, edit-and-retry).
 *
 * Flow:
 * 1. Find the run to regenerate from (canceling it first if still live)
 * 2. Confirm undoing applied agent actions (cancel aborts, nothing sent)
 * 3. Commit the removal on the backend (`POST /truncate`) — on failure or
 *    refusal nothing has changed on either side, so the exits are a popup
 *    (plus a thread reload on refusal) and an intact thread
 * 4. Undo applied actions if the user chose to, remove the runs and their
 *    actions/citations locally
 * 5. Create the replacement run and execute it via WebSocket
 */
async function startRegenerateRun(
    get: Getter,
    set: Setter,
    runId: string,
    options: RegenerateRunOptions,
): Promise<void> {
    const { logPrefix, walkResumeChain, editedPrompt, failureMessage } = options;
    logger(`${logPrefix}: Regenerating from run ${runId}`, 1);

    // One retry at a time: retry controls of other runs stay clickable while
    // a commit is in flight, and a second truncation would race the first.
    if (retryCommitInFlight(get, logPrefix)) return;

    // Dismiss any open diff preview before regenerating
    dismissDiffPreview();

    let newRunId: string | null = null;

    try {
        // Get current model
        const model = get(selectedModelAtom);
        if (!model) {
            logger(`${logPrefix}: No model selected`, 1);
            return;
        }

        // Get user ID
        const userId = get(userIdAtom);
        if (!userId) {
            logger(`${logPrefix}: No user ID found`, 1);
            return;
        }

        // Fold a terminal run out of the active slot into thread history
        // before the removed set is computed: a failed run being replaced
        // contributes its applied actions to the confirm dialog and its ID
        // to the POSTed removal (it is persisted server-side).
        archiveAndClearTerminalActiveRun(get, set);

        // Find the run — a terminal run was archived into threadRuns above,
        // so only a still-live run is found through the active slot.
        const threadRuns = get(threadRunsAtom);
        const activeRun = get(activeRunAtom);

        let targetRun: AgentRun | null = null;
        let runIndex = threadRuns.findIndex(r => r.id === runId);

        if (runIndex >= 0) {
            targetRun = threadRuns[runIndex];
        } else if (activeRun?.id === runId) {
            // The run is currently active - cancel it and resubmit
            targetRun = activeRun;
            runIndex = threadRuns.length;
            // Clear the active run before awaiting cancel: agentService.cancel()
            // waits for the cancel message to flush, and if the socket closes
            // uncleanly during that window, the onclose handler must not see this
            // run still marked active and misattribute the close as a connection
            // failure. The pending flag stays set until cancel resolves so the
            // composer guard keeps blocking new sends during the flush.
            set(activeRunAtom, null);
            await agentService.cancel();
            set(isWSChatPendingAtom, false);
        }

        if (!targetRun) {
            logger(`${logPrefix}: Run ${runId} not found`, 1);
            return;
        }

        // If the target is a resume run, walk the resume chain back to the
        // root so we regenerate from the original user message, not from an
        // intermediate resume prompt (whose content is empty). The root
        // always lives in threadRuns — startResumeRun guarantees the failed
        // run is appended to threadRuns before the resume is started.
        if (walkResumeChain) {
            const allRunsForChain: AgentRun[] = activeRun && !threadRuns.some(r => r.id === activeRun.id)
                ? [...threadRuns, activeRun]
                : threadRuns;
            const rootRun = findResumeChainRoot(targetRun, allRunsForChain);
            if (rootRun.id !== targetRun.id) {
                const rootIndex = threadRuns.findIndex(r => r.id === rootRun.id);
                if (rootIndex >= 0) {
                    logger(`${logPrefix}: walking resume chain, using root run ${rootRun.id}`, 1);
                    targetRun = rootRun;
                    runIndex = rootIndex;
                }
            }
        }

        // Get thread ID from the target run (may not be set in currentThreadIdAtom yet)
        const threadId = get(currentThreadIdAtom) || targetRun.thread_id;

        // Runs the retry replaces: the target and everything after it. A live
        // target canceled out of the active slot is not in threadRuns, so it
        // is named explicitly — the backend ignores IDs it never persisted.
        const removedRuns = threadRuns.slice(runIndex);
        const runIdsToRemove = removedRuns.map(r => r.id);
        if (!runIdsToRemove.includes(targetRun.id)) {
            runIdsToRemove.push(targetRun.id);
        }

        // Find applied actions for runs being removed
        const allAgentActions = get(threadAgentActionsAtom);
        const actionsInRemovedRuns = allAgentActions.filter(a => runIdsToRemove.includes(a.run_id));

        // Categorize by type - only include applied actions
        const annotationsToDelete = actionsInRemovedRuns
            .filter((action) =>
                (isAnnotationAgentAction(action) && hasAppliedZoteroItem(action)) ||
                (isCreateAnnotationsAgentAction(action) && hasAppliedBulkAnnotations(action))
            );
        const annotationEditsToUndo = actionsInRemovedRuns
            .filter(isEditAnnotationsAgentAction)
            .filter(a => a.status === 'applied');
        const zoteroNotesToDelete = actionsInRemovedRuns
            .filter(isZoteroNoteAgentAction)
            .filter(hasAppliedZoteroItem);
        const metadataEditsToUndo = actionsInRemovedRuns
            .filter(isEditMetadataAgentAction)
            .filter(a => a.status === 'applied');
        const createItemsToUndo = actionsInRemovedRuns
            .filter(isCreateItemAgentAction)
            .filter(a => a.status === 'applied');
        const createCollectionsToUndo = actionsInRemovedRuns
            .filter(isCreateCollectionAgentAction)
            .filter(a => a.status === 'applied');
        const organizeItemsToUndo = actionsInRemovedRuns
            .filter(isOrganizeItemsAgentAction)
            .filter(a => a.status === 'applied');
        const manageTagsToUndo = actionsInRemovedRuns
            .filter(isManageTagsAgentAction)
            .filter(a => a.status === 'applied');
        const manageCollectionsToUndo = actionsInRemovedRuns
            .filter(isManageCollectionsAgentAction)
            .filter(a => a.status === 'applied');
        const noteEditsToUndo = actionsInRemovedRuns
            .filter(isAnyEditNoteAgentAction)
            .filter(a => a.status === 'applied');
        const createNotesToUndo = actionsInRemovedRuns
            .filter(isCreateNoteAgentAction)
            .filter(a => a.status === 'applied');

        // Prompt the user to confirm undoing applied actions. The dialog is
        // the consent and must precede the truncate POST: a user who cancels
        // leaves no trace anywhere. The undo itself executes only after the
        // backend confirms, so a failed POST changes nothing.
        let confirmResult: UndoConfirmResult = 'skip';
        const hasActionsToUndo = annotationsToDelete.length > 0 || annotationEditsToUndo.length > 0 ||
                                 zoteroNotesToDelete.length > 0 ||
                                 metadataEditsToUndo.length > 0 || noteEditsToUndo.length > 0 ||
                                 createItemsToUndo.length > 0 ||
                                 createCollectionsToUndo.length > 0 || organizeItemsToUndo.length > 0 ||
                                 manageTagsToUndo.length > 0 || manageCollectionsToUndo.length > 0 ||
                                 createNotesToUndo.length > 0;
        if (hasActionsToUndo) {
            confirmResult = confirmUndoAppliedActions({
                annotations: annotationsToDelete,
                annotationEdits: annotationEditsToUndo,
                zoteroNotes: zoteroNotesToDelete,
                metadataEdits: metadataEditsToUndo,
                noteEdits: noteEditsToUndo,
                createItems: createItemsToUndo,
                createCollections: createCollectionsToUndo,
                organizeItems: organizeItemsToUndo,
                manageTags: manageTagsToUndo,
                manageCollections: manageCollectionsToUndo,
                createNotes: createNotesToUndo,
            });
            if (confirmResult === 'cancel') {
                return;
            }
        }

        // Commit the removal on the backend before anything local changes.
        // The retry control's spinner and the composer's pending flag cover
        // the round trip; every failure exit clears both. A thread the
        // backend never assigned has nothing persisted to truncate (a first
        // run that died before the thread event).
        set(retryPendingRunIdAtom, runId);
        set(isWSChatPendingAtom, true);
        if (threadId) {
            // The run the client expects to survive as the thread's last —
            // the backend refuses when its survivor differs (rewritten by
            // another client), instead of misreading a stale retry as an
            // idempotent replay.
            const expectedTailRunId = runIndex > 0 ? threadRuns[runIndex - 1].id : null;
            const outcome = await truncateThreadOnServer(
                threadId,
                runIdsToRemove,
                expectedTailRunId,
                logPrefix,
            );
            if (outcome === 'failed') {
                set(retryPendingRunIdAtom, null);
                set(isWSChatPendingAtom, false);
                set(addPopupMessageAtom, {
                    type: 'error',
                    title: 'Retry failed',
                    text: 'Beaver could not be reached to start the retry. Nothing was changed — please try again.',
                    expire: true,
                });
                return;
            }
            if (outcome === 'refused') {
                set(retryPendingRunIdAtom, null);
                set(isWSChatPendingAtom, false);
                set(addPopupMessageAtom, {
                    type: 'warning',
                    title: 'Chat changed elsewhere',
                    text: 'This chat was changed somewhere else (for example on another device), so the retry was not applied. Reloading the chat.',
                    expire: true,
                });
                // Show the thread whole, including whatever was added elsewhere.
                await set(loadThreadAtom, {
                    user_id: userId,
                    threadId,
                    skipInstanceMismatchConfirm: true,
                });
                return;
            }
        }

        if (confirmResult === 'undo') {
            // Single reverse-chronological pass across all applied
            // actions. Cross-type ordering matters — e.g. a
            // create_collection undo cascades to descendants, so any
            // later manage_collections moves into it must be undone
            // first. See undoAppliedActionsInReverse for details.
            await undoAppliedActionsInReverse(actionsInRemovedRuns);
        }

        await cleanupTemporaryAnnotationsForRunReplacement(logPrefix);

        // Truncate runs - keep only runs before the target
        set(threadRunsAtom, (prev) =>
            prev.filter(r => !runIdsToRemove.includes(r.id))
        );

        // Clear agent actions for removed runs
        set(threadAgentActionsAtom, (prev) =>
            prev.filter(a => !runIdsToRemove.includes(a.run_id))
        );

        // Clear citations for removed runs
        set(citationsAtom, (prev) =>
            prev.filter(c => !runIdsToRemove.includes(c.run_id ?? ''))
        );
        set(processCitationsAtom);
        set(maybeShowCitationTipAtom);

        // Reset WS state and set pending
        set(prepareForNewRunAtom);
        prewarmMuPDFWorker();
        set(isWSChatPendingAtom, true);

        // Build model selection options
        const modelOptions = buildModelSelectionOptions(model);
        const customInstructions = getPref('customInstructions') || undefined;

        // Create new AgentRun shell with the replacement prompt
        const { run: newRun, request } = createAgentRunShell(
            editedPrompt ?? targetRun.user_prompt,
            threadId,
            userId,
            model.name,
            modelOptions,
            model.provider,
            customInstructions,
            model.is_custom ? model.custom_model : undefined,
        );

        // Set active run - UI now shows user message + spinner, which takes
        // over from the retry control's own loading state.
        newRunId = newRun.id;
        set(activeRunAtom, newRun);
        set(retryPendingRunIdAtom, null);

        // Execute the WebSocket request
        await executeWSRequest(newRun, request, get, set);
    } catch (error) {
        // Catch any unexpected errors during regeneration
        logger(`${logPrefix}: Unexpected error:`, error, 1);
        set(wsErrorAtom, {
            event: 'error',
            type: 'regeneration_error',
            message: error instanceof Error ? error.message : failureMessage,
            is_retryable: true,
        });
        set(activeRunAtom, prev => (newRunId && prev?.id === newRunId ? null : prev));
        set(retryPendingRunIdAtom, prev => (prev === runId ? null : prev));
        set(isWSChatPendingAtom, false);
    }
}

/**
 * Regenerate a response from a specific run (retry button and error card).
 */
export const regenerateFromRunAtom = atom(
    null,
    async (get, set, runId: string) => {
        await startRegenerateRun(get, set, runId, {
            logPrefix: 'regenerateFromRunAtom',
            walkResumeChain: true,
            failureMessage: 'Failed to regenerate response',
        });
    }
);

/**
 * Regenerate from a run with an edited user prompt.
 * Same flow as regenerateFromRunAtom, with a replacement prompt.
 */
export const regenerateWithEditedPromptAtom = atom(
    null,
    async (get, set, params: { runId: string; editedPrompt: BeaverAgentPrompt }) => {
        await startRegenerateRun(get, set, params.runId, {
            logPrefix: 'regenerateWithEditedPromptAtom',
            walkResumeChain: false,
            editedPrompt: params.editedPrompt,
            failureMessage: 'Failed to regenerate with edited prompt',
        });
    }
);

/**
 * Resume a failed run from its error point.
 * 
 * Flow:
 * 1. Find the failed run
 * 2. Create a new run with is_resume=true and empty content
 * 3. Execute via WebSocket
 * 
 * The backend will continue from where it left off and the UI will hide the error run
 * when displaying the resumed run.
 */
export const autoResumeErroredRunAtom = atom(
    null,
    async (get, set, failedRunId: string) => {
        try {
            await startResumeRun(get, set, failedRunId, {
                requireResumable: false,
                logPrefix: 'autoResumeErroredRunAtom',
                failureErrorType: 'auto_resume_error',
                failureMessage: 'Failed to automatically resume run',
            });
        } finally {
            set(scheduledAutoResumeRunIdsAtom, (prev: Set<string>) => {
                const next = new Set(prev);
                next.delete(failedRunId);
                return next;
            });
        }
    }
);

/**
 * Auto-retry a failed run from the original user prompt.
 *
 * Used when the frontend has received only thinking content (no text or tool
 * calls) at the time of the error — nothing user-visible to preserve, so we
 * restart cleanly instead of resuming.
 */
export const autoRetryErroredRunAtom = atom(
    null,
    async (get, set, failedRunId: string) => {
        try {
            await startAutoRetryRun(get, set, failedRunId);
        } finally {
            set(scheduledAutoResumeRunIdsAtom, (prev: Set<string>) => {
                const next = new Set(prev);
                next.delete(failedRunId);
                return next;
            });
        }
    }
);

export const resumeFromRunAtom = atom(
    null,
    async (get, set, failedRunId: string) => {
        await startResumeRun(get, set, failedRunId, {
            requireResumable: true,
            logPrefix: 'resumeFromRunAtom',
            failureErrorType: 'resume_error',
            failureMessage: 'Failed to resume run',
        });
    }
);

/**
 * Close the WebSocket connection with proper cancellation.
 * Sends a cancel message to the backend before closing to ensure proper cleanup.
 */
export const closeWSConnectionAtom = atom(null, async (get, set) => {
    // Set pending to false immediately for better UI responsiveness
    set(isWSChatPendingAtom, false);

    // Clear any pending approvals (for parallel tool calls that were awaiting user response)
    set(clearAllPendingApprovalsAtom);
    set(clearAllPendingQuestionsAtom);
    set(clearAllPendingCreditConfirmationsAtom);
    set(clearApprovalResponseIntentsAtom);
    set(clearRunApprovalPolicyAtom);

    // Mark active run as canceled if it exists
    const activeRun = get(activeRunAtom);
    if (activeRun && activeRun.status === 'in_progress') {
        const canceledRun: AgentRun = {
            ...activeRun,
            status: 'canceled',
            completed_at: new Date().toISOString(),
        };
        // Move canceled run to completed runs
        set(threadRunsAtom, (runs) => [...runs, canceledRun]);
        set(activeRunAtom, null);
    }

    // Clear streaming-done state (user canceled during post-processing)
    set(streamingDoneRunIdsAtom, new Set<string>());

    // Send cancel message and close connection
    await agentService.cancel();
    set(isWSConnectedAtom, false);
    set(isWSReadyAtom, false);
});

/**
 * Clear the current thread and start fresh
 */
export const clearThreadAtom = atom(null, (_get, set) => {
    set(threadRunsAtom, []);
    set(activeRunAtom, null);
    set(currentThreadIdAtom, null);
    set(resetWSStateAtom);
    // Clear agent actions, citations, and warnings for the thread
    set(clearAgentActionsAtom);
    set(citationsAtom, []);
    set(resetCitationMarkersAtom);  // Reset citation markers for cleared thread
    set(clearWarningsAtom);
    // Clear pending questions so a reset never leaves the composer disabled
    // behind an unanswerable card (pending approvals are left as-is here).
    set(clearAllPendingQuestionsAtom);
    set(clearAllPendingCreditConfirmationsAtom);
    set(clearRunApprovalPolicyAtom);
});

/**
 * Best-effort local record of approval/reject intent keyed by deferred action id.
 * Used by views to keep the correct spinner visible after a pending approval is removed.
 */
export const approvalResponseIntentsAtom = atom<Map<string, boolean>>(new Map());

export const removeApprovalResponseIntentAtom = atom(
    null,
    (_get, set, actionId: string) => {
        set(approvalResponseIntentsAtom, (prev) => {
            if (!prev.has(actionId)) return prev;
            const next = new Map(prev);
            next.delete(actionId);
            return next;
        });
    },
);

export const clearApprovalResponseIntentsAtom = atom(
    null,
    (_get, set) => {
        set(approvalResponseIntentsAtom, new Map());
    },
);

/**
 * Deferred actions whose approval channel is closed: the user's decision either
 * never left the client (socket down) or reached a backend that had already
 * stopped waiting (`deferred_approval_stale`). The run cannot act on it.
 *
 * The proposal itself is untouched — still stored, still applicable — so views
 * use this to drop the "awaiting approval" spinner and restore the local
 * apply/reject controls. Without it a card waits forever on a reply that the
 * backend will never send.
 */
export const staleApprovalActionIdsAtom = atom<Set<string>>(new Set<string>());

export const markApprovalStaleAtom = atom(
    null,
    (_get, set, actionId: string) => {
        set(staleApprovalActionIdsAtom, (prev) => {
            if (prev.has(actionId)) return prev;
            const next = new Set(prev);
            next.add(actionId);
            return next;
        });
    },
);

export const clearStaleApprovalsAtom = atom(
    null,
    (_get, set) => {
        set(staleApprovalActionIdsAtom, new Set<string>());
    },
);

// Note: clearing `pendingApprovalsAtom` when a run ends does not strand the
// proposals it was carrying. Every deferred tool emits and persists its action
// before it starts waiting, so each card falls back to the `status === 'pending'`
// controls it already has and stays appliable. Recovering a card whose decision
// was already sent is the view's job — see `useApprovalRecovery`.

/**
 * Send approval response for a deferred action.
 * Called by the UI when user approves/rejects an action.
 *
 * A send that never left the client is recorded as stale immediately: the
 * backend cannot answer a message it never received, so the card would
 * otherwise sit on a spinner until the thread is reloaded.
 */
export const sendApprovalResponseAtom = atom(
    null,
    (_get, set, { actionId, approved, userInstructions }: { actionId: string; approved: boolean; userInstructions?: string | null }) => {
        set(approvalResponseIntentsAtom, (prev) => {
            const next = new Map(prev);
            next.set(actionId, approved);
            return next;
        });
        logger(`sendApprovalResponseAtom: Sending approval response for ${actionId}: ${approved}${userInstructions ? ' (with instructions)' : ''}`, 1);
        const delivered = agentService.sendApprovalResponse(actionId, approved, userInstructions);
        if (!delivered) {
            logger(`sendApprovalResponseAtom: Approval response for ${actionId} was not sent; marking stale`, 1);
            set(markApprovalStaleAtom, actionId);
        }
    }
);

/**
 * Grant a tool group for the rest of a run and approve every request from that
 * group that is already pending. Future validations and late-arriving approval
 * requests read the same transient policy.
 */
export const approveToolGroupForRunAtom = atom(
    null,
    (
        get,
        set,
        { runId, toolName }: { runId: string; toolName: string },
    ): number => {
        const group = getToolGroup(toolName);
        if (!group) return 0;

        set(grantToolGroupForRunAtom, { runId, toolName });

        const matchingActionIds = getPendingApprovalIdsForToolGroup(
            get(pendingApprovalsAtom).values(),
            toolName,
        );
        for (const actionId of matchingActionIds) {
            set(sendApprovalResponseAtom, { actionId, approved: true });
        }
        set(removePendingApprovalsAtom, matchingActionIds);

        logger(
            `approveToolGroupForRunAtom: Granted ${group} for run ${runId} and approved ${matchingActionIds.length} pending action(s)`,
            1,
        );
        return matchingActionIds.length;
    },
);

/**
 * Send the user's answers (or a skip) for an ask_user_question request and
 * remove the pending question so the composer re-enables immediately.
 */
export const sendAskUserQuestionResponseAtom = atom(
    null,
    (_get, set, { questionId, toolcallId, answers, cancelled }: {
        questionId: string;
        toolcallId: string;
        answers: AskUserQuestionAnswer[];
        cancelled?: boolean;
    }) => {
        logger(`sendAskUserQuestionResponseAtom: Sending question response for ${questionId}: ${cancelled ? 'cancelled' : `${answers.length} answer(s)`}`, 1);
        agentService.sendAskUserQuestionResponse(questionId, answers, cancelled ?? false);
        set(removePendingQuestionAtom, toolcallId);
    }
);

/**
 * Send the user's decision for a run-level credit confirmation and retire the
 * pending card.
 *
 * The card is removed even when the send fails: the decision can no longer
 * reach the run, so leaving it up would strand the user on a card that can
 * never be answered.
 */
export const sendCreditConfirmationResponseAtom = atom(
    null,
    (_get, set, { confirmationId, approved, userInstructions }: {
        confirmationId: string;
        approved: boolean;
        userInstructions?: string | null;
    }) => {
        logger(`sendCreditConfirmationResponseAtom: Sending credit confirmation response for ${confirmationId}: ${approved}`, 1);
        const delivered = agentService.sendCreditConfirmationResponse(
            confirmationId,
            approved,
            userInstructions,
        );
        if (!delivered) {
            logger(`sendCreditConfirmationResponseAtom: Credit confirmation response for ${confirmationId} was not sent`, 1);
        }
        set(removePendingCreditConfirmationAtom, confirmationId);
    }
);
