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
 * This is the v0.22-compatible variant: item references are resolved by
 * `(library_id, zotero_key)` only (v0.22 predates the portable `library_ref`).
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
 *   /beaver/test/undo-action    undo an applied action
 */

import { store } from '../../store';
import { sendComposedMessageAtom } from '../../atoms/actions';
import {
    newThreadAtom,
    loadThreadAtom,
    currentThreadIdAtom,
    currentThreadNameAtom,
} from '../../atoms/threads';
import { activeRunAtom, threadRunsAtom } from '../../agents/atoms';
import { isWSChatPendingAtom, sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import {
    pendingApprovalsAtom,
    threadAgentActionsAtom,
    undoAgentActionAtom,
    type PendingApproval,
    type AgentAction,
} from '../../agents/agentActions';
import { pendingQuestionsAtom } from '../../agents/pendingQuestions';
import {
    currentMessageItemsAtom,
    currentMessageCollectionsAtom,
} from '../../atoms/messageComposition';
import { userIdAtom, isAuthenticatedAtom } from '../../atoms/auth';
import { collectionToReference, type CollectionReference } from '../../types/zotero';
import { undoEditMetadataAction } from '../../utils/editMetadataActions';
import { undoCreateCollectionAction } from '../../utils/createCollectionActions';
import { undoOrganizeItemsAction } from '../../utils/organizeItemsActions';
import { undoManageTagsAction } from '../../utils/manageTagsActions';
import { undoManageCollectionsAction } from '../../utils/manageCollectionsActions';
import { undoCreateNoteAction } from '../../utils/createNoteActions';
import { undoEditNoteAction } from '../../utils/editNoteActions';
import { undoCreateAnnotationsAction } from '../../utils/createAnnotationsActions';
import { undoCreateItemActions } from '../../utils/createItemActions';

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

/** Serialize a pending approval for the wire (no live Zotero objects). */
function serializeApproval(a: PendingApproval) {
    return {
        actionId: a.actionId,
        toolcallId: a.toolcallId,
        actionType: a.actionType,
    };
}

/** Typed accessors — jotai's `store.get` widens these atoms' element types. */
function pendingApprovalList(): PendingApproval[] {
    const map: Map<string, PendingApproval> = store.get(pendingApprovalsAtom);
    return Array.from(map.values());
}
function threadActions(): AgentAction[] {
    return store.get(threadAgentActionsAtom) as AgentAction[];
}

/** Snapshot of thread/run/approval identity — the return shape of /current-ids. */
function currentIds() {
    const activeRun = store.get(activeRunAtom);
    const runs = store.get(threadRunsAtom);
    const approvals: Map<string, PendingApproval> = store.get(pendingApprovalsAtom);
    const questions: Map<string, unknown> = store.get(pendingQuestionsAtom);
    return {
        threadId: store.get(currentThreadIdAtom),
        threadName: store.get(currentThreadNameAtom),
        activeRunId: activeRun?.id ?? null,
        activeRunStatus: activeRun?.status ?? null,
        isPending: store.get(isWSChatPendingAtom),
        runCount: runs.length,
        lastRunId: runs.length ? runs[runs.length - 1].id : null,
        pendingApprovals: Array.from(approvals.values()).map(serializeApproval),
        pendingQuestionIds: Array.from(questions.keys()),
    };
}

type SettleReason = 'done' | 'approval' | 'question' | 'timeout';

/**
 * Poll until the run settles: it finished streaming (`done`), paused for a write
 * approval (`approval`), paused for an ask_user_question (`question`), or the
 * timeout elapsed. A paused-for-approval run keeps `isWSChatPendingAtom` true, so
 * we must break on pending approvals/questions or we would block until timeout.
 */
async function waitForRunSettle(timeoutMs: number, pollMs = 300): Promise<SettleReason> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (store.get(pendingApprovalsAtom).size > 0) return 'approval';
        if (store.get(pendingQuestionsAtom).size > 0) return 'question';
        if (!store.get(isWSChatPendingAtom)) return 'done';
        await sleep(pollMs);
    }
    return 'timeout';
}

/** Resolve `{library_id, zotero_key}` refs to live Zotero items (v0.22: no library_ref). */
async function resolveItems(
    refs: Array<{ library_id: number; zotero_key: string }>,
): Promise<{ items: Zotero.Item[]; unresolved: any[] }> {
    const items: Zotero.Item[] = [];
    const unresolved: any[] = [];
    for (const ref of refs) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.library_id, ref.zotero_key);
        if (item) items.push(item as Zotero.Item);
        else unresolved.push({ ...ref, status: 'not_found' });
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
 *   items           optional [{library_id, zotero_key}] to attach
 *   collections     optional [{library_id, collection_key}] to attach
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
            await store.set(loadThreadAtom, { user_id: userId, threadId });
        }
    }

    if (store.get(isWSChatPendingAtom)) {
        return { ok: false, error: 'A run is already in progress; wait for it to settle', ...currentIds() };
    }

    // Stage attachments directly (deterministic — bypasses the background
    // validation the UI runs; the send path still drops excluded-library items).
    let unresolvedItems: any[] = [];
    let unresolvedCollections: any[] = [];
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
            ...currentIds(),
        };
    }

    let settle: SettleReason | null = null;
    if (request?.waitForDone !== false) {
        settle = await waitForRunSettle(
            typeof request?.timeoutMs === 'number' ? request.timeoutMs : 180000,
        );
    }

    return { ok: true, sent, settle, unresolvedItems, unresolvedCollections, ...currentIds() };
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
    await store.set(loadThreadAtom, {
        user_id: userId,
        threadId,
        threadName: request?.threadName,
    });
    return {
        ok: true,
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
        store.set(sendApprovalResponseAtom, {
            actionId,
            approved,
            userInstructions: request?.userInstructions ?? null,
        });
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
            case 'zotero_note':
            case 'create_note':
                await undoCreateNoteAction(action);
                break;
            case 'edit_note':
                await undoEditNoteAction(action);
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
