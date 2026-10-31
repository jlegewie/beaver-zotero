import { undoMergeItemsAction } from '../../utils/mergeItemsActions';
import { mergeItemsChoicesAtom } from '../../atoms/mergeItemsChoices';
/**
 * Dev-only HTTP handlers for driving the chat/run lifecycle headlessly.
 *
 * The chat input is a Lexical contenteditable that cannot be reliably driven by
 * synthetic events, so there is no robust UI path for an automated agent to send
 * a message. These handlers instead trigger the *real* send/approval/undo path by
 * writing the same Jotai action atoms the UI writes — nothing is mocked. A send
 * runs the full WebSocket pipeline against the real backend and model (and bills
 * real credits), exactly as if a user had typed the message.
 *
 * Endpoints (wired in `useHttpEndpoints.ts` → `registerEndpoints()`):
 *
 *   /beaver/test/new-thread     start a fresh thread (no confirm modal)
 *   /beaver/test/chat-send      stage attachments + send a message (+ optional pills),
 *                               optionally wait until the run settles
 *   /beaver/test/current-ids    read thread id / active run id / pending state
 *   /beaver/test/load-thread    reopen an existing thread by id (for history re-validation)
 *   /beaver/test/list-actions   enumerate pending approvals + applied/rejected actions
 *   /beaver/test/approve-action approve or reject a pending write approval
 *   /beaver/test/confirm-credits continue or skip a pending credit confirmation
 *   /beaver/test/table-card     answer a pending table card (create, with edits, or decline)
 *   /beaver/test/undo-action    undo an applied action
 *   /beaver/test/chat-drop-connection  lose the chat socket mid-run, to exercise run reattach
 *   /beaver/test/run-snapshot   the open chat's runs and the transport's reattach events
 *   /beaver/test/chat-stop      press Stop on the running response
 *   /beaver/test/chat-continue  press Continue on a run that ended unfinished
 *
 * All are gated behind the same authenticated-only registration as the rest of
 * the dev endpoints, and only registered in development builds.
 */

import { store } from '../../store';
import { pendingTableCardsAtom, tableCardDraftsAtom } from '@beaver/agent-core/run-state/pendingTableCards';
import {
    addColumn,
    addItems,
    addLibrarySource,
    draftOptions,
    draftCost,
    initialTableCardDraft,
    removeItem,
    removeSource,
    setSourceResolved,
    tableCardDecline,
    tableCardResponse,
    tableFillCardResponse,
    updateColumn,
    type TableCardDraft,
} from '@beaver/agent-core/run-state/tableCardDraft';
import { isCreateCard, isFillCard, type TableCardChoice } from '@beaver/agent-core/protocol/tableCardProtocol';
import { chatFillsAtom, dismissChatFillAtom, panelFill } from '@beaver/agent-core/run-state/tableChatFills';
import { resolveItems as resolveCardItems, resolveLibraryScope } from '../../components/tables/card/liveSources';
import { sendComposedMessageAtom } from '../../atoms/actions';
import {
    newThreadAtom,
    loadThreadAtom,
    currentThreadIdAtom,
    currentThreadNameAtom,
} from '../../atoms/threads';
import { activeRunAtom, threadRunsAtom, wsReconnectingAtom } from '@beaver/agent-core/run-state/atoms';
import {
    reattachResolutionAtom,
    reattachResolutionView,
    runReplacementNotesAtom,
} from '@beaver/agent-core/run-state/runResolution';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { logger } from '@beaver/agent-core/platform/logger';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { flushPendingPartEvents } from '../../utils/streamingPartQueue';
import { admissionUnreachableAtom, threadAdmissionAtom } from '../../runtime/threadAdmission';
import {
    closeWSConnectionAtom,
    isWSChatPendingAtom,
    resumeFromRunAtom,
    sendApprovalResponseAtom,
    sendCreditConfirmationResponseAtom,
    sendTableCardResponseAtom,
    stoppingPreviousRunAtom,
} from '../../atoms/agentRunAtoms';
import {
    pendingCreditConfirmationsAtom,
    type PendingCreditConfirmation,
} from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import {
    pendingApprovalsAtom,
    removePendingApprovalAtom,
    threadAgentActionsAtom,
    undoAgentActionAtom,
    type AgentAction,
} from '../../agents/agentActions';
import type { PendingApproval } from '@beaver/agent-ui/host';
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import {
    currentMessageItemsAtom,
    currentMessageCollectionsAtom,
    currentMessageViewsAtom,
} from '../../atoms/messageComposition';
import { userIdAtom, isAuthenticatedAtom } from '../../atoms/auth';
import { type CollectionReference } from '@beaver/agent-core/types/zotero';
import { collectionToReference, viewToAttachment } from '../../utils/zoteroReferences';
import type { ViewAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import { resolveItemReference } from '../../../src/utils/libraryIdentity';
import { undoEditMetadataAction } from '../../utils/editMetadataActions';
import { undoCreateCollectionAction } from '../../utils/createCollectionActions';
import { undoOrganizeItemsAction } from '../../utils/organizeItemsActions';
import { undoManageTagsAction } from '../../utils/manageTagsActions';
import { undoManageCollectionsAction } from '../../utils/manageCollectionsActions';
import { undoCreateNoteAction } from '../../utils/createNoteActions';
import { undoEditNoteAction, undoEditNoteBatchAction } from '../../utils/editNoteActions';
import { undoCreateAnnotationsAction } from '../../utils/createAnnotationsActions';
import { undoCreateItemActions } from '../../utils/createItemActions';
import { undoImportItemActions } from '../../utils/importItemActions';
import { undoEditAnnotationsAction } from '../../utils/editAnnotationsActions';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** setTimeout via the main window (globals aren't guaranteed in this context). */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const win = Zotero.getMainWindow();
        (win?.setTimeout ?? setTimeout)(resolve, ms);
    });
}

