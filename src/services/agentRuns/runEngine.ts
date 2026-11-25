/**
 * The run engine: executes chat runs over the WebSocket transport.
 *
 * It owns connecting and reattaching, stream events, decision cards, stop,
 * retry, resume and parked-run resumes, and settlement with the server. It
 * writes only its session's store, applying each event as it arrives, and
 * reaches the window it runs for only through the session's host (`RunHost`):
 * selections, notices, dialogs, agent actions, and the window-side work that
 * follows stream events. What the engine keeps between events lives on its
 * `RunSession`, never at module level.
 *
 * Every action atom exported here runs on the session's store, whichever
 * store it is called on. Window code imports them through
 * `react/atoms/agentRunAtoms`, which assembles prompts from the composer and
 * installs the renderer's session.
 */

import { isThreadConflict } from "@beaver/agent-core/types/apiErrors";
import {
    threadAdmissionAtom,
    threadConflictAtom,
    serverThreadBlockedAtom,
    readAdmission,
    readAdmissionHistory,
    setAdmission,
    reconcileThread,
    keepLocalFailuresOnSettle,
    type AdmissionWaitReason,
} from './threadAdmission';
import { reattachResolutionAtom } from "@beaver/agent-core/run-state/runResolution";
import { acquireWriter, assertWriter, bindWriter, currentWriter, ownsWriter, releaseWriter, type WriterLease } from './threadWriter';
import { viewedHistoryRevisionAtom } from './threadAdmission';
import { getCredentialGeneration, assertCredentialGeneration } from '@beaver/agent-core/transport/credentials';
import { getLibraryRevocations } from '../agentDataProvider/utils';
import { getSearchIndexState } from '../searchIndexState';
import { atom, Getter, Setter, type WritableAtom } from 'jotai/vanilla';
import { v4 as uuidv4 } from 'uuid';
import { CONNECT_MAX_ATTEMPTS, connectWithRetry, reattachWithRetry } from '@beaver/agent-core/transport/connectWithRetry';
import { reportConnectionFailure } from '@beaver/agent-core/transport/clients/diagnosticsService';
import {
    ConnectionFailureEvidence,
    presentConnectionFailure,
    REATTACH_FAILED_MESSAGE,
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
    WSBatchApprovalRequest,
    WSBatchApprovalStale,
    WSCreditConfirmationRequest,
    WSCreditConfirmationStale,
    AskUserQuestionAnswer,
    BatchApprovalMode,
    askUserQuestionResponse,
    batchApprovalResponse,
    deferredApprovalResponse,
    WSStreamingDoneEvent,
    WSThreadNameEvent,
    WSReattachingInfo,
    WSReattachedInfo,
    WSReattachFailedInfo,
    WSUndeliveredActionsInfo,
    ChargingPermissions,
} from '@beaver/agent-core/protocol/agentProtocol';
import { threadService } from '@beaver/agent-core/transport/threadService';
import { logger } from '@beaver/agent-core/platform/logger';
import type { ModelConfig } from '@beaver/agent-core/types/models';
import { getPref } from '../../utils/prefs';
import { saveInterruptedThread } from '../../utils/interruptedThreadPrefs';
import { AgentRun, BeaverAgentPrompt, ParkedCardAnswer, ResumeTrigger, RetryTrigger, isContinuationPrompt, isRunActive, isRunFinished } from '@beaver/agent-core/agents/types';
import {
    threadRunsAtom,
    activeRunAtom,
    allRunsAtom,
    currentThreadIdAtom,
    currentThreadNameAtom,
    updateRunWithPart,
    updateRunWithToolReturn,
    updateRunComplete,
    updateRunWithToolCallProgress,
    updateRunWithToolCallArgsStream,
    resetRunMessages,
    wsReconnectingAtom,
    wsRetryAtom,
} from '@beaver/agent-core/run-state/atoms';
import { isJobDeferral } from '@beaver/agent-core/protocol/jobCallProtocol';
import { jobWaitAtom, settleJobWait } from './jobWait';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import type { Citation } from '@beaver/agent-core/types/citations';
import {
    toAgentAction,
    isItemCreatingAgentAction,
    itemActionExternalId,
} from '@beaver/agent-core/agents/agentActionTypes';
import {
    addPendingApprovalAtom,
    removePendingApprovalAtom,
    removePendingApprovalsAtom,
    pendingApprovalsAtom,
    clearAllPendingApprovalsAtom,
} from './pendingApprovals';
import {
    addPendingQuestionAtom,
    pendingQuestionsAtom,
    removePendingQuestionAtom,
    clearAllPendingQuestionsAtom,
} from '@beaver/agent-core/run-state/pendingQuestions';
import {
    pendingCreditConfirmationsAtom,
    addPendingCreditConfirmationAtom,
    removePendingCreditConfirmationAtom,
    clearAllPendingCreditConfirmationsAtom,
} from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import {
    addPendingBatchApprovalAtom,
    pendingBatchApprovalsAtom,
    removePendingBatchApprovalAtom,
    clearAllPendingBatchApprovalsAtom,
} from '@beaver/agent-core/run-state/pendingBatchApprovals';
import {
    addPendingTableCardAtom,
    clearAllPendingTableCardsAtom,
    pendingTableCardsAtom,
    removePendingTableCardAtom,
    removePendingTableCardForToolCallAtom,
} from '@beaver/agent-core/run-state/pendingTableCards';
import { openParkedRunAtom, type OpenParkedRun } from '@beaver/agent-core/run-state/parkedRun';
import {
    addLiveCardAnswerAtom,
    carryLiveAnswersIntoParkedRunAtom,
    clearParkedAnswersAtom,
    isResumeWaitingAtom,
    isThreadParkedAtom,
    liveCardAnswersAtom,
    markLiveApprovalAnswerParkingAtom,
    parkedAnswerQueueAtom,
    parkedAnswersInFlightAtom,
    releaseCardAnswerAtom,
    resumeLiveCardsAtom,
    syncParkedCardsAtom,
} from './parkedRuns';
import { isCreateCard, isFillCard } from '@beaver/agent-core/protocol/tableCardProtocol';
import type { WSTableCardRequest, WSTableCardResponse, WSTableCardStale } from '@beaver/agent-core/protocol/tableCardProtocol';
import { tableRecordFromMetadata } from '@beaver/agent-core/run-state/tableResults';
import { readCreditThreshold } from '../../utils/creditThreshold';
import { isToolResultView } from '@beaver/agent-core/run-state/toolResultViews';
import { selectLiveBatchProgress } from '@beaver/agent-core/run-state/batchProgress';
import {
    clearRunApprovalPolicyAtom,
    getPendingApprovalIdsCoveredByFullAccess,
    isActionApprovedForCurrentRun,
    isFullAccessGrantedForRun,
    runApprovalPolicyAtom,
    setRunFullAccessAtom,
} from './runApprovalPolicy';
import type { CreateItemResultData } from '@beaver/agent-core/types/agentActions/items';
import { appendRunIfMissing, continuationOfferFor, findResumeChainRoot, findRunForResume, hasOnlyThinkingParts, lingeringCompletedRun, resolveErrorRunId, toRunError } from '@beaver/agent-core/run-state/runResumeHelpers';
import { prewarmMuPDFWorker } from '../../beaver-extract';
import { getRunSession, getSessionPort, ownSessionOf, sessionOf, type RetryCommit, type RunSession } from './runSession';
import { registerSessionAction } from './sessionActions';
import type { UndoConfirmResult } from './runHost';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * An action atom that runs on a session's store. Called on the session's own
 * store (by the engine), its body runs there and finds the session with
 * `sessionOf(get)`; each of its writes is a write of that store, so viewers
 * see it as it happens. Called on any other store (a window's), it asks the
 * session installed for that window's realm to run it, by `name`.
 */
function sessionAction<Args extends unknown[], Result>(
    name: string,
    write: (get: Getter, set: Setter, ...args: Args) => Result,
): WritableAtom<null, Args, Result> {
    const action = atom(null, (get, _set, ...args: Args) => {
        const own = ownSessionOf(get);
        if (!own) return getSessionPort().set(name, ...args) as Result;
        return write(own.store.get, own.store.set, ...args);
    });
    registerSessionAction(name, action as WritableAtom<unknown, any[], unknown>);
    return action;
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
export interface ModelSelectionOptions {
    model_id?: string;
    api_key?: string;
}

/**
 * Build model selection options to include in the AgentRunRequest.
 * - Custom models: Use the custom_model field in the request (no model_id/api_key)
 * - App-key models (access_mode='app_key' or default): model_id only, no api_key
 * - BYOK models (access_mode='byok'): model_id + user's api_key
 */
export function buildModelSelectionOptions(model: ModelConfig | null): ModelSelectionOptions {
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
export function retryCommitInFlight(get: Getter, logPrefix: string): boolean {
    const pendingRetryRunId = get(retryPendingRunIdAtom);
    if (!pendingRetryRunId) return false;
    logger(`${logPrefix}: Blocked — retry of run ${pendingRetryRunId} is still committing`, 1);
    return true;
}

function reportTruncateConflict(
    session: RunSession,
    set: Setter, threadId: string, tailRunId: string | null,
    outcome: 'refused' | 'busy', automatic: boolean,
): void {
    set(retryPendingRunIdAtom, null);
    set(isWSChatPendingAtom, false);
    set(threadConflictAtom, outcome === 'busy' ? 'thread_busy' : 'thread_tail_mismatch');
    if (outcome === 'busy') setAdmission(set, threadId, tailRunId, 'unknown');
    session.host.notify(set, {
        type: 'warning',
        title: !automatic && outcome === 'busy' ? 'Response still settling' : 'Chat changed elsewhere',
        text: automatic
            ? 'The response was not retried automatically. Refresh the chat and retry explicitly. Your draft and attachments are preserved.'
            : 'The retry was not sent. Your draft and attachments are preserved. Refresh the chat and retry explicitly.',
        expire: false,
    });
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
): Promise<'ok' | 'refused' | "busy" | 'failed'> {
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
        if ((error as { code?: string })?.code === "thread_busy") return "busy";
        if (isThreadConflict(error)) return "refused";
        logger(`${logPrefix}: truncation failed: ${error}`, 1);
        return 'failed';
    }
}

/** What an abandoned automatic retry tells the user. */
const AUTO_RETRY_ABANDONED_TEXT =
    'Beaver was retrying a failed response when you switched chats, so the retry was not sent. '
    + 'Reopen that chat to see where it stands.';

/** What an abandoned user-initiated retry tells the user. */
const USER_RETRY_ABANDONED_TEXT =
    'You switched chats while the retry was starting, so it was not sent. '
    + 'Reopen that chat to see where it stands and retry from there.';

/**
 * Give up a replacement whose chat the user has left, and say so.
 *
 * Returns true when the caller must stop.
 */
function abandonReplacementIfThreadChanged(
    session: RunSession,
    get: Getter,
    set: Setter,
    options: {
        navSeqBeforeAwait: number;
        pendingRetryRunId: string;
        logPrefix: string;
        popupText: string;
    },
): boolean {
    const current = session.host.navigationSeq();
    if (current === options.navSeqBeforeAwait) return false;
    logger(
        `${options.logPrefix}: chat changed while the replacement was in flight ` +
            `(navigation ${options.navSeqBeforeAwait} -> ${current}) — abandoning it`,
        1,
    );
    // Release only what this replacement still owns, and the retry lock is the
    // proof of ownership: `retryCommitInFlight` blocks every send while it is
    // held, so nothing newer can have taken the composer's pending flag out
    // from under it.
    //
    // Before the lock is taken — the check that runs as soon as the replaced
    // run is cancelled — neither belongs to this replacement. The pending flag
    // there is the cancelled run's, and the navigation doing the abandoning
    // clears that itself on its way out of the chat. Clearing it here instead
    // would re-enable the composer over a run the user has since started in the
    // chat they moved to, and let them send a second one on top of it.
    if (get(retryPendingRunIdAtom) === options.pendingRetryRunId) {
        set(retryPendingRunIdAtom, null);
    }
    session.host.notify(set, {
        type: 'warning',
        title: 'Retry not sent',
        text: options.popupText,
        expire: true,
    });
    return true;
}

/**
 * Open the span in which a retry commits its removal.
 *
 * Once the truncate request is sent, the server may delete the replaced runs
 * whatever this client does next, so a Stop can no longer cancel the retry:
 * abandoning it there would leave the removed runs on screen and the prompt
 * that replaces them nowhere. A Stop in this span is held instead, and
 * `settleRetryCommit` applies it to the replacement run, which then ends as a
 * stopped message the user can retry or edit. A removal the server refuses
 * or never confirms ends the retry as usual, and the held Stop with it.
 */
function beginRetryCommit(session: RunSession, runId: string): RetryCommit {
    const commit: RetryCommit = { runId, stopRequested: false };
    session.retryCommit = commit;
    return commit;
}

function endRetryCommit(session: RunSession, commit: RetryCommit | undefined): void {
    if (commit && session.retryCommit === commit) session.retryCommit = null;
}

/**
 * Close the commit span once the replacement run is the active run, and apply
 * a Stop held during it. The replacement has not connected yet, so stopping it
 * is local only. Returns true when the replacement was stopped and must not be
 * sent.
 */
function settleRetryCommit(
    session: RunSession,
    set: Setter,
    commit: RetryCommit | undefined,
): boolean {
    endRetryCommit(session, commit);
    if (!commit?.stopRequested) return false;
    logger(`Retry of run ${commit.runId}: applying the Stop held while its removal committed`, 1);
    set(abandonActiveRunLocallyAtom);
    return true;
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
    options?: {
        runIdOverride?: string;
        permissionsOverride?: Partial<ChargingPermissions>;
        /**
         * Marks the request as a retry and says who asked for it. A retry
         * commits its removal through the truncate endpoint before getting
         * here, so nothing else in the request identifies it as one.
         */
        retryTrigger?: RetryTrigger;
    },
): { run: AgentRun; request: AgentRunRequest } {
    const { runIdOverride, permissionsOverride, retryTrigger } = options ?? {};
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
        ...(retryTrigger ? { retry_trigger: retryTrigger } : {}),
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

type StartContinuationRunOptions = {
    requireResumable: boolean;
    /**
     * Who is asking. Sent to the backend, which reorders its model chain only
     * for `auto` — a user-clicked resume usually follows a dropped connection
     * or a closed client, where no provider failed.
     */
    trigger: ResumeTrigger;
    logPrefix: string;
    failureErrorType: string;
    failureMessage: string;
    /** Additional instructions typed on the continue card. */
    userMessage?: string;
};

async function startContinuationRunOwned(
    session: RunSession,
    get: Getter,
    set: Setter,
    failedRunId: string,
    options: StartContinuationRunOptions,
): Promise<void> {
    logger(`${options.logPrefix}: Continuing from run ${failedRunId}`, 1);

    // A resume overwriting the active slot mid-commit would be clobbered
    // when the retry installs its own replacement shell.
    if (retryCommitInFlight(get, options.logPrefix)) return;
    // Nor may it take the slot of a run that is reconnecting.
    if (get(isRunReconnectingAtom)) {
        logger(`${options.logPrefix}: Blocked — the active run is reconnecting`, 1);
        return;
    }

    let newRunId: string | null = null;

    try {
        const model = session.host.getModel();
        if (!model) {
            logger(`${options.logPrefix}: No model selected`, 1);
            return;
        }

        const userId = session.host.getUserId();
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

        // Failed runs need a resumability verdict; completed runs need an offer.
        const offer = continuationOfferFor(failedRun);
        const isResumableError =
            failedRun.status === 'error'
            && (!options.requireResumable || !!failedRun.error?.is_resumable);
        if (!isResumableError && offer === null) {
            logger(`${options.logPrefix}: Run ${failedRunId} is not resumable`, 1);
            return;
        }

        const isNewRun = offer?.mode === 'new_run';
        if (isNewRun) {
            const latestRun = activeRun ?? threadRuns[threadRuns.length - 1];
            if (
                options.trigger !== 'user'
                || get(isWSChatPendingAtom)
                || latestRun?.id !== failedRunId
                || failedRun.thread_id !== get(currentThreadIdAtom)
            ) return;
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

        const userMessage = options.userMessage?.trim() || '';
        const continuation = offer
            ? { kind: offer.kind, payload: offer.payload }
            : undefined;
        // Card actions use their own input and leave the composer draft intact.
        const prompt: BeaverAgentPrompt = isNewRun ? {
            content: [offer!.prompt!.trim(), userMessage].filter(Boolean).join('\n\n'),
            is_resume: false,
            continuation,
        } : {
            content: userMessage,
            is_resume: true,
            resumes_run_id: failedRunId,
            resume_trigger: options.trigger,
            ...(continuation ? { continuation } : {}),
        };

        const { run: newRun, request } = createAgentRunShell(
            prompt,
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

        await executeWSRequest(session, newRun, request, get, set);
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
async function startAutoRetryRunOwned(
    session: RunSession,
    get: Getter,
    set: Setter,
    failedRunId: string,
): Promise<void> {
    const logPrefix = 'autoRetryErroredRunAtom';
    logger(`${logPrefix}: Retrying from run ${failedRunId}`, 1);

    if (retryCommitInFlight(get, logPrefix)) return;

    let newRunId: string | null = null;
    let commit: RetryCommit | undefined;

    try {
        // Which chat this replacement belongs to, captured before every await
        // in the function. See `abandonReplacementIfThreadChanged`.
        const navSeqBeforeAwait = session.host.navigationSeq();

        const model = session.host.getModel();
        if (!model) {
            logger(`${logPrefix}: No model selected`, 1);
            return;
        }

        const userId = session.host.getUserId();
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

        // Null for a first run that died before the backend named the thread.
        // Nothing is persisted to truncate then, and the replacement opens the
        // thread the same way the original request would have — the same shape
        // the user-driven retry allows.
        const threadId = get(currentThreadIdAtom) || failedRun.thread_id;

        // Walk back to the original user message — resume runs carry an empty
        // user_prompt.content, so we need the root to preserve the question.
        const rootRun = findResumeChainRoot(failedRun, threadRuns);
        const chainRootIndex = threadRuns.findIndex(r => r.id === rootRun.id);
        const truncateFromIndex = chainRootIndex >= 0 ? chainRootIndex : threadRuns.length;
        const runIdsToRemove = threadRuns.slice(truncateFromIndex).map(r => r.id);

        // The failed run keeps its card while the truncate round trip runs,
        // with the status indicator in place of the error it suppresses (see
        // `autoReplacementPendingRunIdsAtom`); every exit below clears the
        // pending state (the catch handles the throw on a failed POST).
        set(retryPendingRunIdAtom, failedRunId);
        set(isWSChatPendingAtom, true);

        if (runIdsToRemove.length > 0) {
            // Commit the removal on the backend before anything local changes.
            // A thread the backend never named has nothing persisted to
            // truncate, but its runs still have to leave the local view.
            if (threadId) {
                let persistedRunIds: Set<string> | undefined;
                if (Zotero.Beaver?.presence) {
                    const observed = get(threadAdmissionAtom);
                    const generation = getCredentialGeneration();
                    const writer = currentWriter(session);
                    const history = await readAdmissionHistory(threadId);
                    assertCredentialGeneration(generation);
                    assertWriter(session, writer);
                    if (abandonReplacementIfThreadChanged(session, get, set, {
                        navSeqBeforeAwait,
                        pendingRetryRunId: failedRunId,
                        logPrefix,
                        popupText: AUTO_RETRY_ABANDONED_TEXT,
                    })) return;
                    persistedRunIds = new Set(history.runs.map(run => run.id));
                    const localPersisted = threadRuns.filter(run =>
                        persistedRunIds!.has(run.id) ||
                        (run.status !== 'error' && run.status !== 'canceled'));
                    // Unsaved failures can sit between saved turns. Only saved
                    // runs define the server's suffix and surviving tail.
                    const matches = observed?.threadId === threadId
                        && (observed.tailRunId === history.tail_run_id ||
                            (observed.unconfirmedRunId === history.tail_run_id &&
                                (!observed.tailRunId || persistedRunIds.has(observed.tailRunId))))
                        && localPersisted.length === history.runs.length
                        && localPersisted.every((run, index) => run.id === history.runs[index].id);
                    if (history.activity.state === 'active' || !matches) {
                        reportTruncateConflict(session, set, threadId, observed?.tailRunId ?? null,
                            history.activity.state === 'active' ? 'busy' : 'refused', true);
                        return;
                    }
                }
                const survivingRuns = threadRuns.slice(0, truncateFromIndex)
                    .filter(run => !persistedRunIds || persistedRunIds.has(run.id));
                const expectedTailRunId = survivingRuns.at(-1)?.id ?? null;
                const persistedRemovals = runIdsToRemove.filter(id => !persistedRunIds || persistedRunIds.has(id));
                commit = beginRetryCommit(session, failedRunId);
                const outcome = persistedRemovals.length ? await truncateThreadOnServer(
                    threadId,
                    persistedRemovals,
                    expectedTailRunId,
                    logPrefix,
                ) : 'ok';
                if (abandonReplacementIfThreadChanged(session, get, set, {
                    navSeqBeforeAwait,
                    pendingRetryRunId: failedRunId,
                    logPrefix,
                    popupText: AUTO_RETRY_ABANDONED_TEXT,
                })) {
                    return;
                }
                if (outcome === 'refused' || outcome === "busy") {
                    reportTruncateConflict(session, set, threadId, expectedTailRunId, outcome, true);
                    return;
                }
                if (outcome === 'failed') {
                    throw new Error('Failed to automatically retry run');
                }
                setAdmission(set, threadId, expectedTailRunId, "idle");
            }

            await session.host.cleanupTemporaryAnnotations(logPrefix);

            // Re-checked after the cleanup, which is the last await before the
            // writes — and the only one on the path where the thread was never
            // named and no POST was made.
            if (abandonReplacementIfThreadChanged(session, get, set, {
                navSeqBeforeAwait,
                pendingRetryRunId: failedRunId,
                logPrefix,
                popupText: AUTO_RETRY_ABANDONED_TEXT,
            })) {
                return;
            }

            set(threadRunsAtom, prev => prev.filter(r => !runIdsToRemove.includes(r.id)));
            session.host.removeRunActions(set, runIdsToRemove);
            set(citationsAtom, prev => prev.filter(c => !runIdsToRemove.includes(c.run_id ?? '')));
            session.host.citationsChanged(set);
        }

        set(prepareForNewRunAtom);
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
            { retryTrigger: 'auto' },
        );

        newRunId = newRun.id;
        set(activeRunAtom, newRun);
        set(retryPendingRunIdAtom, null);
        if (settleRetryCommit(session, set, commit)) return;
        prewarmMuPDFWorker();

        await executeWSRequest(session, newRun, request, get, set);
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
    } finally {
        endRetryCommit(session, commit);
    }
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

/**
 * The active run lost its connection and is being picked up on a new one.
 * Decision cards stay up but are disabled meanwhile; Stop still works.
 */
export const isRunReconnectingAtom = atom(
    (get) => get(wsReconnectingAtom) !== null && isRunActive(get(activeRunAtom)),
);

/**
 * A new run is waiting for the server to stop a run the user stopped while it
 * was reconnecting (see `session.agentService.cancelHandoff`).
 */
export const stoppingPreviousRunAtom = atom(false);

/**
 * Whether the open chat's run is reconnecting and can be left without being
 * stopped: switching chats then leaves it to the server rather than stopping it.
 */
export function canLeaveReconnectingRun(get: Getter, session: RunSession = getRunSession()): boolean {
    const run = get(activeRunAtom);
    return !!run && isRunActive(run) && session.agentService.canLeaveRun(run.id);
}

/**
 * Runs whose automatic replacement — an auto-resume or an auto-retry — has been
 * scheduled and has not finished. Added when `onError` decides to replace the
 * run, removed once the replacement has started or given up.
 */
export const scheduledAutoResumeRunIdsAtom = atom<Set<string>>(new Set<string>());

/** Read-only view of the runs currently being replaced automatically. */
export const autoReplacementPendingRunIdsAtom = atom(
    (get) => get(scheduledAutoResumeRunIdsAtom),
);

// =============================================================================
// Action Atoms
// =============================================================================

/**
 * Reset all WebSocket state atoms
 */
export const resetWSStateAtom = sessionAction('resetWSState',(get, set) => {
    const session = sessionOf(get);
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
    session.streamActivity.reset();
});

/**
 * Clear transient frontend state before starting a replacement run.
 * This is separate from transport-level onClose cleanup so reconnect handoffs
 * do not leak per-run approval UI or auto-approve settings into the new run.
 *
 * A run that resumes a parked run keeps that run's other open cards
 * (`keepParkedCards`): they stay answerable while it runs. Any other run
 * closes them, and drops answers still waiting to be sent.
 */
export const prepareForNewRunAtom = sessionAction('prepareForNewRun',(_get, set, options?: { keepParkedCards?: boolean }) => {
    set(resetWSStateAtom);
    // A resume reconciles the card maps instead, so cards still open keep
    // their components and drafts.
    if (!options?.keepParkedCards) {
        set(clearAllPendingApprovalsAtom);
        set(clearAllPendingQuestionsAtom);
        set(clearAllPendingBatchApprovalsAtom);
        set(clearAllPendingTableCardsAtom);
    }
    set(clearAllPendingCreditConfirmationsAtom);
    set(clearApprovalResponseIntentsAtom);
    set(clearStaleApprovalsAtom);
    set(clearRunApprovalPolicyAtom);
    set(liveCardAnswersAtom, new Map());
    set(resumeLiveCardsAtom, new Set<string>());
    if (options?.keepParkedCards) set(syncParkedCardsAtom);
    else set(clearParkedAnswersAtom);
});

/**
 * Errors of a parked resume that mean the thread changed under it: no open
 * parked run any more, a different one, or another device answered first.
 */
const PARKED_RESUME_RELOAD_ERRORS = new Set(['parked_run_not_found', 'parked_run_mismatch', 'thread_tail_mismatch']);

/**
 * Settle the live answers of a run that ended, before they are cleared. An
 * answer to a card the run parked on is queued to resume the parked run. An
 * approval whose answer was held for a run that was to park on it but ended
 * otherwise gets its own controls back: the answer never reached a run, and
 * the proposal can still be applied locally.
 */
function settleLiveCardAnswers(set: Setter, parked: boolean): void {
    for (const actionId of set(carryLiveAnswersIntoParkedRunAtom, { parked })) {
        set(markApprovalStaleAtom, actionId);
        set(removeApprovalResponseIntentAtom, actionId);
    }
}

/**
 * Close the cards of a run that ended. The open parked run's cards stay as
 * they are, panels and drafts included, and are answerable again: a resume
 * that carried answers is over, and an answer the run parked before receiving
 * comes back too. Every other card closes with the run.
 */
function settleRunCards(get: Getter, set: Setter): void {
    set(clearAllPendingCreditConfirmationsAtom);
    set(clearRunApprovalPolicyAtom);
    set(parkedAnswersInFlightAtom, new Set<string>());
    set(liveCardAnswersAtom, new Map());
    set(resumeLiveCardsAtom, new Set<string>());
    if (get(openParkedRunAtom)) {
        set(syncParkedCardsAtom);
        return;
    }
    set(clearAllPendingApprovalsAtom);
    set(clearAllPendingQuestionsAtom);
    set(clearAllPendingBatchApprovalsAtom);
    set(clearAllPendingTableCardsAtom);
}

/**
 * Find the args of the tool-call part that produced a given tool return, by
 * scanning the thread's response messages. Used to derive the annotation-list
 * variant when synthesizing a legacy view; null when the call can't be found.
 */
function findToolCallArgs(
    runs: readonly AgentRun[],
    toolCallId: string,
): string | Record<string, any> | null {
    for (const run of runs) {
        for (const message of run.model_messages) {
            if (message.kind !== 'response') continue;
            for (const part of message.parts) {
                if (part.part_kind === 'tool-call' && part.tool_call_id === toolCallId) {
                    return part.args;
                }
            }
        }
    }
    return null;
}

/** The tool a call in the run belongs to, or null when the call is not in it. */
export function findToolCallName(run: AgentRun | null, toolCallId: string): string | null {
    if (!run) return null;
    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'tool-call' && part.tool_call_id === toolCallId) return part.tool_name;
        }
    }
    return null;
}

/** How a reattach after a lost connection ended, for the failure report. */
interface ReattachOutcome {
    /** `reattached`, `gave_up`, or `fallback:<reason>`. */
    outcome: string;
    gapMs: number;
    /** Sockets opened to reattach the run. */
    attempts: number;
    /** Sockets the run lost, the first loss included. */
    losses: number;
    /** The server ended the run and saved what it had, so it can be continued. */
    resumable?: boolean;
}

/** `gave_up` when the client ran out of time, `fallback:<reason>` otherwise. */
function reattachFailureOutcome(info: WSReattachFailedInfo): ReattachOutcome {
    return {
        outcome: info.reason === 'gave_up' ? 'gave_up' : `fallback:${info.reason}`,
        gapMs: info.gapMs,
        attempts: info.attempts,
        losses: info.losses,
        // `expired` means the run ended on the server, which saves it the way
        // any interrupted run is saved.
        resumable: info.reason === 'expired',
    };
}

/**
 * Make the open chat wait for the server to finish with a run this window lost
 * track of. Marking its admission unknown blocks new sends and starts the
 * admission poller, which loads the saved history once the server is idle, so
 * the run ends up shown as the server finished it (completed, or interrupted
 * with Continue) rather than as this window last saw it.
 */
function awaitServerSettlement(session: RunSession, set: Setter, reason: AdmissionWaitReason): void {
    const threadId = session.store.get(currentThreadIdAtom);
    if (!threadId) return;
    const admission = session.store.get(threadAdmissionAtom);
    const known = admission?.threadId === threadId ? admission : null;
    // Failed and stopped requests the server never saved stay on screen.
    keepLocalFailuresOnSettle(session, threadId);
    // The run this window lost shows a neutral "checking" state rather than
    // its connection error while the server is asked how it ended.
    const runId = session.store.get(activeRunAtom)?.id;
    if (reason === 'reattach_failed' && runId) {
        set(reattachResolutionAtom, { threadId, runId, since: Date.now() });
    }
    setAdmission(set, threadId, known?.tailRunId ?? null, 'unknown', known?.unconfirmedRunId, reason);
}

function surfaceAndDiagnoseConnectionFailure(
    session: RunSession,
    set: Setter,
    runId: string,
    evidence: ConnectionFailureEvidence,
    connectAttempts?: number,
    reattach?: ReattachOutcome,
): void {
    const applyPresentation = (
        diagnostic?: Awaited<ReturnType<typeof reportConnectionFailure>>,
    ) => {
        const presentation = presentConnectionFailure(evidence, diagnostic);
        const message = reattach ? REATTACH_FAILED_MESSAGE : presentation.message;
        // The diagnostic POST can take several seconds; if the user retried in
        // the meantime, this run is no longer active and the refined
        // presentation must not resurface its error over the new run's state.
        const activeId = session.store.get(activeRunAtom)?.id ?? null;
        if (activeId !== runId) return;
        set(wsErrorAtom, (current) =>
            current?.type && current.type !== 'connection_error'
                ? current
                : current?.run_id && current.run_id !== runId
                  ? current
                  : {
                        event: 'error',
                        type: 'connection_error',
                        message,
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
                          message,
                          user_facing_details: presentation.details,
                          is_retryable: true,
                          ...(reattach?.resumable ? { is_resumable: true } : {}),
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
        reattach_outcome: reattach?.outcome ?? null,
        reattach_gap_ms: reattach?.gapMs ?? null,
        reattach_attempts: reattach?.attempts ?? null,
        reattach_losses: reattach?.losses ?? null,
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
    session: RunSession,
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
    session.host.citationsChanged(set);

    // Preload PDF page labels for cited attachments so the rendering path can
    // resolve page numbers from explicit render state. Runs after metadata is
    // exposed to avoid blocking the UI on PDF extraction.
    //
    // The preload usually settles after the run, when this window no longer
    // holds the thread writer and the callback setter drops writes. The labels
    // are the window's render state keyed by attachment, not thread history,
    // so they are kept regardless (still scoped to the account).
    const generation = getCredentialGeneration();
    session.host.preloadPageLabels(citations)
        .then((labelsByAttachmentId) => {
            if (generation !== getCredentialGeneration()) return;
            session.host.mergePageLabels(labelsByAttachmentId);
        })
        .catch((err) =>
            logger(`WS: Failed to preload page labels: ${err}`, 1)
        );
}

/**
 * Create WebSocket callbacks for handling streaming events.
 * Shared between sendWSMessageAtom and regenerateFromRunAtom.
 *
 * @param connectAttempts Reads how many attempts opened the connection these
 * callbacks belong to. A drop after `ready` has no attempt count of its own —
 * the connection it lost is the one that succeeded — so the number that
 * describes it is the number that got it open. Read lazily because the count is
 * only known once the connect settles, which is after these callbacks exist.
 */
export function createWSCallbacks(
    set: Setter,
    connectAttempts: () => number | null = () => null,
    restoreComposer?: () => void,
    session: RunSession = getRunSession(),
): WSCallbacks {
    const navigation = session.host.navigationSeq();
    const composerRunId = session.store.get(activeRunAtom)?.id;
    const generation = getCredentialGeneration();
    const writer = currentWriter(session);
    const callbackEpoch = ++session.writerCallbackEpoch;
    // Callbacks also write after awaits; entry validation alone cannot protect those writes.
    const originalSet = set;
    set = ((...args: Parameters<Setter>) => {
        assertCredentialGeneration(generation);
        if (!ownsWriter(session, writer) || callbackEpoch !== session.writerCallbackEpoch) return;
        return originalSet(...args);
    }) as Setter;
    /**
     * Retire the live state of a run whose connection is gone and, when the
     * server never finished it, show the connection error. `reattach` carries
     * how a failed reattach ended, for a run that tried one.
     */
    const endRunOnLostConnection = (
        transportEvidence: ConnectionFailureEvidence | undefined,
        hadReachedReady: boolean,
        reattach?: ReattachOutcome,
    ) => {
        set(isWSConnectedAtom, false);
        set(isWSReadyAtom, false);
        // A retry commit in flight owns the pending flag: this close
        // belongs to the failed run the retry is replacing (onError
        // dispatched it before the server closed the socket), and
        // clearing here would re-enable the composer mid-commit. The
        // retry flow clears or re-asserts the flag on every exit.
        if (!session.store.get(retryPendingRunIdAtom)) {
            set(isWSChatPendingAtom, false);
        }
        // Clear streaming-done state (connection lost during post-processing)
        set(streamingDoneRunIdsAtom, new Set<string>());
        session.streamActivity.reset();

        // A run that reached `completed` (run_complete processed) but whose
        // terminal `done` never arrived — the socket closed while run_complete
        // post-processing was still draining the message queue, so the queued
        // `done` was skipped by the connection-generation guard — lingers in
        // activeRunAtom. Finalize it the way onDone would, so the next send does
        // not overwrite and drop it from local history. Idempotent: the normal
        // path nulls activeRunAtom in onDone before close, making this a no-op.
        let finishedParked = false;
        set(activeRunAtom, (prev) => {
            const finalRun = lingeringCompletedRun(prev);
            if (finalRun) {
                finishedParked = !!finalRun.parked;
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
            const activeRun = session.store.get(activeRunAtom);
            if (
                activeRun &&
                (activeRun.status === 'in_progress' ||
                    activeRun.status === 'awaiting_deferred')
            ) {
                surfaceAndDiagnoseConnectionFailure(
                    session,
                    set,
                    activeRun.id,
                    transportEvidence,
                    connectAttempts() ?? undefined,
                    reattach,
                );
            }
        }
        // Close the run's cards and dismiss the diff preview (connection
        // lost), except those of a run that parked, or that a failed resume
        // left open. A run that parked before its connection was lost
        // carries its live answers, as `onDone` would.
        settleLiveCardAnswers(set, finishedParked);
        settleRunCards(session.store.get, set);
        // Answers queued behind a resume that parked again but lost its
        // connection before `done` go out now, as `onDone` would send them,
        // and so does a fill result that arrived meanwhile.
        if (session.store.get(parkedAnswerQueueAtom).size > 0 || session.store.get(jobWaitAtom)) scheduleParkedAnswerFlush(session);
    };

    /**
     * Report how a lost connection's reattach ended. A recovered drop is still
     * a dropped connection and still counted as one; the outcome says the user
     * never saw it. A failed reattach of the run this window still shows is
     * reported by `endRunOnLostConnection` instead, which also refines the
     * error card.
     */
    const reportReattachOutcome = (info: WSReattachedInfo | WSReattachFailedInfo) => {
        const outcome: ReattachOutcome = 'reason' in info
            ? reattachFailureOutcome(info)
            : { outcome: 'reattached', gapMs: info.gapMs, attempts: info.attempts, losses: info.losses };
        void reportConnectionFailure({
            evidence: info.evidence,
            run_id: info.runId,
            connect_attempts: connectAttempts(),
            reattach_outcome: outcome.outcome,
            reattach_gap_ms: outcome.gapMs,
            reattach_attempts: outcome.attempts,
            reattach_losses: outcome.losses,
        });
    };

    /**
     * Pick up a run whose socket was lost on a new one. The loop belongs to
     * the run, not to these callbacks: a run the user stops while it is
     * reconnecting still has to be reached so the server can stop it.
     */
    const startReattach = (runId: string) => {
        session.connectLoopsInFlight++;
        void reattachWithRetry({
            service: session.agentService,
            runId,
            isStillWanted: () => generation === getCredentialGeneration(),
            logLabel: `run ${runId}`,
        })
            .then((outcome) => {
                if (outcome === 'stopped') session.agentService.failReattach(runId, 'gave_up');
            })
            .catch((error) => {
                logger(`WS reattach of run ${runId} failed: ${error}`, 1);
                session.agentService.failReattach(runId, 'gave_up');
            })
            .finally(() => {
                session.connectLoopsInFlight--;
            });
    };

    // Applied in Zotero, but the result never reached the server: record it,
    // whether or not this window still owns the run.
    const revocationsAtRunStart = getLibraryRevocations();
    const recordUndeliveredActions = (info: WSUndeliveredActionsInfo) => {
        logger(`WS onUndeliveredActions: run ${info.runId}: ${info.actions.map((action) => action.actionId).join(', ')}`, 1);
        session.host.recordUndeliveredActions(info, revocationsAtRunStart);
    };

    const callbacks: WSCallbacks = {
        onReady: (data: WSReadyData) => {
            logger('WS onReady:', data, 1);
            set(isWSReadyAtom, true);
            set(wsReadyDataAtom, data);

            // A successful WS handshake proves the backend is reachable and the session is valid.
            // If the profile sync was stuck in transient/fatal (and its retry backoff or the OS
            // online event hasn't cleared it), force a refresh so the header indicator drops
            // promptly instead of lingering until the next backoff tick.
            // So can an applied action's result that has yet to be recorded.
            session.host.backendReachable();
        },

        onRequestAck: (data: WSRequestAckData) => {
            logger('WS onRequestAck:', data, 1);
            set(wsRequestAckDataAtom, data);
            // The completion card shows when this run ends.
            if (data.featureCredit) {
                session.host.recordFeatureCredit(set, { runId: data.runId, ...data.featureCredit });
                // The granted credits pay for this run's fills: a card shown
                // during the run needs the balance that includes them.
                void Zotero.Beaver?.account?.refresh(true).catch(() => {});
            }
        },

        onPart: async (event: WSPartEvent) => {
            // Stamped before the item-data load below, not after: the wait this
            // reports is the provider's, and our own lookup is not silence.
            session.streamActivity.noteActivity(event.run_id);
            // Load item data for tool call
            if (event.part.part_kind === "tool-call") {
                logger(`WS onPart (${event.part.part_kind}):`, {
                    runId: event.run_id,
                    messageIndex: event.message_index,
                    part: event.part,
                });
                // Awaited only when there is item data to load, so a call with
                // none is applied in the same task.
                const loading = session.host.enrichToolCall(event.part);
                if (loading) await loading;
            }
            // Applied at once: the session has no renderer. Windows pace how
            // often they render what streamed (see `runProjection`).
            set(activeRunAtom, (prev) => prev ? updateRunWithPart(prev, event) : prev);
        },

        onToolReturn: async (event: WSToolReturnEvent) => {
            session.streamActivity.noteActivity(event.run_id);
            logger('WS onToolReturn:', {
                runId: event.run_id,
                messageIndex: event.message_index,
                toolName: event.part.part_kind === "tool-return" ? event.part.tool_name : undefined,
                toolCallId: event.part.part_kind === "tool-return" ? event.part.tool_call_id : undefined,
            });

            // Process tool return results
            if (event.part.part_kind === "tool-return") {
                await session.host.processToolReturn(event.part, set);

                // Open the new table unless its fill already opened it.
                if (event.part.tool_name === "create_table") {
                    const created = tableRecordFromMetadata(event.part.metadata);
                    if (created) {
                        session.host.openCreatedTable(created.reference.key, event.run_id, event.part.tool_call_id);
                    }
                }

                // Safety net: the current backend ships a hydrated `metadata.view`
                // on every tool return, but synthesize one from the legacy summary
                // when it is missing OR malformed so the shared render layer always
                // has a valid view to render. The `isToolResultView` check matches
                // the render-time predicate; `upgradeToolReturn` no-ops on a valid view.
                if (!isToolResultView(event.part.metadata?.view)) {
                    logger(`WS onToolReturn: No view model available for tool call ${event.part.tool_call_id}`, 1);
                    // A resumed call was made by an earlier run of the thread.
                    const toolCallArgs = findToolCallArgs(session.store.get(allRunsAtom), event.part.tool_call_id);
                    event = { ...event, part: await session.host.upgradeToolReturn(event.part, toolCallArgs) };
                }

            }

            // Update run with tool return (its part carries a synthesized
            // `view` when the backend omitted one).
            const toolReturn = event;
            set(activeRunAtom, (prev) => prev ? updateRunWithToolReturn(prev, toolReturn) : prev);

            // Remove pending approval for this specific tool call (if any)
            // Note: We find approval by toolCallId since that's what we have in the event
            if (event.part.part_kind === "tool-return") {
                const toolCallId = event.part.tool_call_id;
                // Get current pending approvals and find the one for this tool call
                const pendingMap = session.store.get(pendingApprovalsAtom);
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

                // Remove any pending batch approval owned by this tool call,
                // covering the same backend-timeout path: batch_start returns
                // with no coverage granted and the run continues. Batch
                // approvals are keyed by approval id, so the owning entry is
                // the one whose toolcallId is the call that just returned.
                const pendingBatchApprovals = session.store.get(pendingBatchApprovalsAtom);
                for (const [approvalId, pending] of pendingBatchApprovals.entries()) {
                    if (pending.toolcallId === toolCallId) {
                        set(removePendingBatchApprovalAtom, approvalId);
                        break;
                    }
                }

                // Same for a table card: create_table returns on the backend's
                // timeout too, and the card must not outlive its call.
                set(removePendingTableCardForToolCallAtom, toolCallId);
                set(releaseCardAnswerAtom, toolCallId);
            }
        },

        onToolCallProgress: (event: WSToolCallProgressEvent) => {
            session.streamActivity.noteActivity(event.run_id);
            logger(`WS onToolCallProgress: ${event.run_id} - ${event.tool_call_id} - ${event.progress}`, 1);
            set(activeRunAtom, (prev) => prev ? updateRunWithToolCallProgress(prev, event) : prev);
        },

        onToolCallArgsStream: (event: WSToolCallArgsStreamEvent) => {
            session.streamActivity.noteActivity(event.run_id);
            set(activeRunAtom, (prev) => prev ? updateRunWithToolCallArgsStream(prev, event) : prev);
        },

        onStreamingDone: (event: WSStreamingDoneEvent) => {
            logger('WS onStreamingDone:', { runId: event.run_id }, 1);
            // The model is done; what is left is the citation lookup, and the
            // footer reports that. Stop measuring rather than counting it as a
            // gap the model is sitting in.
            session.streamActivity.reset();
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
            const run = session.store.get(activeRunAtom);
            if (run?.id === event.run_id && run.thread_id)
                setAdmission(set, run.thread_id, event.run_id, "idle");
            // Streaming-done is deliberately left set: this frame now arrives
            // as soon as the run is durable, with the citation lookup still
            // running, and that state is what tells the user their sources are
            // still being linked. `onRunCitations` ends it. A backend too old
            // to send that event embeds the citations below, and `onDone` —
            // which follows immediately — is the backstop there.

            // Clear retry state when run completes
            set(wsRetryAtom, null);

            // Store transient backend flags (not persisted on AgentRun).
            // The only frame that carries this flag, failed and canceled runs
            // included: a run that ends with partial output still gets a
            // run_complete ahead of its error frame, and that frame reports the
            // usage. (Not a run the socket dropped — but there is nobody left to
            // warn there.) Keyed by run id in an atom that never consults run
            // status, so a failed run drives the same composer warning a
            // finished one does — the composer's own fallback reads
            // `total_usage`, which a failed run has none of.
            if (event.high_token_usage) {
                session.host.markHighTokenUsage(set, event.run_id);
            }

            // Citations, for a backend that still embeds them here. Current
            // ones send `citations: null` and follow with `run_citations`.
            applyRunCitations(session, set, event.run_id, event.citations);

            // Process agent actions from run complete event
            if (event.agent_actions && event.agent_actions.length > 0) {
                logger(`WS onRunComplete: Processing ${event.agent_actions.length} agent actions`, 1);
                const actions = event.agent_actions.map(toAgentAction);
                session.host.addAgentActions(set, actions);
                // Load item data for the actions, then auto-apply annotations if enabled
                await session.host.prepareAgentActions(event.run_id, actions);
            }

            // Surface an OS-native notification if the user can't currently see
            // the completed response (e.g. working in another app). A run that
            // parked has not finished: it waits on a card (whose own
            // notification asked for it) or on a fill (its resume notifies).
            if (!event.parked) session.host.notifyRunComplete();
        },

        onRunCitations: (event: WSRunCitationsEvent) => {
            logger('WS onRunCitations:', {
                runId: event.run_id,
                citationsCount: event.citations?.length ?? 0,
            }, 1);

            applyRunCitations(session, set, event.run_id, event.citations);

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
            if (!bindWriter(writer, newThreadId)) { session.agentService.close(1000, 'Chat ownership changed'); return; }
            Zotero.Beaver?.threads?.invalidateViews();
            logger('WS onThread:', { threadId: newThreadId }, 1);
            set(currentThreadIdAtom, newThreadId);
            set(activeRunAtom, (prev) => prev ? { ...prev, thread_id: newThreadId } : prev);
            const run = session.store.get(activeRunAtom);
            const admission = session.store.get(threadAdmissionAtom);
            if (run) {
                // The thread is claimed, but its run may not have been inserted yet.
                setAdmission(set, newThreadId,
                    admission?.threadId === newThreadId ? admission.tailRunId : null,
                    "idle", run.id);
            }
        },

        onThreadName: (event: WSThreadNameEvent) => {
            logger('WS onThreadName:', { threadId: event.thread_id, name: event.name }, 1);
            set(currentThreadNameAtom, event.name);
            Zotero.Beaver?.threads?.patchThread(event.thread_id, { name: event.name });
        },

        onDone: () => {
            logger('WS onDone: Request fully complete', 1);
            restoreComposer = undefined;
            const completed = session.store.get(activeRunAtom);
            if (completed?.thread_id)
                setAdmission(set, completed.thread_id, completed.id, "idle");
            session.streamActivity.reset();

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

            // An answer the run parked before receiving resumes it at once.
            // Settled before closing, which settles them as a lost connection.
            settleLiveCardAnswers(set, !!completed?.parked);
            session.agentService.close();
            set(isWSChatPendingAtom, false);
            // The cards close with the run, unless the run parked on them. A
            // parked card stays and is answerable again; answering it resumes
            // the run.
            const parkedActionIds = (completed?.parked?.requests ?? [])
                .filter((deferral) => deferral.kind === 'agent_action_approval')
                .map((deferral) => deferral.correlation_id);
            for (const actionId of parkedActionIds) {
                set(removeApprovalResponseIntentAtom, actionId);
                set(unmarkApprovalStaleAtom, actionId);
            }
            // The window keeps waiting on a fill only when the run parked on it.
            settleJobWait(session.store, completed);
            settleRunCards(session.store.get, set);
            if (completed?.parked) scheduleParkedAnswerFlush(session);
            else set(clearParkedAnswersAtom);
        },

        onError: (event: WSErrorEvent) => {
            logger('WS onError:', event, 1);
            const restore = restoreComposer;
            restoreComposer = undefined;
            if (
                isThreadConflict(event) ||
                event.type === "thread_admission_unavailable"
            ) {
                set(threadConflictAtom, event.type);
                const id = session.store.get(currentThreadIdAtom);
                if (id && event.type === "thread_busy")
                    setAdmission(set, id, session.store.get(threadAdmissionAtom)?.tailRunId ?? null, 'unknown');
                if (restore && navigation === session.host.navigationSeq()
                    && composerRunId === session.store.get(activeRunAtom)?.id
                    && (!event.run_id || event.run_id === composerRunId)) {
                    restore();
                }
            }
            const errorRunId = resolveErrorRunId(event, session.store.get(activeRunAtom));

            // An error can release the writer before onClose arrives. Retire
            // connection UI here while these callbacks still own the request.
            set(isWSConnectedAtom, false);
            set(isWSReadyAtom, false);
            // Including a reattach this error ended.
            set(wsReconnectingAtom, null);
            // Clear streaming-done state
            set(streamingDoneRunIdsAtom, new Set<string>());
            session.streamActivity.reset();

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
            // Close the run's cards and dismiss the diff preview (run failed).
            // A resume that failed, or a message that failed before it
            // superseded anything, leaves the parked run open: its cards stay,
            // and answering one again resumes it. Answers queued for the
            // failed resume are dropped with it.
            set(parkedAnswerQueueAtom, new Map());
            settleLiveCardAnswers(set, false);
            settleRunCards(session.store.get, set);

            const failedPrompt = errorRunId
                ? findRunForResume(session.store.get(threadRunsAtom), session.store.get(activeRunAtom), errorRunId)?.user_prompt
                : undefined;
            const isParkedResume = !!failedPrompt?.deferred_results;
            if (isParkedResume && PARKED_RESUME_RELOAD_ERRORS.has(event.type)) {
                // The parked run was answered or closed elsewhere (another
                // device, say): show the thread as the server has it. Cards
                // still open there stay answerable.
                const threadId = session.store.get(currentThreadIdAtom);
                const userId = session.host.getUserId();
                if (threadId && userId && navigation === session.host.navigationSeq()) {
                    session.host.notify(set, {
                        type: 'warning',
                        title: 'Answer not sent',
                        text: 'This chat changed before your answer arrived. It was reloaded; answer again if the question is still open.',
                        expire: true,
                    });
                    // Once this run has released the chat: the reload records
                    // the history revision it shows, and releasing the chat
                    // afterwards would leave this window a revision behind.
                    void Promise.resolve().then(() => session.host.reloadThread(threadId, userId))
                        .catch((error) => logger(`WS onError: reloading the thread failed: ${error}`, 1));
                }
            }

            if (
                !isParkedResume &&
                !isThreadConflict(event) &&
                event.try_auto_resume &&
                errorRunId &&
                !session.store.get(scheduledAutoResumeRunIdsAtom).has(errorRunId)
            ) {
                // Retry when only thinking has streamed so far (nothing
                // user-visible to preserve). Otherwise resume from the
                // failure point so streamed text/tool calls are kept.
                //
                // If the failed run is itself a resume run, always auto-resume
                // — earlier runs in the resume chain may hold user-visible
                // content, and a retry would truncate the chain from its root.
                const failedRun = findRunForResume(
                    session.store.get(threadRunsAtom),
                    session.store.get(activeRunAtom),
                    errorRunId,
                );
                const retryInsteadOfResume =
                    !(failedRun && isContinuationPrompt(failedRun.user_prompt)) &&
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
                    session.store.set(autoRetryErroredRunAtom, errorRunId);
                } else {
                    session.store.set(autoResumeErroredRunAtom, errorRunId);
                }
            }
        },

        onWarning: (event: WSWarningEvent) => {
            logger('WS onWarning:', event, 1);
            set(wsWarningAtom, event);
            // Add to dismissable warnings
            session.host.addWarning(set, {
                run_id: event.run_id,
                type: event.type,
                message: event.message,
                data: event.data,
            });
        },

        onRetry: (event: WSRetryEvent) => {
            logger('WS onRetry:', event, 1);
            // A reset clears what streamed before the retry shows, so the
            // window never shows the retry over the discarded response.
            if (event.reset) {
                logger(`WS onRetry: resetting run messages for run ${event.run_id}`, 1);
                set(activeRunAtom, (prev) => prev ? resetRunMessages(prev) : prev);
            }
            set(wsRetryAtom, {
                runId: event.run_id,
                attempt: event.attempt,
                maxAttempts: event.max_attempts,
                reason: event.reason,
                waitSeconds: event.wait_seconds,
            });

            // A new wait, dated from the retry: `noteActivity` would drop an
            // already-showing indicator for a second, and leaving the old clock
            // would count seconds from the last token rather than from now.
            session.streamActivity.startWait(event.run_id);
        },

        onAgentActions: async (event: WSAgentActionsEvent) => {
            logger('WS onAgentActions:', {
                runId: event.run_id,
                actionsCount: event.actions.length,
            }, 1);
            const actions = event.actions.map(toAgentAction);
            session.host.upsertAgentActions(set, actions);

            // Mark external references as imported for applied item-creating actions
            // This handles cases where actions are applied via PendingActionsBar
            for (const action of actions) {
                if (isItemCreatingAgentAction(action) && action.status === 'applied' && action.result_data) {
                    const externalId = itemActionExternalId(action);
                    const resultData = action.result_data as CreateItemResultData;

                    if (externalId && resultData.library_id && resultData.zotero_key) {
                        session.host.markExternalReferenceImported(set, externalId, {
                            library_id: resultData.library_id,
                            zotero_key: resultData.zotero_key,
                            library_ref: resultData.library_ref,
                        });
                        logger(`WS onAgentActions: Marked external reference ${externalId} as imported`, 1);
                    }
                }
            }

            // Load item data for the actions, then auto-apply annotations if enabled
            await session.host.prepareAgentActions(event.run_id, actions);
        },

        onMissingZoteroData: (event: WSMissingZoteroDataEvent) => {
            logger('WS onMissingZoteroData:', {
                runId: event.run_id,
                itemCount: event.items.length,
                items: event.items,
            }, 1);
            // Works out why each item is missing and adds a warning.
            session.host.reportMissingZoteroData(set, event);
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
            const runPolicy = session.store.get(runApprovalPolicyAtom);
            const activeRunId = session.store.get(activeRunAtom)?.id ?? null;
            if (isActionApprovedForCurrentRun(
                runPolicy,
                activeRunId,
                event.action_type,
                event.action_data,
            )) {
                logger(`Auto-approving ${event.action_type} for the current run`, 1);
                session.agentService.sendApprovalResponse(event.action_id, true);
                return;
            }

            if (takeResumedCard(session, session.store.get, set, event.toolcall_id, session.store.get(pendingApprovalsAtom).has(event.action_id))) return;

            // Default: add to pending approvals map for UI rendering
            set(addPendingApprovalAtom, event);
        },

        onDeferredApprovalStale: (event: WSDeferredApprovalStale) => {
            logger('WS onDeferredApprovalStale:', {
                actionId: event.action_id,
                reason: event.reason,
            }, 1);
            // The card parks with its run: the answer is kept and resumes the
            // parked run once it has parked (see `onDone`), so the card stays
            // on its spinner rather than offering to apply locally.
            if (event.reason === 'parking' && set(markLiveApprovalAnswerParkingAtom, event.action_id)) {
                set(removePendingApprovalAtom, event.action_id);
                return;
            }
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
            session.host.notifyCreditConfirmation(event);
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

        onBatchApprovalRequest: (event: WSBatchApprovalRequest) => {
            logger('WS onBatchApprovalRequest:', {
                approvalId: event.approval_id,
                runId: event.run_id,
                toolcallId: event.toolcall_id,
                batchId: event.batch_id,
                defaultMode: event.default_mode,
                hasDestructiveWarning: Boolean(event.destructive_warning),
            }, 1);
            if (takeResumedCard(session, session.store.get, set, event.toolcall_id, session.store.get(pendingBatchApprovalsAtom).has(event.approval_id))) return;
            set(addPendingBatchApprovalAtom, event);

            // Surface an OS-native notification if the user can't currently see
            // the card — the batch stays parked until they decide.
            session.host.notifyBatchApproval(event);
        },

        onBatchApprovalStale: (event: WSBatchApprovalStale) => {
            logger('WS onBatchApprovalStale:', {
                approvalId: event.approval_id,
                reason: event.reason,
            }, 1);
            // The batch moved on without the decision and there is nothing to
            // apply locally, so the card is simply retired.
            set(removePendingBatchApprovalAtom, event.approval_id);
        },

        onTableCardRequest: (event: WSTableCardRequest) => {
            logger('WS onTableCardRequest:', {
                cardId: event.card_id,
                runId: event.run_id,
                toolcallId: event.toolcall_id,
                scope: event.scope,
                sources: event.sources.length,
                columns: event.columns.length,
            }, 1);
            // A card this client cannot show is declined, as by a client
            // without a table card handler: the run is not held for its timeout.
            if (!isCreateCard(event) && !isFillCard(event)) {
                session.agentService.sendTableCardResponse({ type: 'table_card_response', card_id: event.card_id, approved: false });
                return;
            }
            if (takeResumedCard(session, session.store.get, set, event.toolcall_id, session.store.get(pendingTableCardsAtom).has(event.card_id))) return;
            set(addPendingTableCardAtom, event);
        },

        onTableCardStale: (event: WSTableCardStale) => {
            logger('WS onTableCardStale:', { cardId: event.card_id, reason: event.reason }, 1);
            set(removePendingTableCardAtom, event.card_id);
        },

        onAskUserQuestionRequest: (event: WSAskUserQuestionRequest) => {
            logger('WS onAskUserQuestionRequest:', {
                questionId: event.question_id,
                toolcallId: event.toolcall_id,
                questionCount: event.questions.length,
            }, 1);
            if (takeResumedCard(session, session.store.get, set, event.toolcall_id, session.store.get(pendingQuestionsAtom).has(event.toolcall_id))) return;
            set(addPendingQuestionAtom, event);

            // Surface an OS-native notification if the user can't currently see
            // the question panel (e.g. working in another app), mirroring the
            // deferred-approval path.
            session.host.notifyUserQuestion(event);
        },

        onOpen: () => {
            logger('WS onOpen: Connection established, waiting for ready...', 1);
            set(isWSConnectedAtom, true);
        },

        onClose: (code: number, reason: string, wasClean: boolean, transportEvidence) => {
            logger(`WS onClose: code=${code}, reason=${reason}, clean=${wasClean}`, 1);
            // Whether this connection had received the `ready` event, read
            // before the flag is cleared. Distinguishes a connect-phase
            // failure (reported once by executeWSRequest's catch) from a
            // post-ready drop (handled here).
            const hadReachedReady = session.store.get(isWSReadyAtom);
            endRunOnLostConnection(transportEvidence, hadReachedReady);
        },

        // The socket was lost but the run goes on on the server. Everything
        // the run is showing stays — streamed text, approval and question
        // cards, the pending flag and the writer — while a new socket picks
        // it up; only the connection state changes.
        onReattaching: (info: WSReattachingInfo) => {
            logger(`WS onReattaching: run ${info.runId} lost its connection, reattaching`, 1);
            set(isWSConnectedAtom, false);
            set(isWSReadyAtom, false);
            // The wait is the connection's, not the model's.
            session.streamActivity.reset();
            // Attempt 1 renders as a plain "Reconnecting…": the reattach
            // retries until the grace period ends, with no count to show. It
            // stays hidden for a blip and escalates from when the loss began.
            set(wsReconnectingAtom, {
                attempt: 1,
                maxAttempts: CONNECT_MAX_ATTEMPTS,
                since: info.detachedAt,
                graceMs: info.graceMs,
            });
            startReattach(info.runId);
        },

        onReattached: (info: WSReattachedInfo) => {
            logger(`WS onReattached: run ${info.runId} after ${info.gapMs}ms (${info.attempts} socket(s), ${info.losses} lost), ${info.replayed} event(s) replayed`, 1);
            set(wsReconnectingAtom, null);
            set(isWSConnectedAtom, true);
            set(isWSReadyAtom, true);
            reportReattachOutcome(info);
        },

        // The run could not be picked up again: it ends exactly as the
        // original loss would have ended it without reattach.
        // This request replaced a run the user stopped while it was
        // reconnecting, before the stop got through.
        onPreviousRunNotStopped: (runId: string) => {
            logger(`WS onPreviousRunNotStopped: run ${runId}`, 1);
            session.host.notify(set, {
                type: 'warning',
                title: 'Stop not confirmed',
                text: 'Beaver could not confirm the stop of the previous response before sending this message. It may have finished in its chat and been charged.',
                expire: false,
            });
        },

        onReattachFailed: (info: WSReattachFailedInfo) => {
            logger(`WS onReattachFailed: run ${info.runId} (${info.reason}) after ${info.gapMs}ms`, 1);
            set(wsReconnectingAtom, null);
            endRunOnLostConnection(info.evidence, true, reattachFailureOutcome(info));
            // The server may still finish the run, or has saved it already.
            if (navigation === session.host.navigationSeq()) awaitServerSettlement(session, set, 'reattach_failed');
        },

        onUndeliveredActions: (info: WSUndeliveredActionsInfo) => recordUndeliveredActions(info),
    };
    /**
     * A run the user stopped while it was reconnecting may still have finished
     * on the server, or still be running there. Once the reattach is over, the
     * chat still showing it waits for the server and loads what it saved.
     */
    const settleLeftRun = (runId: string) => {
        // A stop made while reconnecting blocked the chat until the server
        // was idle, so an idle chat has already loaded what the server saved.
        const settledAfterHeldStop = session.heldStopRunIds.delete(runId)
            && session.store.get(threadAdmissionAtom)?.activity.state === 'idle';
        if (
            navigation !== session.host.navigationSeq() ||
            currentWriter(session) ||
            isRunActive(session.store.get(activeRunAtom)) ||
            !session.store.get(threadRunsAtom).some((run) => run.id === runId) ||
            settledAfterHeldStop
        ) return;
        awaitServerSettlement(session, session.store.set, 'stop_unconfirmed');
    };
    // What still happens for a run this window has left, e.g. one the user
    // stopped while it was reconnecting: it is still reattached, so the server
    // hears the cancel, its connection loss is still reported once the
    // outcome is known, and the chat waits for the server to settle it. None
    // of its events reach this window.
    const forLeftRun: Partial<WSCallbacks> = {
        onUndeliveredActions: (info) => recordUndeliveredActions(info),
        onReattaching: (info) => {
            if (info.cancelRequested) startReattach(info.runId);
        },
        onReattached: (info) => {
            reportReattachOutcome(info);
            settleLeftRun(info.runId);
        },
        onReattachFailed: (info) => {
            reportReattachOutcome(info);
            settleLeftRun(info.runId);
        },
    };
    const guarded: Record<string, unknown> = { ...callbacks };
    for (const [name, callback] of Object.entries(callbacks)) {
        if (typeof callback !== 'function') continue;
        guarded[name] = (...args: unknown[]) => {
            if (generation !== getCredentialGeneration()) return;
            if (!ownsWriter(session, writer) || callbackEpoch !== session.writerCallbackEpoch) {
                const left = forLeftRun[name as keyof WSCallbacks] as ((...leftArgs: unknown[]) => unknown) | undefined;
                left?.(...args);
                return;
            }
            const result = (callback as (...callbackArgs: unknown[]) => unknown)(...args);
            if (name === 'onDone' || name === 'onError' || name === 'onClose' || name === 'onReattachFailed') {
                if (result instanceof Promise) return result.finally(() => settleWriter(session, session.store.get, writer));
                settleWriter(session, session.store.get, writer);
            }
            return result;
        };
    }
    return guarded as unknown as WSCallbacks;
}

/** Test-only: reset the session's shutdown latch between cases. */
export function clearClientShutDownLatch(): void {
    getRunSession().clientShutDown = false;
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
    session: RunSession,
    run: AgentRun,
    request: AgentRunRequest,
    get: Getter,
    set: Setter,
    restoreComposer?: () => void,
): Promise<void> {
    assertWriter(session, currentWriter(session));
    const admission = get(threadAdmissionAtom);
    if (request.thread_id && admission?.threadId !== request.thread_id) {
        restoreComposer?.();
        throw new Error("Refresh the chat before sending again.");
    }
    request.expected_tail_run_id = request.thread_id
        ? (admission?.tailRunId ?? null)
        : null;
    // Every send/retry/resume lands here; stop if the client is already gone.
    if (session.clientShutDown) {
        logger('executeWSRequest: client is shutting down, not connecting', 1);
        set(abandonActiveRunLocallyAtom);
        return;
    }

    const requestWriter = currentWriter(session);
    // How many attempts this run's connection cost, once it has one.
    let attemptsMade: number | null = null;

    /**
     * Whether a different run has taken over the state this function writes.
     *
     * A connect loop outlives its own run by up to one backoff, and the reconnect
     * state and the pending flag are both connection-wide rather than per-run. So
     * a run cancelled mid-backoff, followed straight away by another, leaves an
     * older loop about to write over the newer run's state — clearing a reconnect
     * it is in the middle of, or releasing a composer it is still holding.
     */
    const supersededByLiveRun = (): boolean => {
        const activeRun = session.store.get(activeRunAtom);
        return (
            !!activeRun &&
            activeRun.id !== run.id &&
            (activeRun.status === 'in_progress' || activeRun.status === 'awaiting_deferred')
        );
    };

    const searchIndexState = await getSearchIndexState();
    assertWriter(session, requestWriter);
    if (session.clientShutDown || supersededByLiveRun()) return;
    delete request.search_index_state;
    if (searchIndexState) request.search_index_state = searchIndexState;

    // A run stopped while it was reconnecting holds this one back until the
    // server has its cancel; say so while the new message waits.
    // Whether that stop got through is reported by `onPreviousRunNotStopped`
    // once this request has actually replaced the run.
    const handoff = session.agentService.cancelHandoff();
    const handoffMark = handoff ? ++session.cancelHandoffSeq : null;
    const endHandoff = () => {
        if (handoffMark === session.cancelHandoffSeq) session.store.set(stoppingPreviousRunAtom, false);
    };
    if (handoff) {
        session.store.set(stoppingPreviousRunAtom, true);
        void handoff.then(endHandoff);
    }

    session.connectLoopsInFlight++;
    const result = await connectWithRetry({
        service: session.agentService,
        request,
        callbacks: createWSCallbacks(set, () => attemptsMade, restoreComposer, session),
        logLabel: `run ${run.id}`,
        // Every attempt starts from a clean ready state.
        onAttempt: () => set(isWSReadyAtom, false),
        onRetrying: (progress) => {
            if (supersededByLiveRun()) return;
            if (!progress) {
                set(wsReconnectingAtom, null);
                return;
            }
            // The failed attempt's own close cleared the pending flag on its way
            // out; restore it so the composer stays blocked while we quietly
            // retry.
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
            const activeRun = session.store.get(activeRunAtom);
            return (
                ownsWriter(session, requestWriter) && activeRun?.id === run.id &&
                (activeRun.status === 'in_progress' || activeRun.status === 'awaiting_deferred')
            );
        },
    }).finally(() => {
        session.connectLoopsInFlight--;
        // Also when the request was abandoned during the wait.
        endHandoff();
    });

    if (!ownsWriter(session, requestWriter)) return;
    attemptsMade = result.attemptsMade;

    if (result.kind === 'connected') return;

    if (result.kind === 'abandoned') {
        if (result.reason === 'already_reported') {
            logger('WS connection error: Error already set by onError callback, not overwriting', 1);
            // The onError that set this error may have dispatched an auto-retry
            // whose commit is now in flight and owns the pending flag (see
            // retryPendingRunIdAtom) — or a newer run may be holding it, which
            // this loop has no business releasing.
            if (!get(retryPendingRunIdAtom) && !supersededByLiveRun()) {
                set(isWSChatPendingAtom, false);
            }
            return;
        }
        logger(`WS connect retry abandoned: run ${run.id} is no longer active`, 1);
        // Release the flag the quiet retry raised. Nothing downstream clears it
        // on this path, and a stuck flag leaves the composer blocked with no run
        // to finish and no error to show. Unless the run that superseded this one
        // is now holding the flag for itself, in which case releasing it would
        // open the composer over a run that is still going.
        if (!supersededByLiveRun()) set(isWSChatPendingAtom, false);
        return;
    }

    surfaceAndDiagnoseConnectionFailure(session,set, run.id, result.evidence, result.attemptsMade);
    // Guarded like the abandoned paths above, because this one is reachable with
    // a newer run live too: an attempt can be in flight for twenty seconds, and a
    // run that starts in that window has already raised the flag for itself
    // before its own connect begins. Releasing it here would open the composer
    // over that run and let a second send go out behind it. The error itself
    // needs no such guard — it is filed against this run, and
    // `surfaceAndDiagnoseConnectionFailure` drops it if that run is gone.
    if (!supersededByLiveRun()) set(isWSChatPendingAtom, false);
}

/** A message the window assembled, ready to run. */
export interface MessageSubmission {
    prompt: BeaverAgentPrompt;
    /** Null for a new chat: the backend names the thread. */
    threadId: string | null;
    userId: string;
    model: ModelConfig | null;
    /** Model selection for the request, captured with `model`. */
    modelOptions: ModelSelectionOptions;
    /** Custom instructions, read when the send began. */
    customInstructions?: string;
    runIdOverride?: string;
    permissionsOverride?: Partial<ChargingPermissions>;
}

/**
 * Start the run for a message the window assembled.
 *
 * Flow:
 * 1. Create AgentRun shell → set activeRunAtom → UI shows user message + spinner
 * 2. Connect WebSocket with auth params
 * 3. Receive "ready" event → send AgentRunRequest
 * 4. "part" events → update model_messages with text/thinking/tool_call
 * 5. "tool_return" events → add ToolReturnPart to model_messages
 * 6. "run_complete" event → update usage, set status="completed"
 * 7. "done" event → move activeRun to threadRuns, close connection
 *
 * `onAccepted` runs once the run is installed, before it connects: the window
 * clears its composer there, and returns how to put the draft back if the
 * server refuses the run.
 */
export async function startMessageRun(
    session: RunSession,
    get: Getter,
    set: Setter,
    submission: MessageSubmission,
    onAccepted?: () => (() => void) | undefined,
): Promise<void> {
    const { prompt, threadId, userId, model, modelOptions, customInstructions, runIdOverride, permissionsOverride } = submission;

    // A failed run still in the active slot has to stay in local
    // history: the server persisted it, and overwriting the slot
    // without archiving would drop it from the client's view — a
    // ghost in the middle of the server thread.
    archiveTerminalActiveRun(get, set);

    const { run, request } = createAgentRunShell(
        prompt,
        threadId,
        userId,
        model?.name ?? 'unknown',
        modelOptions,
        model?.provider,
        customInstructions,
        model?.is_custom ? model.custom_model : undefined,
        { runIdOverride, permissionsOverride },
    );

    // Set active run - UI now shows user message + spinner
    set(activeRunAtom, run);
    const restoreComposer = onAccepted?.();

    await executeWSRequest(session, run, request, get, set, restoreComposer);
}

/** How a regenerate path replaces the target run. */
interface RegenerateRunOptions {
    window?: Window;
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
async function startRegenerateRunOwned(
    session: RunSession,
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
    // Replacing a run that is reconnecting would stop it, and that stop is
    // billed. The retry controls are disabled meanwhile; this covers the rest.
    if (get(isRunReconnectingAtom)) {
        logger(`${logPrefix}: Blocked — the active run is reconnecting`, 1);
        return;
    }

    // Dismiss any open diff preview before regenerating
    session.host.dismissDiffPreview();

    let newRunId: string | null = null;
    let commit: RetryCommit | undefined;

    try {
        // Which chat this replacement belongs to. Must precede every await in
        // the function — retrying a still-live run cancels it first, and a
        // sequence captured after that flush would already carry a switch made
        // during it, blinding every later check. See
        // `abandonReplacementIfThreadChanged`.
        const navSeqBeforeAwait = session.host.navigationSeq();

        // Get current model
        const model = session.host.getModel();
        if (!model) {
            logger(`${logPrefix}: No model selected`, 1);
            return;
        }

        // Get user ID
        const userId = session.host.getUserId();
        if (!userId) {
            logger(`${logPrefix}: No user ID found`, 1);
            return;
        }

        // Fold a terminal run out of the active slot into thread history
        // before the removed set is computed: a failed run being replaced
        // contributes its applied actions to the confirm dialog. Reconciliation
        // below distinguishes persisted runs from local-only failed requests.
        archiveAndClearTerminalActiveRun(get, set);

        // Find the run — a terminal run was archived into threadRuns above,
        // so only a still-live run is found through the active slot.
        let threadRuns = get(threadRunsAtom);
        const activeRun = get(activeRunAtom);

        let targetRun: AgentRun | null = null;
        let runIndex = threadRuns.findIndex(r => r.id === runId);

        if (runIndex >= 0) {
            targetRun = threadRuns[runIndex];
        } else if (activeRun?.id === runId) {
            // The run is currently active - cancel it and resubmit
            targetRun = activeRun;
            runIndex = threadRuns.length;
        }

        if (!targetRun) {
            logger(`${logPrefix}: Run ${runId} not found`, 1);
            return;
        }

        set(retryPendingRunIdAtom, runId);
        if (activeRun) {
            // A live follow-up belongs to the suffix being replaced too.
            // Keep its stopped response in history until truncation succeeds,
            // including when the request fails or the undo dialog is canceled.
            threadRuns = appendRunIfMissing(threadRuns, {
                ...activeRun,
                status: 'canceled',
                completed_at: new Date().toISOString(),
            });
            set(threadRunsAtom, threadRuns);
            // Clear the active run before awaiting cancel: session.agentService.cancel()
            // waits for the cancel message to flush, and if the socket closes
            // uncleanly during that window, the onclose handler must not see this
            // run still marked active and misattribute the close as a connection
            // failure. The pending flag stays set until cancel resolves so the
            // composer guard keeps blocking new sends during the flush.
            set(activeRunAtom, null);
            await session.agentService.cancel();

            // The earliest await in this function, and everything after it
            // reads live state: the thread id the truncate is addressed to,
            // and the applied actions the undo dialog lists. Checking only
            // after the POST would let a switch made during this flush put
            // that dialog in front of the new chat and aim the removal at it.
            // Ahead of the clear below, which abandoning does for itself.
            if (abandonReplacementIfThreadChanged(session, get, set, {
                navSeqBeforeAwait,
                pendingRetryRunId: runId,
                logPrefix,
                popupText: USER_RETRY_ABANDONED_TEXT,
            })) {
                return;
            }
            set(isWSChatPendingAtom, false);
        }

        const localHistory = threadRuns;
        const observedAdmission = get(threadAdmissionAtom);
        let persistedRunIds: Set<string> | undefined;
        const intendedRunIds = new Set(threadRuns.map((run) => run.id));
        intendedRunIds.add(targetRun.id);
        const settlementThreadId =
            get(currentThreadIdAtom) || targetRun.thread_id;
        if (settlementThreadId && Zotero.Beaver?.presence) {
            // A retry that stopped the running response says so while the
            // server ends it; otherwise the retry control shows the wait.
            const waitReason = activeRun ? 'stopping_previous' : undefined;
            setAdmission(set, settlementThreadId, get(threadAdmissionAtom)?.tailRunId ?? null, 'unknown',
                undefined, waitReason);
            const generation = getCredentialGeneration();
            const current = () =>
                navSeqBeforeAwait === session.host.navigationSeq() &&
                generation === getCredentialGeneration() &&
                ownsWriter(session, currentWriter(session));
            const deadline = Date.now() + 130000;
            let delay = 250;
            let settledHistory: Awaited<ReturnType<typeof readAdmissionHistory>>;
            for (;;) {
                const history = await readAdmissionHistory(settlementThreadId, true);
                if (!current()) return;
                setAdmission(set, settlementThreadId, history.tail_run_id, history.activity, undefined, waitReason);
                if (history.activity.state !== 'active') {
                    settledHistory = history;
                    break;
                }
                if (Date.now() >= deadline)
                    throw new Error(
                        "The response is still settling. Retry once it finishes.",
                    );
                await Zotero.Promise.delay(delay);
                if (!current()) return;
                delay = Math.min(delay * 2, 3000);
            }
            if (!(await reconcileThread(session, get, set, current, settledHistory))) return;
            threadRuns = get(threadRunsAtom);
            const persisted = new Set(threadRuns.map(run => run.id));
            persistedRunIds = persisted;
            // A request that failed before the backend inserted its run exists
            // only in this renderer, and a follow-up sent after it is saved
            // behind it, so such runs are kept wherever they sit. Every other
            // local run must appear in the authoritative history in the same
            // order. The observed tail must stand, or advance to this renderer's
            // claimed run while retaining the previously observed tail.
            // A failed or stopped run the backend did persist is in both lists
            // and needs no rescue.
            const isLocalOnlyFailure = (run: AgentRun) =>
                !persisted.has(run.id) && (run.status === 'error' || run.status === 'canceled');
            const localPersisted = localHistory.filter(run => !isLocalOnlyFailure(run));
            if (observedAdmission?.threadId === settlementThreadId
                && (observedAdmission.tailRunId === get(threadAdmissionAtom)?.tailRunId ||
                    (observedAdmission.unconfirmedRunId === get(threadAdmissionAtom)?.tailRunId &&
                        (!observedAdmission.tailRunId || persisted.has(observedAdmission.tailRunId))))
                && localPersisted.length === threadRuns.length
                && localPersisted.every((run, index) => run.id === threadRuns[index].id)) {
                const authoritative = threadRuns;
                let next = 0;
                threadRuns = localHistory.map(run =>
                    isLocalOnlyFailure(run) ? run : authoritative[next++]);
                set(threadRunsAtom, threadRuns);
            }
            if (threadRuns.some((run) => !intendedRunIds.has(run.id))) {
                set(threadConflictAtom, "thread_tail_mismatch");
                return;
            }
            runIndex = threadRuns.findIndex((run) => run.id === targetRun!.id);
            if (runIndex < 0) {
                set(threadConflictAtom, "thread_tail_mismatch");
                return;
            }
            const localTarget = targetRun;
            targetRun = threadRuns[runIndex];
            // The server finished a response this window had shown as failed
            // or stopped, e.g. after its connection was lost. The saved answer
            // now shows in its place; retrying would discard what was paid for.
            if (
                !editedPrompt &&
                activeRun?.id !== localTarget.id &&
                (localTarget.status === 'error' || localTarget.status === 'canceled') &&
                isRunFinished(targetRun)
            ) {
                logger(`${logPrefix}: Run ${targetRun.id} completed on the server; not retrying it`, 1);
                session.host.notify(set, {
                    type: 'info',
                    title: 'Response finished',
                    text: 'Beaver finished this response after all, so it was not retried.',
                    expire: true,
                });
                return;
            }
        }

        // If the target is a resume run, walk the resume chain back to the
        // root so we regenerate from the original user message, not from an
        // intermediate resume prompt (whose content is empty). The root
        // always lives in threadRuns — startContinuationRun guarantees the failed
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

        // Get thread ID from the target run (may not be set in currentThreadIdAtom yet).
        // Deliberately read after the cancel above: a first run's `thread` event
        // can land during that flush, and reading earlier would miss the id and
        // leave the run stranded server-side.
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
        const allAgentActions = session.host.agentActions();
        const actionsInRemovedRuns = allAgentActions.filter(a => runIdsToRemove.includes(a.run_id));

        // Prompt the user to confirm undoing applied actions. The dialog is
        // the consent and must precede the truncate POST: a user who cancels
        // preserves history and leaves any canceled response stopped. Undo executes after the
        // backend confirms, so a failed POST changes nothing. With nothing to
        // undo, the host returns 'skip' without asking.
        const confirmResult: UndoConfirmResult = session.host.confirmUndo(actionsInRemovedRuns, removedRuns, options.window);
        if (confirmResult === 'cancel') {
            return;
        }

        // Commit the removal on the backend before anything local changes.
        // The retry control's spinner and the composer's pending flag cover
        // the round trip; every failure exit clears both. A thread the
        // backend never assigned has nothing persisted to truncate (a first
        // run that died before the thread event).
        set(retryPendingRunIdAtom, runId);
        set(isWSChatPendingAtom, true);
        commit = beginRetryCommit(session, runId);
        if (threadId) {
            // The run the client expects to survive as the thread's last —
            // the backend refuses when its survivor differs (rewritten by
            // another client), instead of misreading a stale retry as an
            // idempotent replay.
            const survivingRuns = threadRuns.slice(0, runIndex)
                .filter(run => !persistedRunIds || persistedRunIds.has(run.id));
            const expectedTailRunId = survivingRuns.at(-1)?.id ?? null;
            const persistedRemovals = runIdsToRemove.filter(id => !persistedRunIds || persistedRunIds.has(id));
            const outcome = persistedRemovals.length ? await truncateThreadOnServer(
                threadId,
                persistedRemovals,
                expectedTailRunId,
                logPrefix,
            ) : "ok";
            if (abandonReplacementIfThreadChanged(session, get, set, {
                navSeqBeforeAwait,
                pendingRetryRunId: runId,
                logPrefix,
                popupText: USER_RETRY_ABANDONED_TEXT,
            })) {
                return;
            }
            if (outcome === 'failed') {
                set(retryPendingRunIdAtom, null);
                set(isWSChatPendingAtom, false);
                session.host.notify(set, {
                    type: 'error',
                    title: 'Retry failed',
                    text: 'Beaver could not be reached to start the retry. Nothing was changed — please try again.',
                    expire: true,
                });
                return;
            }
            if (outcome === 'refused' || outcome === "busy") {
                reportTruncateConflict(session, set, threadId, expectedTailRunId, outcome, false);
                return;
            }
            setAdmission(set, threadId, expectedTailRunId, "idle");
        }

        if (confirmResult === 'undo') {
            // Single reverse-chronological pass across all applied
            // actions. Cross-type ordering matters — e.g. a
            // create_collection undo cascades to descendants, so any
            // later manage_collections moves into it must be undone
            // first. See the host's `undoAppliedActions`.
            await session.host.undoAppliedActions(actionsInRemovedRuns);
        }

        await session.host.cleanupTemporaryAnnotations(logPrefix);

        // Re-checked after the undo and the cleanup: the undo awaits one Zotero
        // operation per applied action, so it is the longest window in this
        // function and the easiest one to switch chats in.
        if (abandonReplacementIfThreadChanged(session, get, set, {
            navSeqBeforeAwait,
            pendingRetryRunId: runId,
            logPrefix,
            popupText: USER_RETRY_ABANDONED_TEXT,
        })) {
            return;
        }

        // Truncate runs - keep only runs before the target
        set(threadRunsAtom, (prev) =>
            prev.filter(r => !runIdsToRemove.includes(r.id))
        );

        // Clear agent actions for removed runs
        session.host.removeRunActions(set, runIdsToRemove);

        // Drop stashed edits for removed runs; those messages are gone.
        session.host.dropPromptEditDrafts(set, runIdsToRemove);

        // Clear citations for removed runs
        set(citationsAtom, (prev) =>
            prev.filter(c => !runIdsToRemove.includes(c.run_id ?? ''))
        );
        session.host.citationsChanged(set);

        // Reset WS state and set pending
        set(prepareForNewRunAtom);
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
            // A retry re-asks the same question, and the trigger is what tells
            // the backend a person asked for it. An edited prompt is a new
            // question that happens to replace the old turn, so it is not one:
            // reporting it as a retry would count it among the runs that stand
            // in for a failed one.
            { retryTrigger: editedPrompt ? undefined : 'user' },
        );

        // Set active run - UI now shows user message + spinner, which takes
        // over from the retry control's own loading state.
        newRunId = newRun.id;
        set(activeRunAtom, newRun);
        set(retryPendingRunIdAtom, null);
        if (settleRetryCommit(session, set, commit)) return;
        prewarmMuPDFWorker();

        // Execute the WebSocket request
        await executeWSRequest(session, newRun, request, get, set);
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
    } finally {
        endRetryCommit(session, commit);
        if (get(retryPendingRunIdAtom) === runId) {
            set(retryPendingRunIdAtom, null);
            set(isWSChatPendingAtom, false);
        }
    }
}

/**
 * Regenerate a response from a specific run (retry button and error card).
 */
export const regenerateFromRunAtom = sessionAction('regenerateFromRun',
    async (get, set, params: { runId: string; window?: Window }) => {
        const session = sessionOf(get);
        await startRegenerateRun(session, get, set, params.runId, {
            window: params.window,
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
export const regenerateWithEditedPromptAtom = sessionAction('regenerateWithEditedPrompt',
    async (get, set, params: { runId: string; editedPrompt: BeaverAgentPrompt; window?: Window }) => {
        const session = sessionOf(get);
        await startRegenerateRun(session, get, set, params.runId, {
            logPrefix: 'regenerateWithEditedPromptAtom',
            window: params.window,
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
export const autoResumeErroredRunAtom = sessionAction('autoResumeErroredRun',
    async (get, set, failedRunId: string) => {
        const session = sessionOf(get);
        try {
            await startContinuationRun(session, get, set, failedRunId, {
                requireResumable: false,
                trigger: 'auto',
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
export const autoRetryErroredRunAtom = sessionAction('autoRetryErroredRun',
    async (get, set, failedRunId: string) => {
        const session = sessionOf(get);
        try {
            await startAutoRetryRun(session, get, set, failedRunId);
        } finally {
            set(scheduledAutoResumeRunIdsAtom, (prev: Set<string>) => {
                const next = new Set(prev);
                next.delete(failedRunId);
                return next;
            });
        }
    }
);

export const resumeFromRunAtom = sessionAction('resumeFromRun',
    async (
        get,
        set,
        params: string | { runId: string; userMessage?: string },
    ) => {
        const session = sessionOf(get);
        // A bare id from the callers that have nothing to add (the error
        // card's resume button), or the object form from the continue card,
        // which may carry what the user typed.
        const { runId, userMessage } =
            typeof params === 'string' ? { runId: params, userMessage: undefined } : params;
        await startContinuationRun(session, get, set, runId, {
            requireResumable: true,
            trigger: 'user',
            logPrefix: 'resumeFromRunAtom',
            failureErrorType: 'resume_error',
            failureMessage: 'Failed to resume run',
            userMessage,
        });
    }
);

/**
 * Archive the active run as canceled and clear live-run UI state.
 * Store-only — does not touch the socket.
 */
export const abandonActiveRunLocallyAtom = sessionAction('abandonActiveRunLocally',(get, set) => {
    const session = sessionOf(get);
    const writer = currentWriter(session);
    const ownedWriter = !!writer && ownsWriter(session, writer);
    releaseWriter(session);
    // The owner already has the canceled response locally. Other viewers must
    // refresh, but our own release must not make this chat read-only.
    const threadId = get(currentThreadIdAtom);
    if (ownedWriter && threadId) {
        set(viewedHistoryRevisionAtom, Zotero.Beaver.presence.getSnapshot().history[threadId] ?? 0);
    }
    session.writerCallbackEpoch++;
    set(retryPendingRunIdAtom, null);
    set(scheduledAutoResumeRunIdsAtom, new Set());

    // Set pending to false immediately for better UI responsiveness
    set(isWSChatPendingAtom, false);

    set(clearApprovalResponseIntentsAtom);

    // Archive live runs (including deferred-approval). Error runs keep their
    // slot so Retry still works.
    const activeRun = get(activeRunAtom);
    if (activeRun && isRunActive(activeRun)) {
        const canceledRun: AgentRun = {
            ...activeRun,
            status: 'canceled',
            completed_at: new Date().toISOString(),
        };
        // Move canceled run to completed runs
        set(threadRunsAtom, (runs) => [...runs, canceledRun]);
        set(activeRunAtom, null);
    }

    // run_complete can precede citation linking. Preserve that completed
    // response without waiting for the now-revoked onClose callback.
    const completedRun = lingeringCompletedRun(get(activeRunAtom));
    if (completedRun) {
        set(threadRunsAtom, (runs) => appendRunIfMissing(runs, completedRun));
        set(activeRunAtom, null);
    }

    // Clear streaming-done state (abandoned during post-processing)
    set(streamingDoneRunIdsAtom, new Set<string>());
    session.streamActivity.reset();
    // A run abandoned while reconnecting is no longer shown as reconnecting;
    // its reattach goes on only to deliver the cancel.
    set(wsReconnectingAtom, null);
    // Close the run's cards (for parallel tool calls that were awaiting the
    // user). A resume stopped before it ran its tools leaves the parked run
    // open, and its cards stay.
    set(parkedAnswerQueueAtom, new Map());
    settleLiveCardAnswers(set, false);
    settleRunCards(get, set);
});

/**
 * User-initiated close: cancel on the backend, then close.
 * Local bookkeeping is shared with shutdown via `abandonActiveRunLocallyAtom`.
 */
export const closeWSConnectionAtom = sessionAction('closeWSConnection',async (get, set) => {
    const session = sessionOf(get);
    // A retry whose removal is committing cannot be called off any more; the
    // Stop is applied to its replacement once that is in place (see
    // `beginRetryCommit`).
    const commit = session.retryCommit;
    if (commit && get(retryPendingRunIdAtom) === commit.runId) {
        commit.stopRequested = true;
        logger(`closeWSConnectionAtom: retry of run ${commit.runId} is committing its removal; holding the Stop`, 1);
        return;
    }
    // A run stopped while it reconnects is stopped once the server has it
    // back. Until the server confirms, the chat waits for it.
    const activeRun = get(activeRunAtom);
    const stopIsHeld = !!activeRun && isRunActive(activeRun) && session.agentService.isReattaching(activeRun.id);
    // The stopped run no longer waits on its fill (its abort stops it), and
    // the run's own end is not heard once its callbacks are revoked.
    if (activeRun && get(jobWaitAtom)?.runId === activeRun.id) set(jobWaitAtom, null);
    set(abandonActiveRunLocallyAtom);
    if (stopIsHeld) {
        session.heldStopRunIds.add(activeRun.id);
        awaitServerSettlement(session, set, 'stop_unconfirmed');
    }

    // Send cancel message and close connection
    await session.agentService.cancel();
    set(isWSConnectedAtom, false);
    set(isWSReadyAtom, false);
});

/**
 * Close because this client is going away (window close, quit, or plugin disable).
 *
 * Sends a 1000 close, not a cancel (cancel is billed as user-stop). Close is
 * synchronous and happens first. Also aborts in-flight connect loops; if this
 * bundle owns neither a socket nor a loop there is no live run of its own to
 * abandon, so skip. Each main window evaluates its own copy of this bundle,
 * so a window only ever closes the connection it opened.
 *
 * `reason` is logged server-side as the disconnect path.
 */
export const closeWSConnectionForShutdownAtom = sessionAction('closeWSConnectionForShutdown',
    (
        get,
        set,
        reason: string,
        options?: { rememberInterruptedThread?: boolean },
    ) => {
        const session = sessionOf(get);
        // Latch first: a send still preparing has nothing to close or abandon.
        session.clientShutDown = true;
        // A window closing while Zotero runs on leaves the fill it waits on to
        // a table still on screen, or stops it. On a quit Zotero stops it.
        if (!Zotero.__beaverShuttingDown) session.host.leaveJobWaitOnClose();
        if (!session.agentService.isConnected() && session.connectLoopsInFlight === 0) { releaseWriter(session); return; }
        // A run waiting only on cards parks rather than ending with the
        // client, so they can be answered next time. Best effort: the server
        // also parks such a run when its socket closes.
        const parked = (() => {
            const parkRunId = parkableRunId(get, session);
            return !!parkRunId && session.agentService.sendPark(parkRunId);
        })();
        session.agentService.close(1000, reason);
        // A parked run was not interrupted: its card is waiting in the chat.
        if (options?.rememberInterruptedThread && !parked) rememberInterruptedThread(session, get);
        set(abandonActiveRunLocallyAtom);
    },
);

/**
 * Persist the thread whose run this shutdown cut off, so the next session can
 * offer to reopen it. Only a live run counts as interrupted — the socket also
 * stays open for a moment around a run that already finished.
 *
 * The thread id is null until the backend assigns one during a new thread's
 * first run; there is nothing to reopen in that window. The account is stamped
 * on the record because the next session may start under a different one.
 */
function rememberInterruptedThread(session: RunSession, get: Getter): void {
    const activeRun = get(activeRunAtom);
    if (!activeRun || !isRunActive(activeRun)) return;

    const threadId = get(currentThreadIdAtom) || activeRun.thread_id;
    const userId = session.host.getUserId();
    if (!threadId || !userId) return;

    saveInterruptedThread({
        threadId,
        userId,
        threadName: get(currentThreadNameAtom),
        runId: activeRun.id,
    });
}

/**
 * Best-effort local record of approval/reject intent keyed by deferred action id.
 * Used by views to keep the correct spinner visible after a pending approval is removed.
 */
export const approvalResponseIntentsAtom = atom<Map<string, boolean>>(new Map());

export const removeApprovalResponseIntentAtom = sessionAction('removeApprovalResponseIntent',
    (_get, set, actionId: string) => {
        set(approvalResponseIntentsAtom, (prev) => {
            if (!prev.has(actionId)) return prev;
            const next = new Map(prev);
            next.delete(actionId);
            return next;
        });
    },
);

export const clearApprovalResponseIntentsAtom = sessionAction('clearApprovalResponseIntents',
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

export const markApprovalStaleAtom = sessionAction('markApprovalStale',
    (_get, set, actionId: string) => {
        set(staleApprovalActionIdsAtom, (prev) => {
            if (prev.has(actionId)) return prev;
            const next = new Set(prev);
            next.add(actionId);
            return next;
        });
    },
);

export const clearStaleApprovalsAtom = sessionAction('clearStaleApprovals',
    (_get, set) => {
        set(staleApprovalActionIdsAtom, new Set<string>());
    },
);

/** The approval can be answered again: its run parked on it. */
export const unmarkApprovalStaleAtom = sessionAction('unmarkApprovalStale',
    (_get, set, actionId: string) => {
        set(staleApprovalActionIdsAtom, (prev) => {
            if (!prev.has(actionId)) return prev;
            const next = new Set(prev);
            next.delete(actionId);
            return next;
        });
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
export const sendApprovalResponseAtom = sessionAction('sendApprovalResponse',
    (get, set, { actionId, approved, userInstructions }: { actionId: string; approved: boolean; userInstructions?: string | null }) => {
        const session = sessionOf(get);
        const actionChanges = approved ? session.host.actionChanges(actionId) : undefined;
        const toolcallId = get(pendingApprovalsAtom).get(actionId)?.toolcallId;
        const answer = deferredApprovalResponse(actionId, approved, userInstructions, actionChanges);
        const recordIntent = () => set(approvalResponseIntentsAtom, (prev) => {
            const next = new Map(prev);
            next.set(actionId, approved);
            return next;
        });
        if (toolcallId && answerParkedCard(session, get, set, toolcallId, answer)) {
            recordIntent();
            return;
        }
        if (!ownsWriter(session, currentWriter(session))) return;
        recordIntent();
        logger(`sendApprovalResponseAtom: Sending approval response for ${actionId}: ${approved}${userInstructions ? ' (with instructions)' : ''}`, 1);
        const delivered = session.agentService.sendApprovalResponse(actionId, approved, userInstructions, actionChanges);
        if (!delivered) {
            logger(`sendApprovalResponseAtom: Approval response for ${actionId} was not sent; marking stale`, 1);
            set(markApprovalStaleAtom, actionId);
        } else if (toolcallId) {
            set(addLiveCardAnswerAtom, { toolCallId: toolcallId, answer });
        }
    }
);

/**
 * True while a bulk approval verdict is on its way out.
 *
 * Answering can wait on a note preview being torn down, which takes up to a
 * second and a half, and that teardown short-circuits for anyone who asks
 * again while it is running — so a second click would overtake the first and
 * be the one that decides the changes. Claiming this before the wait makes the
 * first verdict the one that counts; it also drives the disabled state on the
 * controls, so the user is not left clicking into silence.
 */
export const approvalVerdictInFlightAtom = atom(false);

/**
 * Claim the right to answer the pending approvals. Returns false when another
 * verdict already holds it.
 *
 * Synchronous, deliberately: a React re-render is too late to stop a second
 * click in the same tick as the first.
 */
export const beginApprovalVerdictAtom = sessionAction('beginApprovalVerdict',(get, set): boolean => {
    if (get(approvalVerdictInFlightAtom)) return false;
    set(approvalVerdictInFlightAtom, true);
    return true;
});

/** Release the claim. Callers must do this on every exit, including failure. */
export const releaseApprovalVerdictAtom = sessionAction('releaseApprovalVerdict',(_get, set) => {
    set(approvalVerdictInFlightAtom, false);
});

/**
 * Answer a set of pending agent-action approvals, carrying the user's typed
 * instructions if they wrote any.
 *
 * One place decides how a bulk answer is delivered, so the docked bar and the
 * composer cannot drift apart on whether the instructions travel. The
 * instructions ride with either verdict: a message written while the run is
 * blocked is the user telling Beaver what to do, not a decision in itself.
 *
 * The caller passes the ids it captured when the user decided, not "whatever is
 * pending now". Tearing down a note preview first can take over a second, and
 * an approval that arrives during it was neither counted on the button the user
 * pressed nor rendered for them to read — it must not inherit their verdict.
 * Ids no longer pending are skipped, so a card answered on its own in the
 * meantime is not answered twice.
 *
 * The set may include the backend's spend and off-device confirmations. Those
 * are carved out of the run's *standing* full-access grant, which is about
 * future library writes the user has not seen; this is the opposite — an
 * explicit yes or no to the exact cards in front of them, counted in the label
 * on the button they pressed.
 *
 * Callers own the note-edit preview: tear it down with
 * `dismissActiveEditNotePreview()` before calling, as every other
 * apply/reject surface does.
 *
 * Returns how many approvals were answered.
 */
export const answerPendingApprovalsAtom = sessionAction('answerPendingApprovals',
    (
        get,
        set,
        { actionIds, approved, userInstructions }: {
            actionIds: readonly string[];
            approved: boolean;
            userInstructions?: string | null;
        },
    ): number => {
        const pending = get(pendingApprovalsAtom);
        const answerable = actionIds.filter((actionId) => pending.has(actionId));
        if (answerable.length === 0) return 0;

        const instructions = userInstructions?.trim() || null;
        for (const actionId of answerable) {
            set(sendApprovalResponseAtom, { actionId, approved, userInstructions: instructions });
        }
        set(removePendingApprovalsAtom, answerable);
        logger(
            `answerPendingApprovalsAtom: ${approved ? 'Approved' : 'Rejected'} ${answerable.length} of ${actionIds.length} action(s)${instructions ? ' with instructions' : ''}`,
            1,
        );
        return answerable.length;
    },
);

/**
 * Set the run's permission mode.
 *
 * Granting full access also answers every pending request the grant covers, so
 * the run is not left blocked on cards the user has just said yes to. Future
 * validations and late-arriving approval requests read the same transient
 * policy, so the grant holds for the rest of the run without being re-sent.
 *
 * A grant only lands on the run that is still active. Callers tear down the
 * note preview first, which can take over a second, and in that time the user
 * may have stopped the run or started another: re-granting authority to a run
 * that has ended would leave the composer flying a banner for a dead run, and
 * the sweep below would answer approvals belonging to a run the user never
 * granted anything.
 *
 * Revoking is not gated the same way. It only takes authority away, so
 * refusing it could strand the user under a grant they are trying to cancel;
 * it is scoped to the run actually holding the grant so a late call cannot
 * rebind the policy to a stale run.
 *
 * Returns how many pending approvals were approved, for the caller's logging
 * and its "waiting for the backend" state.
 */
export const setRunPermissionModeAtom = sessionAction('setRunPermissionMode',
    (
        get,
        set,
        { runId, fullAccess }: { runId: string; fullAccess: boolean },
    ): number => {
        if (!fullAccess) {
            if (isFullAccessGrantedForRun(get(runApprovalPolicyAtom), runId)) {
                set(setRunFullAccessAtom, { runId, fullAccess: false });
                logger(`setRunPermissionModeAtom: Revoked full access for run ${runId}`, 1);
            }
            return 0;
        }

        const activeRunId = get(activeRunAtom)?.id ?? null;
        if (runId !== activeRunId) {
            logger(
                `setRunPermissionModeAtom: Not granting full access to run ${runId}; the active run is ${activeRunId ?? 'none'}`,
                1,
            );
            return 0;
        }
        set(setRunFullAccessAtom, { runId, fullAccess: true });

        const coveredActionIds = getPendingApprovalIdsCoveredByFullAccess(
            get(pendingApprovalsAtom).values(),
        );
        for (const actionId of coveredActionIds) {
            set(sendApprovalResponseAtom, { actionId, approved: true });
        }
        set(removePendingApprovalsAtom, coveredActionIds);

        logger(
            `setRunPermissionModeAtom: Granted full access for run ${runId} and approved ${coveredActionIds.length} pending action(s)`,
            1,
        );
        return coveredActionIds.length;
    },
);

/**
 * Send the user's answers (or a skip) for an ask_user_question request and
 * remove the pending question so the composer re-enables immediately.
 */
export const sendAskUserQuestionResponseAtom = sessionAction('sendAskUserQuestionResponse',
    (get, set, { questionId, toolcallId, answers, cancelled }: {
        questionId: string;
        toolcallId: string;
        answers: AskUserQuestionAnswer[];
        cancelled?: boolean;
    }) => {
        const session = sessionOf(get);
        const answer = askUserQuestionResponse(questionId, answers, cancelled ?? false);
        if (answerParkedCard(session, get, set, toolcallId, answer)) {
            set(removePendingQuestionAtom, toolcallId);
            return;
        }
        if (!ownsWriter(session, currentWriter(session))) return;
        logger(`sendAskUserQuestionResponseAtom: Sending question response for ${questionId}: ${cancelled ? 'cancelled' : `${answers.length} answer(s)`}`, 1);
        if (session.agentService.sendAskUserQuestionResponse(questionId, answers, cancelled ?? false)) {
            set(addLiveCardAnswerAtom, { toolCallId: toolcallId, answer });
        }
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
export const sendCreditConfirmationResponseAtom = sessionAction('sendCreditConfirmationResponse',
    (get, set, { confirmationId, approved, userInstructions }: {
        confirmationId: string;
        approved: boolean;
        userInstructions?: string | null;
    }) => {
        const session = sessionOf(get);
        if (!ownsWriter(session, currentWriter(session))) return;
        logger(`sendCreditConfirmationResponseAtom: Sending credit confirmation response for ${confirmationId}: ${approved}`, 1);
        const delivered = session.agentService.sendCreditConfirmationResponse(
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

/**
 * Send the user's decision for a batch approval and retire the pending card.
 *
 * The card is removed even when the send fails: the decision can no longer
 * reach the run, so leaving it up would strand the user on a card that can
 * never be answered.
 */
export const sendBatchApprovalResponseAtom = sessionAction('sendBatchApprovalResponse',
    (get, set, { approvalId, approved, mode, userInstructions }: {
        approvalId: string;
        approved: boolean;
        mode: BatchApprovalMode;
        userInstructions?: string | null;
    }) => {
        const session = sessionOf(get);
        const toolcallId = get(pendingBatchApprovalsAtom).get(approvalId)?.toolcallId;
        const answer = batchApprovalResponse(approvalId, approved, mode, userInstructions);
        if (toolcallId && answerParkedCard(session, get, set, toolcallId, answer)) {
            set(removePendingBatchApprovalAtom, approvalId);
            return;
        }
        if (!ownsWriter(session, currentWriter(session))) return;
        logger(`sendBatchApprovalResponseAtom: Sending batch approval response for ${approvalId}: ${approved} (${mode})`, 1);
        const delivered = session.agentService.sendBatchApprovalResponse(
            approvalId,
            approved,
            mode,
            userInstructions,
        );
        if (!delivered) {
            logger(`sendBatchApprovalResponseAtom: Batch approval response for ${approvalId} was not sent`, 1);
        } else if (toolcallId) {
            set(addLiveCardAnswerAtom, { toolCallId: toolcallId, answer });
        }
        set(removePendingBatchApprovalAtom, approvalId);
    }
);

/**
 * Send the answer to a table card and retire it.
 *
 * The card is removed even when the send fails: the answer can no longer
 * reach the run, so leaving it up would strand the user on it.
 */
export const sendTableCardResponseAtom = sessionAction('sendTableCardResponse',
    (get, set, response: WSTableCardResponse) => {
        const session = sessionOf(get);
        const toolcallId = get(pendingTableCardsAtom).get(response.card_id)?.toolcall_id;
        // The card's edits are kept until its call resolves: if the answer
        // does not reach a run (the run parks first, or the resume fails),
        // the card comes back with them.
        const retireCardKeepingEdits = () => set(pendingTableCardsAtom, (prev) => {
            if (!prev.has(response.card_id)) return prev;
            const next = new Map(prev);
            next.delete(response.card_id);
            return next;
        });
        if (toolcallId && answerParkedCard(session, get, set, toolcallId, response)) {
            retireCardKeepingEdits();
            return;
        }
        if (!ownsWriter(session, currentWriter(session))) return;
        const delivered = session.agentService.sendTableCardResponse(response);
        if (!delivered) {
            logger(`sendTableCardResponseAtom: Table card response for ${response.card_id} was not sent`, 1);
            set(removePendingTableCardAtom, response.card_id);
            return;
        }
        if (toolcallId) set(addLiveCardAnswerAtom, { toolCallId: toolcallId, answer: response });
        retireCardKeepingEdits();
    }
);

/**
 * Batch progress for the open thread, or null when nothing has been stamped.
 *
 * Derived from the newest `metadata.batch_progress` via
 * `selectLiveBatchProgress`, which keeps only batches something is actually
 * working: everything drops once the run that carried the stamp is terminal —
 * ended batches to `BatchRunReceipt`, open ones because a stopped run leaves
 * its batch paused — as does a batch the stamp itself flags as paused.
 */
export const batchProgressAtom = atom((get) => selectLiveBatchProgress(get(allRunsAtom)));

// =============================================================================
// Parked runs: answering a card after its run parked
// =============================================================================

/**
 * Route an answer to a card of the open parked run, if the card is one.
 *
 * The answer resumes the run: it is queued and sent at once, together with
 * any other answer given in the same moment (Approve all). While a resume of
 * the same run is still going, it waits in the queue: it is sent over the
 * resume's socket once the resume shows its card again, or else goes out with
 * the next resume. Returns false for a live card, a card the running resume
 * already shows again included, which the caller answers over the socket as
 * usual.
 */
function answerParkedCard(session: RunSession, get: Getter, set: Setter, toolcallId: string, answer: ParkedCardAnswer): boolean {
    const open = get(openParkedRunAtom);
    if (!open || !open.toolCallIds.has(toolcallId) || get(resumeLiveCardsAtom).has(toolcallId)) return false;
    logger(`answerParkedCard: queuing the answer to ${toolcallId} for parked run ${open.runId}`, 1);
    set(parkedAnswerQueueAtom, (prev) => new Map(prev).set(toolcallId, { threadId: open.threadId, answer }));
    scheduleParkedAnswerFlush(session);
    return true;
}

/**
 * Take a card a run shows live that is one of the open parked run's cards,
 * shown again by the resume that runs now: the card on screen (`onScreen`)
 * becomes live, and an answer queued for it meanwhile is sent over the socket
 * now. Returns true when nothing is left to show: the queued answer was sent,
 * or the card is already on screen. Any other card is shown as usual.
 */
function takeResumedCard(session: RunSession, get: Getter, set: Setter, toolcallId: string, onScreen: boolean): boolean {
    const open = get(openParkedRunAtom);
    const activeRun = get(activeRunAtom);
    if (!open || !open.toolCallIds.has(toolcallId) || activeRun?.user_prompt?.resumes_run_id !== open.runId) return false;
    set(resumeLiveCardsAtom, (prev) => new Set(prev).add(toolcallId));
    const queued = get(parkedAnswerQueueAtom).get(toolcallId);
    if (!queued) return onScreen;
    set(parkedAnswerQueueAtom, (prev) => {
        const next = new Map(prev);
        next.delete(toolcallId);
        return next;
    });
    // Not sent: the card comes back when the run ends, as for any answer
    // that did not reach its run.
    if (session.agentService.sendCardAnswer(queued.answer)) set(addLiveCardAnswerAtom, { toolCallId: toolcallId, answer: queued.answer });
    return true;
}

/** Send queued answers once the current task (and any answer it gives) is done. */
function scheduleParkedAnswerFlush(session: RunSession): void {
    void Promise.resolve().then(() => session.store.set(flushParkedAnswersAtom));
}


/**
 * The fill result that resumes the open chat's parked run: the fill this
 * window waits on ended, and its call is parked. Read as the resume goes
 * out, so the result is filtered by the library scope as it is then.
 */
function jobResumeAnswer(session: RunSession, get: Getter): { toolCallId: string; answer: ParkedCardAnswer } | null {
    const wait = get(jobWaitAtom);
    if (!wait || wait.threadId !== get(currentThreadIdAtom)) return null;
    const snapshot = session.host.chatFillSnapshot(wait.jobId);
    if (snapshot?.state !== 'done' || !snapshot.result) return null;
    const parked = get(openParkedRunAtom)?.deferrals.some(
        (deferral) => deferral.tool_call_id === wait.toolCallId && isJobDeferral(deferral),
    );
    const agent = Zotero.Beaver?.tableFills?.agent;
    if (!parked || !agent) return null;
    return { toolCallId: wait.toolCallId, answer: agent.doneAnswer(snapshot, `resume-${wait.toolCallId}`) };
}

const JOB_RESUME_RETRIES = 4;

/**
 * A fill resume that did not start: the server may still hold the chat for
 * the run that just parked. Try again shortly, a few times; then the window
 * stops waiting, and the next message closes the fill's call instead.
 */
function retryJobResume(session: RunSession, set: Setter): void {
    if (session.jobResumeRetries >= JOB_RESUME_RETRIES) {
        session.jobResumeRetries = 0;
        set(jobWaitAtom, null);
        return;
    }
    setTimeout(() => scheduleParkedAnswerFlush(session), 1000 * 2 ** session.jobResumeRetries++);
}

/**
 * The fill this window waits on may have ended: resume its parked run with
 * the result, at once or once the run still landing has ended.
 */
export function requestJobResume(session: RunSession = getRunSession()): void {
    scheduleParkedAnswerFlush(session);
}

/**
 * Whether a run of this window is going or still landing, so a resume has to
 * wait for it: `onDone` sends what was queued meanwhile.
 */
function parkedResumeBlocked(session: RunSession, get: Getter): boolean {
    const activeRun = get(activeRunAtom);
    return session.parkedResumeStarting
        || get(isWSChatPendingAtom)
        || isRunActive(activeRun)
        || isRunFinished(activeRun)
        || !!get(retryPendingRunIdAtom)
        || get(isRunReconnectingAtom);
}

/**
 * Send the answers queued for the open parked run in one resume. Answers to
 * cards that are no longer open (answered elsewhere, superseded) are dropped.
 */
export const flushParkedAnswersAtom = sessionAction('flushParkedAnswers',async (get, set) => {
    const session = sessionOf(get);
    const queue = get(parkedAnswerQueueAtom);
    const job = jobResumeAnswer(session, get);
    if ((queue.size === 0 && !job) || parkedResumeBlocked(session, get)) return;
    const threadId = get(currentThreadIdAtom);
    const open = get(openParkedRunAtom);
    const answers: Record<string, ParkedCardAnswer> = {};
    for (const [toolcallId, queued] of queue) {
        if (open && queued.threadId === threadId && open.toolCallIds.has(toolcallId)) {
            answers[toolcallId] = queued.answer;
        }
    }
    const jobCallId = job?.toolCallId ?? null;
    if (job) answers[job.toolCallId] = job.answer;
    set(parkedAnswerQueueAtom, new Map());
    if (!open || Object.keys(answers).length === 0) {
        set(syncParkedCardsAtom);
        return;
    }

    session.parkedResumeStarting = true;
    let started = false;
    try {
        started = (await withThreadWriter(set, guardedSet =>
            startParkedResumeOwned(session, get, guardedSet, open, answers, jobCallId), session)) ?? false;
    } finally {
        session.parkedResumeStarting = false;
        if (!started) {
            // Nothing was sent: the cards are still open, and answerable again.
            set(parkedAnswersInFlightAtom, new Set<string>());
            set(syncParkedCardsAtom);
            if (jobCallId) retryJobResume(session, set);
        } else {
            session.jobResumeRetries = 0;
        }
        if (get(parkedAnswerQueueAtom).size > 0) scheduleParkedAnswerFlush(session);
    }
});

/**
 * Start the run that resumes a parked run with the user's answers. Returns
 * whether the run was started.
 *
 * Like a continuation it carries no message: `deferred_results` names the
 * cards it answers and `resumes_run_id` the run it continues. The cards still
 * open stay on screen and answerable while it runs. `jobCallId` names a
 * fill's call the answers include: the window's wait on it ends here.
 */
async function startParkedResumeOwned(
    session: RunSession,
    get: Getter,
    set: Setter,
    open: OpenParkedRun,
    answers: Record<string, ParkedCardAnswer>,
    jobCallId: string | null = null,
): Promise<boolean> {
    const logPrefix = 'resumeParkedRun';
    // A fill's wait the user ended (Stop, leaving) while the resume was being admitted.
    if (jobCallId && get(jobWaitAtom)?.toolCallId !== jobCallId) {
        const { [jobCallId]: _ended, ...rest } = answers;
        if (!Object.keys(rest).length) return false;
        answers = rest;
        jobCallId = null;
    }
    if (retryCommitInFlight(get, logPrefix)) return false;
    if (get(isRunReconnectingAtom)) {
        logger(`${logPrefix}: Blocked — the active run is reconnecting`, 1);
        return false;
    }
    const model = session.host.getModel();
    const userId = session.host.getUserId();
    const threadId = get(currentThreadIdAtom) || open.threadId;
    if (!model || !userId || !threadId) {
        logger(`${logPrefix}: No model, user or thread`, 1);
        return false;
    }
    logger(`${logPrefix}: Resuming parked run ${open.runId} with ${Object.keys(answers).length} answer(s)${jobCallId ? ', one a fill result' : ''}`, 1);

    let newRunId: string | null = null;
    try {
        // A failed earlier resume stays in history, as on the server.
        archiveTerminalActiveRun(get, set);
        set(parkedAnswersInFlightAtom, new Set(Object.keys(answers)));
        set(prepareForNewRunAtom, { keepParkedCards: true });
        prewarmMuPDFWorker();
        set(isWSChatPendingAtom, true);
        // The window no longer waits on the fill: the resume carries it on.
        if (jobCallId) set(jobWaitAtom, null);

        const { run, request } = createAgentRunShell(
            { content: '', deferred_results: answers, resumes_run_id: open.runId },
            threadId,
            userId,
            model.name,
            buildModelSelectionOptions(model),
            model.provider,
            undefined,
            model.is_custom ? model.custom_model : undefined,
        );
        newRunId = run.id;
        set(activeRunAtom, run);
        await executeWSRequest(session, run, request, get, set);
        return true;
    } catch (error) {
        logger(`${logPrefix}: Unexpected error:`, error, 1);
        set(wsErrorAtom, {
            event: 'error',
            type: 'resume_error',
            message: error instanceof Error ? error.message : 'Failed to send the answer',
            is_retryable: true,
        });
        set(activeRunAtom, prev => (newRunId && prev?.id === newRunId ? null : prev));
        set(isWSChatPendingAtom, false);
        return false;
    }
}

/**
 * The open chat's run, when leaving it can park it rather than stop it: it is
 * waiting on cards the user can answer later (an approval, a question, a batch
 * or a table card), on nothing that must be answered live (a credit
 * confirmation), and no answer the user gave is still on its way. The server
 * has the last word: it refuses the park when the run also waits on something
 * else, and the run is then stopped as before.
 */
export function parkableRunId(get: Getter, session: RunSession = getRunSession()): string | null {
    const activeRun = get(activeRunAtom);
    if (!activeRun || !isRunActive(activeRun) || !session.agentService.isConnected()) return null;
    // A resume parks only while it waits for the cards it shows again: until
    // then the cards on screen are the parked run's, not cards it waits on,
    // and the answers it carries may be applying.
    if (activeRun.user_prompt?.deferred_results && !get(isResumeWaitingAtom)) return null;
    if (get(isRunReconnectingAtom) || get(pendingCreditConfirmationsAtom).size > 0) return null;
    if (get(liveCardAnswersAtom).size > 0) return null;
    const hasCard = get(pendingApprovalsAtom).size > 0
        || get(pendingQuestionsAtom).size > 0
        || get(pendingBatchApprovalsAtom).size > 0
        || get(pendingTableCardsAtom).size > 0;
    return hasCard ? activeRun.id : null;
}

/** How long a message waits for the resume it replaces to park. */
const PARK_FOR_MESSAGE_WAIT_MS = 5000;


/**
 * Whether a message sent now must first park the running resume: it carries
 * some of a parked run's answers and waits for the rest of the cards.
 */
export function messageParksResume(get: Getter): boolean {
    const activeRun = get(activeRunAtom);
    return isRunActive(activeRun) && !!activeRun?.user_prompt?.deferred_results && get(isThreadParkedAtom);
}

/**
 * Before a message is sent while a resume waits for the cards it shows
 * again, park the resume: the message then closes the cards still open, as
 * any message written past a parked run does. Returns whether the message
 * may be sent.
 */
export const parkResumeForMessageAtom = sessionAction('parkResumeForMessage',async (get, set): Promise<boolean> => {
    const session = sessionOf(get);
    if (!messageParksResume(get)) return true;
    if (session.parkingResumeForMessage) return false;
    const runId = parkableRunId(get, session);
    if (!runId) {
        session.host.notify(set, {
            type: 'info',
            title: 'Applying your answer',
            text: 'Send your message again once Beaver has applied it.',
            expire: true,
        });
        return false;
    }
    session.parkingResumeForMessage = true;
    const navigation = session.host.navigationSeq();
    try {
        const outcome = await session.agentService.parkRun(runId, PARK_FOR_MESSAGE_WAIT_MS);
        // The message was written for the chat the user has since left.
        if (navigation !== session.host.navigationSeq()) return false;
        if (outcome === 'ended') return true;
        // The run ended without telling this client how, or was stopped:
        // show the chat as the server has it.
        logger(`parkResumeForMessage: Parking run ${runId} ended as "${outcome}"; reloading the chat`, 1);
        const threadId = get(currentThreadIdAtom);
        const userId = session.host.getUserId();
        if (threadId && userId) void Promise.resolve().then(() => session.host.reloadThread(threadId, userId));
        session.host.notify(set, {
            type: 'warning',
            title: 'Message not sent',
            text: 'Send it again once the chat has reloaded.',
            expire: true,
        });
        return false;
    } finally {
        session.parkingResumeForMessage = false;
    }
});

async function startContinuationRun(session: RunSession, get: Getter, set: Setter, failedRunId: string, options: StartContinuationRunOptions): Promise<void> {
    return withThreadWriter(set, guardedSet => startContinuationRunOwned(session, get, guardedSet, failedRunId, options), session);
}

async function startAutoRetryRun(session: RunSession, get: Getter, set: Setter, failedRunId: string): Promise<void> {
    return withThreadWriter(set, guardedSet => startAutoRetryRunOwned(session, get, guardedSet, failedRunId), session);
}

async function startRegenerateRun(session: RunSession, get: Getter, set: Setter, runId: string, options: RegenerateRunOptions): Promise<void> {
    return withThreadWriter(set, guardedSet => startRegenerateRunOwned(session, get, guardedSet, runId, options), session);
}

function settleWriter(session: RunSession, get: Getter, writer: WriterLease | undefined): void {
    if (!writer || writer !== currentWriter(session) || writer.preparing || get(isWSChatPendingAtom) || isRunActive(get(activeRunAtom))
        || get(retryPendingRunIdAtom) || get(autoReplacementPendingRunIdsAtom).size) return;
    releaseWriter(session, writer);
    const id = get(currentThreadIdAtom);
    if (id) session.store.set(viewedHistoryRevisionAtom, Zotero.Beaver.presence.getSnapshot().history[id] ?? 0);
}
/**
 * Admit before preparation; nested composer/run phases retain the same lease.
 *
 * `operation` receives `set` and the session's store setter, both guarded by
 * the lease: window code prepares with the first and writes the chat's state
 * with the second.
 */
export async function withThreadWriter<T>(
    set: Setter,
    operation: (set: Setter, sessionSet: Setter) => Promise<T>,
    session: RunSession = getRunSession(),
): Promise<T | undefined> {
    const get = session.store.get;
    const id = get(currentThreadIdAtom);
    const presence = Zotero.Beaver?.presence;
    if (
        get(threadConflictAtom) ||
        (get(serverThreadBlockedAtom) && !ownsWriter(session, currentWriter(session)))
    )
        return;
    if (presence && id) {
        const snapshot = presence.getSnapshot();
        const owner = snapshot.claims.find(claim => claim.threadId === id);
        if (owner && owner.windowId !== session.host.windowId()) {
            session.host.notify(set, { type: 'info', title: 'Responding in another window', text: 'Wait for that response to finish or go to its window.', expire: true });
            return;
        }
        if (snapshot.deleted.includes(id) || (!ownsWriter(session, currentWriter(session)) && (snapshot.history[id] ?? 0) !== get(viewedHistoryRevisionAtom))) {
            session.host.notify(set, { type: 'warning', title: 'This chat was updated in another window', text: 'Refresh the chat before continuing. Your draft and attachments are preserved.', expire: false });
            return;
        }
    }
    const writer = acquireWriter(session, id, getCredentialGeneration());
    if (writer === null) {
        session.host.notify(set, { type: 'info', title: 'Responding in another window', text: 'Wait for that response to finish or go to its window.', expire: true });
        return;
    }
    if (writer) writer.preparing++;
    const nav = session.host.navigationSeq();
    const guard = (target: Setter): Setter => ((...args: any[]) => {
        assertWriter(session, writer);
        if (writer && nav !== session.host.navigationSeq()) throw Object.assign(new Error('Chat changed'), { code: 'thread_operation_canceled' });
        return (target as any)(...args);
    }) as Setter;
    const guardedSet = guard(set);
    const guardedSessionSet = guard(session.store.set);
    try {
        if (writer?.admission) {
            // A second submission while the first is still reading admission
            // (a repeated click or Enter) must not fall back to the cached
            // tail: after a stopped or failed run that tail is stale.
            if (!(await writer.admission.catch(() => false))) return;
        } else if (
            presence &&
            id &&
            writer?.preparing === 1 &&
            (!get(activeRunAtom) || (!isRunActive(get(activeRunAtom)) &&
                !!get(threadAdmissionAtom)?.unconfirmedRunId)) &&
            !get(retryPendingRunIdAtom)
        ) {
            const admission = (async () => {
                const generation = getCredentialGeneration();
                const snapshot = await readAdmission(id);
                assertCredentialGeneration(generation);
                assertWriter(session, writer);
                if (nav !== session.host.navigationSeq()) return false;
                const previous = get(threadAdmissionAtom);
                guardedSessionSet(threadAdmissionAtom, snapshot);
                if (
                    snapshot.activity.state === "active" ||
                    (previous?.threadId === id &&
                        previous.tailRunId !== snapshot.tailRunId &&
                        previous.unconfirmedRunId !== snapshot.tailRunId)
                ) {
                    if (snapshot.activity.state !== "active")
                        guardedSessionSet(threadConflictAtom, "thread_tail_mismatch");
                    return false;
                }
                return true;
            })();
            writer.admission = admission;
            try {
                if (!(await admission)) return;
            } finally {
                if (writer.admission === admission) writer.admission = undefined;
            }
        }
        return await operation(guardedSet, guardedSessionSet);
    } catch (error) {
        if ((error as { code?: string })?.code !== 'thread_operation_canceled') {
            if (ownsWriter(session, writer) && nav === session.host.navigationSeq())
                session.host.notify(set, {
                    type: "error",
                    title: "Chat could not be checked",
                    // The operation may be a window's, whose errors are not
                    // this realm's `Error`.
                    text: (error as { message?: string } | null)?.message ?? String(error),
                    expire: false,
                });
        }
    } finally {
        if (writer) writer.preparing--;
        settleWriter(session, get, writer);
    }
}