/** Typed accessors — jotai's `store.get` widens these atoms' element types. */
function pendingApprovalList(): PendingApproval[] {
    const map: Map<string, PendingApproval> = store.get(pendingApprovalsAtom);
    return Array.from(map.values());
}
function threadActions(): AgentAction[] {
    return store.get(threadAgentActionsAtom) as AgentAction[];
}

/** Serialize a pending approval for the wire (no live Zotero objects). */
function serializeApproval(a: PendingApproval) {
    return {
        actionId: a.actionId,
        toolcallId: a.toolcallId,
        actionType: a.actionType,
    };
}

/** Snapshot of thread/run/approval identity — the return shape of /current-ids. */
function currentIds() {
    // See getJotaiState: apply the frame-queued parts so the snapshot matches
    // what has actually streamed in.
    flushPendingPartEvents();
    const activeRun = store.get(activeRunAtom);
    const runs = store.get(threadRunsAtom);
    const approvals: Map<string, PendingApproval> = store.get(pendingApprovalsAtom);
    const questions: Map<string, unknown> = store.get(pendingQuestionsAtom);
    const creditConfirmations: Map<string, PendingCreditConfirmation> =
        store.get(pendingCreditConfirmationsAtom);
    return {
        threadId: store.get(currentThreadIdAtom),
        threadName: store.get(currentThreadNameAtom),
        activeRunId: activeRun?.id ?? null,
        activeRunStatus: activeRun?.status ?? null,
        activeRunError: activeRun?.error
            ? {
                type: activeRun.error.type,
                isRetryable: activeRun.error.is_retryable ?? null,
                isResumable: activeRun.error.is_resumable ?? null,
            }
            : null,
        isPending: store.get(isWSChatPendingAtom),
        isReconnecting: store.get(wsReconnectingAtom) !== null,
        reconnect: store.get(wsReconnectingAtom),
        // A failed reattach being resolved, what the active run's card shows
        // for it instead of the error (null: the error, if any), and notes on
        // runs the server replaced.
        reattachResolution: store.get(reattachResolutionAtom),
        resolutionView: (() => {
            const snapshot = store.get(threadAdmissionAtom);
            const threadId = store.get(currentThreadIdAtom);
            const forThisChat = snapshot && snapshot.threadId === threadId ? snapshot : null;
            return activeRun
                ? reattachResolutionView({
                    resolution: store.get(reattachResolutionAtom),
                    runId: activeRun.id,
                    currentThreadId: threadId,
                    activityState: forThisChat?.activity.state ?? null,
                    activityRunId: forThisChat?.activity.run_id ?? null,
                    unreachable: store.get(admissionUnreachableAtom),
                    now: Date.now(),
                })
                : null;
        })(),
        replacementNotes: Object.fromEntries(store.get(runReplacementNotesAtom)),
        // What the presence bar is showing for the open chat.
        admission: (() => {
            const snapshot = store.get(threadAdmissionAtom);
            return snapshot
                ? {
                    threadId: snapshot.threadId,
                    state: snapshot.activity.state,
                    reason: snapshot.reason ?? null,
                    unreachable: store.get(admissionUnreachableAtom),
                }
                : null;
        })(),
        stoppingPreviousRun: store.get(stoppingPreviousRunAtom),
        transport: {
            connected: agentService.isConnected(),
            run: agentService.runLinkState(),
        },
        runCount: runs.length,
        lastRunId: runs.length ? runs[runs.length - 1].id : null,
        pendingApprovals: Array.from(approvals.values()).map(serializeApproval),
        pendingQuestionIds: Array.from(questions.keys()),
        pendingTableCards: Array.from(store.get(pendingTableCardsAtom).values()),
        pendingCreditConfirmations: Array.from(creditConfirmations.values()).map((c) => ({
            confirmationId: c.confirmationId,
            title: c.title,
            message: c.message,
            footer: c.footer,
            pendingCredits: c.pendingCredits,
            projectedTotalCredits: c.projectedTotalCredits,
        })),
    };
}

type SettleReason = 'done' | 'approval' | 'question' | 'credit-confirmation' | 'table-card' | 'timeout';

/**
 * Poll until the run settles: it finished streaming (`done`), paused for a write
 * approval (`approval`), paused for an ask_user_question (`question`), paused for
 * a run-level credit confirmation (`credit-confirmation`), or the timeout
 * elapsed. A paused run keeps `isWSChatPendingAtom` true, so we must break on
 * every blocking state or we would block until timeout.
 */
async function waitForRunSettle(timeoutMs: number, pollMs = 300): Promise<SettleReason> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (store.get(pendingApprovalsAtom).size > 0) return 'approval';
        if (store.get(pendingQuestionsAtom).size > 0) return 'question';
        if (store.get(pendingCreditConfirmationsAtom).size > 0) return 'credit-confirmation';
        if (store.get(pendingTableCardsAtom).size > 0) return 'table-card';
        if (!store.get(isWSChatPendingAtom)) return 'done';
        await sleep(pollMs);
    }
    return 'timeout';
}

/** Resolve `{library_id?, library_ref?, zotero_key}` refs to live Zotero items. */
async function resolveItems(
    refs: Array<{ library_id?: number; library_ref?: string; zotero_key: string }>,
): Promise<{ items: Zotero.Item[]; unresolved: any[] }> {
    const items: Zotero.Item[] = [];
    const unresolved: any[] = [];
    for (const ref of refs) {
        const result = await resolveItemReference({
            library_ref: ref.library_ref,
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
        });
        if (result.status === 'found') items.push(result.item);
        else unresolved.push({ ...ref, status: result.status });
    }
    return { items, unresolved };
}

/** Resolve `{library_id, collection_key}` refs to CollectionReferences. */
function resolveCollections(
    refs: Array<{ library_id: number; collection_key: string }>,
): { collections: CollectionReference[]; unresolved: any[] } {
    const collections: CollectionReference[] = [];
    const unresolved: any[] = [];
    for (const ref of refs) {
        const collection = Zotero.Collections?.getByLibraryAndKey?.(ref.library_id, ref.collection_key);
        if (collection) collections.push(collectionToReference(collection as Zotero.Collection));
        else unresolved.push({ ...ref, status: 'not_found' });
    }
    return { collections, unresolved };
}

/**
 * Resolve `{library_id, type, key?, name?}` refs to view attachments. `type` is
 * a collections-tree row type: 'search' (with the search `key`), 'unfiled',
 * 'publications' or 'retracted'.
 */
function resolveViews(
    refs: Array<{ library_id: number; type: string; key?: string; name?: string }>,
): { views: ViewAttachment[]; unresolved: any[] } {
    const views: ViewAttachment[] = [];
    const unresolved: any[] = [];
    for (const ref of refs) {
        const view = viewToAttachment({
            type: ref.type,
            libraryId: ref.library_id,
            key: ref.key,
            name: ref.name ?? ref.type,
        });
        if (view) views.push(view);
        else unresolved.push({ ...ref, status: 'not_found' });
    }
    return { views, unresolved };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Start a fresh thread. Passes `skipActiveRunConfirm`/`skipAutoPopulate` so it
 * never pops a `Zotero.Prompt.confirm` modal or auto-attaches the current Zotero
 * selection — a headless new thread is genuinely empty.
 */
export async function handleTestNewThreadHttpRequest(request: any) {
    await store.set(newThreadAtom, {
        skipActiveRunConfirm: true,
        skipAutoPopulate: request?.autoPopulate === true ? false : true,
    });
    return { ok: true, ...currentIds() };
}

/**
 * Stage optional attachments and send a message through the real WS pipeline.
 *
 * Body:
 *   text            required message text
 *   items           optional [{library_id|library_ref, zotero_key}] to attach
 *   collections     optional [{library_id, collection_key}] to attach
 *   views           optional [{library_id, type, key?, name?}] saved searches
 *                   ('search' + key) or built-in views ('unfiled', …) to attach
 *   pills           optional SlashCommandDescriptor[] (slash-command tokens)
 *   newThread       if true, start a fresh thread before sending
 *   waitForDone     default true — poll until the run settles
 *   timeoutMs       wait budget (default 180000)
 *
 * When `waitForDone` and the run pauses for an approval/question, the response's
 * `settle` is `"approval"`/`"question"` and `pendingApprovals` is populated —
 * call /approve-action, then poll /current-ids (or re-approve) to continue.
 */
export async function handleTestChatSendHttpRequest(request: any) {
    if (!store.get(isAuthenticatedAtom)) {
        return { ok: false, error: 'Not authenticated; chat endpoints require a logged-in plugin' };
    }
    const text = request?.text;
    if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: 'text (non-empty string) is required' };
    }

    if (request?.newThread === true) {
        await store.set(newThreadAtom, { skipActiveRunConfirm: true, skipAutoPopulate: true });
    } else {
        // Continue a specific existing thread: load it first if it isn't already the
        // current one. Without this, the send targets whatever thread happens to be
        // current in the store (e.g. the last one reopened via load-thread), NOT the
        // requested `threadId`.
        const threadId = request?.threadId ?? request?.thread_id;
        if (typeof threadId === 'string' && threadId && store.get(currentThreadIdAtom) !== threadId) {
            const userId = request?.user_id ?? store.get(userIdAtom);
            if (!userId) {
                return { ok: false, error: 'No user_id to load requested threadId (not logged in?)' };
            }
            await store.set(loadThreadAtom, { user_id: userId, threadId, skipInstanceMismatchConfirm: true });
        }
    }

    if (store.get(isWSChatPendingAtom)) {
        return { ok: false, error: 'A run is already in progress; wait for it to settle', ...currentIds() };
    }

    // Stage attachments directly (deterministic — bypasses the background
    // validation the UI runs; the send path still drops excluded-library items).
    let unresolvedItems: any[] = [];
    let unresolvedCollections: any[] = [];
    let unresolvedViews: any[] = [];
    if (Array.isArray(request?.items) && request.items.length > 0) {
        const { items, unresolved } = await resolveItems(request.items);
        unresolvedItems = unresolved;
        store.set(currentMessageItemsAtom, items);
    }
    if (Array.isArray(request?.collections) && request.collections.length > 0) {
        const { collections, unresolved } = resolveCollections(request.collections);
        unresolvedCollections = unresolved;
        store.set(currentMessageCollectionsAtom, collections);
    }
    if (Array.isArray(request?.views) && request.views.length > 0) {
        const { views, unresolved } = resolveViews(request.views);
        unresolvedViews = unresolved;
        store.set(currentMessageViewsAtom, views);
    }

    const sent = await store.set(sendComposedMessageAtom, {
        baseText: text,
        pills: Array.isArray(request?.pills) ? request.pills : [],
    });

    if (!sent) {
        return {
            ok: false,
            error: 'Send was aborted (e.g. a staged item was rejected)',
            unresolvedItems,
            unresolvedCollections,
            unresolvedViews,
            ...currentIds(),
        };
    }

    let settle: SettleReason | null = null;
    if (request?.waitForDone !== false) {
        settle = await waitForRunSettle(
            typeof request?.timeoutMs === 'number' ? request.timeoutMs : 180000,
        );
    }

    return { ok: true, sent, settle, unresolvedItems, unresolvedCollections, unresolvedViews, ...currentIds() };
}

/** Press Stop on the open chat's run, as the composer's Stop button does. */
export async function handleTestChatStopHttpRequest(_request: any) {
    await store.set(closeWSConnectionAtom);
    return { ok: true, ...currentIds() };
}

/**
 * Continue a run that ended unfinished, as its Continue button does.
 *
 * Body: { runId? (default: the chat's last run), waitForDone?, timeoutMs? }
 */
export async function handleTestChatContinueHttpRequest(request: any) {
    const runs = store.get(threadRunsAtom);
    const runId = request?.runId ?? runs.at(-1)?.id;
    if (!runId) return { ok: false, error: 'No run to continue', ...currentIds() };
    await store.set(resumeFromRunAtom, runId);
    let settle: SettleReason | null = null;
    if (request?.waitForDone !== false) {
        await sleep(400);
        settle = await waitForRunSettle(
            typeof request?.timeoutMs === 'number' ? request.timeoutMs : 180000,
        );
    }
    return { ok: true, continued: runId, settle, ...currentIds() };
}

/** Read the current thread/run/approval identity. Poll this to detect completion. */
export async function handleTestCurrentIdsHttpRequest(_request: any) {
    return { ok: true, ...currentIds() };
}

/**
 * Reopen an existing thread by id (the "history re-validation" path). This is the
 * flow N8 exercises: after loading, applied actions must NOT flip to `undone`
 * merely from being viewed. `user_id` defaults to the logged-in Beaver user.
 */
export async function handleTestLoadThreadHttpRequest(request: any) {
    const threadId = request?.threadId ?? request?.thread_id;
    if (typeof threadId !== 'string' || !threadId) {
        return { ok: false, error: 'threadId is required' };
    }
    const userId = request?.user_id ?? store.get(userIdAtom);
    if (!userId) {
        return { ok: false, error: 'No user_id (not logged in?)' };
    }
    const loaded = await store.set(loadThreadAtom, {
        user_id: userId,
        threadId,
        threadName: request?.threadName,
        // Never hang headless drivers on the native other-instance confirm.
        skipInstanceMismatchConfirm: true,
    });
    return {
        ok: true,
        loaded,
        ...currentIds(),
        actions: threadActions().map((a) => ({
            id: a.id,
            action_type: a.action_type,
            status: a.status,
        })),
    };
}

/** Enumerate pending approvals and the thread's applied/rejected/undone actions. */
export async function handleTestListActionsHttpRequest(_request: any) {
    return {
        ok: true,
        pendingApprovals: pendingApprovalList().map(serializeApproval),
        actions: threadActions().map((a) => ({
            id: a.id,
            action_type: a.action_type,
            status: a.status,
            error_message: a.error_message ?? null,
        })),
    };
}

/**
 * Approve or reject a pending write approval, unblocking the deferred tool.
 *
 * Body: { actionId?, approved (default true), all?, userInstructions?, waitForDone?, timeoutMs? }
 * With `all:true` (and no `actionId`) every currently-pending approval gets the
 * same verdict. When `waitForDone`, polls until the resumed run settles again.
 */
export async function handleTestApproveActionHttpRequest(request: any) {
    const approved = request?.approved !== false; // default true
    const pending: Map<string, PendingApproval> = store.get(pendingApprovalsAtom);

    let targetIds: string[];
    if (request?.all === true && !request?.actionId) {
        targetIds = Array.from(pending.keys());
    } else if (request?.actionId) {
        targetIds = [request.actionId];
    } else {
        // Default: the single pending approval, if unambiguous.
        if (pending.size === 0) return { ok: false, error: 'No pending approvals', ...currentIds() };
        if (pending.size > 1) {
            return {
                ok: false,
                error: 'Multiple pending approvals; pass actionId or all:true',
                pendingApprovals: Array.from(pending.values()).map(serializeApproval),
            };
        }
        targetIds = [Array.from(pending.keys())[0]];
    }

    for (const actionId of targetIds) {
        if (request?.actionChanges) store.set(mergeItemsChoicesAtom, { ...store.get(mergeItemsChoicesAtom), [actionId]: request.actionChanges });
        store.set(sendApprovalResponseAtom, {
            actionId,
            approved,
            userInstructions: request?.userInstructions ?? null,
        });
        // As the card's buttons do once they send the answer.
        store.set(removePendingApprovalAtom, actionId);
    }

    let settle: SettleReason | null = null;
    if (request?.waitForDone === true) {
        // Give the WS a moment to resume before polling settle state.
        await sleep(400);
        settle = await waitForRunSettle(
            typeof request?.timeoutMs === 'number' ? request.timeoutMs : 180000,
        );
    }

    return { ok: true, approved, actedOn: targetIds, settle, ...currentIds() };
}

/**
 * Answer the run-level credit confirmation so a headless run can continue.
 *
 * Body: { confirmationId?, approved (default true), waitForDone?, timeoutMs? }
 * The run pauses on this the same way it pauses on an approval, so a driver
 * that does not answer it waits out the backend's confirmation timeout and
 * then gets a run that wrapped up without its priced steps.
 */
export async function handleTestConfirmCreditsHttpRequest(request: any) {
    const approved = request?.approved !== false; // default true
    const pending: Map<string, PendingCreditConfirmation> = store.get(
        pendingCreditConfirmationsAtom,
    );

    if (pending.size === 0) {
        return { ok: false, error: 'No pending credit confirmation', ...currentIds() };
    }

    const confirmationId: string = request?.confirmationId ?? Array.from(pending.keys())[0];
    if (!pending.has(confirmationId)) {
        return { ok: false, error: `Unknown confirmationId: ${confirmationId}`, ...currentIds() };
    }

    store.set(sendCreditConfirmationResponseAtom, { confirmationId, approved });

    let settle: SettleReason | null = null;
    if (request?.waitForDone === true) {
        // Give the WS a moment to resume before polling settle state.
        await sleep(400);
        settle = await waitForRunSettle(
            typeof request?.timeoutMs === 'number' ? request.timeoutMs : 180000,
        );
    }

    return { ok: true, approved, actedOn: [confirmationId], settle, ...currentIds() };
}

/**
 * Answer a pending table card so a headless run can continue.
 *
 * Body: { cardId?, action: 'create' | 'decline' (default 'create'),
 *         choice?: 'create' | 'create_and_run' | 'fill', instructions?,
 *         edits?: { title?, description?, removeItemIds?, addItemIds?,
 *                   addScopes?: TableCardLibraryScope[], removeSourceIndexes?: number[],
 *                   columns?: TableCardColumn[] },
 *         costOnly?, waitForDone?, timeoutMs? }
 *
 * The reply is built by the card's own draft functions, so it is the reply the
 * card would send for the same edits. A create card whose edits change its
 * sources resolves the changed sources' counts as the card does and computes
 * the cost the card would show at the user's prices; `costOnly` returns that
 * cost without answering the card. A fill card takes `choice: 'fill'` (its
 * default) or a decline; nothing on it is edited.
 */
export async function handleTestTableCardHttpRequest(request: any) {
    const pending = store.get(pendingTableCardsAtom);
    if (pending.size === 0) return { ok: false, error: 'No pending table card', ...currentIds() };
    const cardId: string = request?.cardId ?? Array.from(pending.keys())[0];
    const card = pending.get(cardId);
    if (!card) return { ok: false, error: `Unknown cardId: ${cardId}`, ...currentIds() };
    const decline = request?.action === 'decline';

    if (isFillCard(card)) {
        let draft = initialTableCardDraft(card);
        if (typeof request?.instructions === 'string') draft = { ...draft, instructions: request.instructions };
        const response = decline ? tableCardDecline(draft, card) : tableFillCardResponse(card);
        store.set(sendTableCardResponseAtom, response);
        return { ok: true, cardId, scope: card.scope, cost: card.cost, response, settle: await settleIfAsked(request), ...currentIds() };
    }
    if (!isCreateCard(card)) return { ok: false, error: `Unsupported card scope: ${card.scope}`, ...currentIds() };

    let draft = store.get(tableCardDraftsAtom).get(cardId) ?? initialTableCardDraft(card);
    const edits = request?.edits ?? {};
    if (typeof edits.title === 'string') draft = { ...draft, title: edits.title };
    if (typeof edits.description === 'string') draft = { ...draft, description: edits.description };
    for (const index of [...(edits.removeSourceIndexes ?? [])].sort((a: number, b: number) => b - a)) {
        const source = draft.sources[index];
        if (source) draft = removeSource(draft, source.key);
    }
    for (const id of edits.removeItemIds ?? []) draft = removeItem(draft, id);
    if (Array.isArray(edits.addItemIds) && edits.addItemIds.length) draft = addItems(draft, edits.addItemIds);
    for (const scope of edits.addScopes ?? []) draft = addLibrarySource(draft, scope).draft;
    if (Array.isArray(edits.columns)) {
        draft = { ...draft, columns: [] };
        for (const column of edits.columns) {
            const added = addColumn(draft);
            draft = updateColumn(added.draft, added.key, {
                header: column.header ?? '',
                type: column.type ?? 'text',
                description: column.description ?? '',
                options: draftOptions(column.options),
            });
        }
    }
    if (typeof request?.instructions === 'string') draft = { ...draft, instructions: request.instructions };

    // Count the sources the edits changed, as the card's live counts do.
    for (const source of draft.sources) {
        if (!source.counting) continue;
        const live = source.type === 'items' ? await resolveCardItems(source.ids ?? []) : await resolveLibraryScope(source.scope!);
        draft = setSourceResolved(draft, source.key, live.resolved, live.rows.map((row) => row.item_id));
    }
    // The run choice is made on the last step, under the card's cost.
    draft = { ...draft, step: 'columns' };
    const drafts = new Map(store.get(tableCardDraftsAtom));
    drafts.set(card.card_id, draft);
    store.set(tableCardDraftsAtom, drafts);
    const prices = await Zotero.Beaver.tableFills?.pricing().catch(() => null) ?? null;
    const cost = draftCost(draft, card, prices);
    if (request?.costOnly === true) return { ok: true, cardId, scope: card.scope, cost, ...currentIds() };

    const choice: TableCardChoice = request?.choice ?? 'create';
    const response = decline ? tableCardDecline(draft, card) : tableCardResponse(draft, card, choice, cost.cost);
    store.set(sendTableCardResponseAtom, response);
    return { ok: true, cardId, scope: card.scope, cost, response, settle: await settleIfAsked(request), ...currentIds() };
}

async function settleIfAsked(request: any): Promise<SettleReason | null> {
    if (request?.waitForDone !== true) return null;
    await sleep(400);
    return waitForRunSettle(typeof request?.timeoutMs === 'number' ? request.timeoutMs : 180000);
}

/**
 * The chat fills this renderer follows, and the one the progress panel shows
 * in the current thread. Body: { dismiss?: jobId } closes a finished fill's
 * result line, as its × does.
 */
export async function handleTestTableFillProgressHttpRequest(request?: any) {
    if (typeof request?.dismiss === 'string') store.set(dismissChatFillAtom, request.dismiss);
    const all = store.get(chatFillsAtom);
    const fills = Array.from(all.values()).map((fill) => ({
        job_id: fill.snapshot.job_id,
        thread_id: fill.threadId,
        tool_call_id: fill.toolCallId,
        run_id: fill.snapshot.origin.run?.run_id ?? null,
        table: fill.snapshot.table,
        state: fill.snapshot.state,
        rows_total: fill.snapshot.rows_total,
        rows_done: fill.snapshot.rows_done,
        rows_failed: fill.snapshot.rows_failed,
        in_flight: fill.snapshot.in_flight,
        credits_charged: fill.snapshot.credits_charged,
        dismissed: fill.dismissed,
        result: fill.snapshot.result ?? null,
    }));
    const shown = panelFill(all, store.get(currentThreadIdAtom));
    return { ok: true, fills, panel: shown ? shown.snapshot.job_id : null, ...currentIds() };
}

/**
 * Undo an applied action. Mirrors the UI undo path (`AgentActionView.handleUndo`
 * / `useEditNoteActions.handleUndo`): first perform the Zotero-side revert via the
 * per-action-type undo helper, THEN flip UI + backend status via
 * `undoAgentActionAtom`. The state atom alone only changes status — it does NOT
 * revert the Zotero change — so dispatching by `action_type` here is required for
 * the revert to actually land in the library.
 */
export async function handleTestUndoActionHttpRequest(request: any) {
    const actionId = request?.actionId;
    if (typeof actionId !== 'string' || !actionId) {
        return { ok: false, error: 'actionId is required' };
    }
    const action = threadActions().find((a) => a.id === actionId);
    if (!action) {
        return { ok: false, error: `action ${actionId} not found in current thread (load the thread first)` };
    }
    let reverted: string | Record<string, unknown> = action.action_type;
    try {
        switch (action.action_type) {
            case 'edit_metadata': {
                const result = await undoEditMetadataAction(action, true); // force-revert manual edits
                reverted = { fieldsReverted: result.fieldsReverted };
                break;
            }
            case 'merge_items':
                await undoMergeItemsAction(action);
                break;
            case 'create_collection':
                await undoCreateCollectionAction(action);
                break;
            case 'organize_items':
                await undoOrganizeItemsAction(action);
                break;
            case 'manage_tags':
                await undoManageTagsAction(action);
                break;
            case 'manage_collections':
                await undoManageCollectionsAction(action);
                break;
            case 'create_note':
                await undoCreateNoteAction(action);
                break;
            case 'edit_note':
                await undoEditNoteAction(action);
                break;
            case 'edit_note_batch':
                await undoEditNoteBatchAction(action);
                break;
            // Both edit_annotations and delete_annotations share this action type.
            case 'edit_annotations':
                await undoEditAnnotationsAction(action);
                break;
            case 'create_highlight_annotations':
            case 'create_note_annotations':
            case 'highlight_annotation':
            case 'note_annotation':
                await undoCreateAnnotationsAction(action);
                break;
            case 'create_item': {
                const batch = await undoCreateItemActions([action]);
                if (batch.failures.length > 0) {
                    return { ok: false, actionId, error: batch.failures[0].error };
                }
                break;
            }
            case 'import_item': {
                const batch = await undoImportItemActions([action]);
                if (batch.failures.length > 0) {
                    return { ok: false, actionId, error: batch.failures[0].error };
                }
                break;
            }
            default:
                return { ok: false, actionId, error: `undo not supported for action_type ${action.action_type}` };
        }
    } catch (error: any) {
        return { ok: false, actionId, error: error?.message || 'undo failed' };
    }
    // Zotero revert succeeded — now flip UI + backend status.
    store.set(undoAgentActionAtom, actionId);
    const updated = threadActions().find((a) => a.id === actionId);
    return {
        ok: true,
        actionId,
        status: updated?.status ?? null,
        reverted,
    };
}

/** A drop armed to happen at a chosen moment of the next backend request. */
let armedDrop: { when: string; restore: () => void } | null = null;

/** Put the transport's data-provider map back and forget an armed drop. */
function disarmDrop(): void {
    const armed = armedDrop;
    armedDrop = null;
    armed?.restore();
}

/**
 * Lose the open socket now. Returns an error message when there is none.
 * `holdMs` keeps reconnect attempts failing for that long, by pointing the
 * transport at a closed local port.
 */
function dropSocketNow(request: any): string | null {
    const service = agentService as any;
    const ws: WebSocket | null = service.ws ?? null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return 'No open chat connection';
    if (request?.badToken && service.run) {
        service.run.token = 'invalid-reattach-token';
    }
    const holdMs = typeof request?.holdMs === 'number' ? request.holdMs : 0;
    if (holdMs > 0) {
        const previous = service.overrideBaseUrl;
        service.overrideBaseUrl = 'http://127.0.0.1:9';
        // This bundle's own timer: the transport belongs to the window that
        // runs this handler, which may not be the main window.
        setTimeout(() => {
            service.overrideBaseUrl = previous;
        }, holdMs);
    }
    if (request?.mode === 'half_open') {
        ws.onmessage = null;
        ws.close = () => {};
    } else {
        const code = typeof request?.code === 'number' ? request.code : 4000;
        ws.close(code, 'Simulated connection loss');
    }
    return null;
}

/**
 * Arm a drop for the next backend request: once the next approved write has
 * been applied but before its result is sent (`after_next_write`), or as soon
 * as the next read request arrives, before it is answered (`during_next_read`).
 */
function armDrop(request: any): void {
    disarmDrop();
    const service = agentService as any;
    const original = service.getDataProvider();
    const when: string = request.when;
    const isWrite = (name: string) => name === 'agent_action_execute';
    const matches = when === 'after_next_write'
        ? isWrite
        : (name: string) => !isWrite(name) && name !== 'agent_action_validate';
    const fire = () => {
        if (armedDrop?.restore !== restore) return;
        disarmDrop();
        const error = dropSocketNow(request);
        logger(`chat-drop-connection: armed drop (${when}) ${error ?? 'fired'}`, 1);
    };
    const wrapped: Record<string, any> = { ...original };
    for (const [name, entry] of Object.entries<any>(original)) {
        if (!matches(name)) continue;
        wrapped[name] = {
            ...entry,
            handle: async (event: any, context: any) => {
                if (when === 'during_next_read') {
                    fire();
                    return entry.handle(event, context);
                }
                const response = await entry.handle(event, context);
                if (response?.success === true) fire();
                return response;
            },
        };
    }
    const restore = () => service.setDataProvider(original);
    service.setDataProvider(wrapped);
    armedDrop = { when, restore };
}

/**
 * Lose the chat socket mid-run the way a network failure would, to exercise run
 * reattach. Test-only: reaches into the transport's live socket.
 *
 * Body:
 *   mode      'close' (default): close the socket with `code` (default 4000,
 *             which client and server both read as a lost connection).
 *             'half_open': stop reading the socket and never close it, as if
 *             the network went silent. The heartbeat notices within ~45 s and
 *             the server only learns of the loss when the new socket takes the
 *             run over.
 *   code      close code for mode 'close'.
 *   badToken  corrupt the reattach token first, so the server refuses the
 *             reattach (`reattach_unavailable: bad_token`).
 *   holdMs    keep every reconnect attempt failing for this long.
 *   when      'now' (default), 'after_next_write' (after the next approved
 *             write is applied, before its result is sent) or
 *             'during_next_read' (when the next read request arrives, before
 *             it is answered). A deferred drop is armed until it fires or
 *             `disarm` is sent.
 *   disarm    cancel an armed drop.
 */
export async function handleTestChatDropConnectionHttpRequest(request: any) {
    const before = agentService.runLinkState();
    if (request?.disarm) {
        const wasArmed = armedDrop !== null;
        disarmDrop();
        return { ok: true, disarmed: wasArmed, run: before };
    }
    const when = request?.when ?? 'now';
    if (when === 'after_next_write' || when === 'during_next_read') {
        armDrop({ ...request, when });
        return { ok: true, armed: when, run: before };
    }
    if (when !== 'now') return { ok: false, error: `Unknown when: ${when}` };
    const error = dropSocketNow(request);
    if (error) return { ok: false, error, run: before };
    return { ok: true, mode: request?.mode === 'half_open' ? 'half_open' : 'close', run: before };
}

/** Text, tool calls and tool returns of a run, for comparing two copies of it. */
function summarizeRun(run: AgentRun) {
    const texts: string[] = [];
    const toolCalls: Array<{ id: string; name: string }> = [];
    const toolReturns: string[] = [];
    for (const message of run.model_messages ?? []) {
        for (const part of (message as any).parts ?? []) {
            if (part.part_kind === 'text') texts.push(part.content ?? '');
            else if (part.part_kind === 'tool-call') toolCalls.push({ id: part.tool_call_id, name: part.tool_name });
            else if (part.part_kind === 'tool-return' || part.part_kind === 'retry-prompt') toolReturns.push(part.tool_call_id);
        }
    }
    return {
        id: run.id,
        status: run.status,
        errorType: run.error?.type ?? null,
        reasonCode: run.error?.reason_code ?? null,
        text: texts.join('\n'),
        toolCalls,
        toolReturns,
    };
}

/**
 * The open chat's runs as this window holds them, with the transport's recent
 * reattach events. Optionally counts the user library's collections named
 * `countCollectionsNamed` and notes containing `countNotesContaining`, to
 * check that a write was applied exactly once.
 */
export async function handleTestRunSnapshotHttpRequest(request: any) {
    flushPendingPartEvents();
    const runs = [...store.get(threadRunsAtom)];
    const active = store.get(activeRunAtom);
    if (active && !runs.some((run) => run.id === active.id)) runs.push(active);
    let collectionCount: number | null = null;
    if (typeof request?.countCollectionsNamed === 'string') {
        const collections = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, true) as Zotero.Collection[];
        collectionCount = collections.filter(
            (collection) => collection.name === request.countCollectionsNamed && !collection.deleted,
        ).length;
    }
    let noteCount: number | null = null;
    if (typeof request?.countNotesContaining === 'string') {
        const search = new Zotero.Search();
        (search as unknown as { libraryID: number }).libraryID = Zotero.Libraries.userLibraryID;
        search.addCondition('itemType', 'is', 'note');
        search.addCondition('note', 'contains', request.countNotesContaining);
        noteCount = (await search.search()).length;
    }
    return {
        ok: true,
        threadId: store.get(currentThreadIdAtom),
        runs: runs.map(summarizeRun),
        runEvents: agentService.recentRunEvents(),
        armedDrop: armedDrop?.when ?? null,
        collectionCount,
        noteCount,
    };
}
