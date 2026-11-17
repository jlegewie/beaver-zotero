/**
 * This renderer's side of job calls: a job a chat waits on (a table fill,
 * PDFs) that ended after its run parked.
 *
 * - When this device stores a job's result (`addon.jobCalls`), the window
 *   showing the thread puts the result on the parked call and resumes the
 *   run at once; when no window shows it, one window tells the user.
 * - When another device stores it while a window here shows the thread, the
 *   thread's `awaiting_input` gains `job_ready`: that window reloads the
 *   parked call and resumes too. Thread admission lets one device's resume
 *   run; the other sees the run continue.
 * - A thread opened later already carries the stored result: the job bar
 *   offers Continue, and nothing resumes by itself.
 */

import { atom } from 'jotai';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    JOB_CALL_STORED_EVENT,
    JOB_READY_KEY,
    PDF_JOB_CHANGED_EVENT,
    isJobDeferral,
    type JobCallStoredNotification,
    type JobResult,
    type PdfJobSnapshot,
} from '@beaver/agent-core/protocol/jobCallProtocol';
import { activeRunAtom, currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import {
    fillLabel,
    isStoppedJobResult,
    openJobCallsAtom,
    pdfLabel,
    runWithStoredJobResult,
    withStoredJobResult,
} from '@beaver/agent-core/run-state/jobCalls';
import { isRunActive } from '@beaver/agent-core/agents/types';
import { agentRunService } from '@beaver/agent-core/transport/agentService';
import { notifyJobReady } from '../../src/services/systemNotifications';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';
import { store } from '../store';
import { userIdAtom } from './auth';
import { continueParkedJobsAtom } from './agentRunAtoms';
import { loadThreadAtom } from './threads';
import { threadEntitiesAtom } from './threadList';
import { addPopupMessageAtom, removePopupMessageAtom } from '../utils/popupMessageUtils';
import { eventManager } from '../events/eventManager';
import { popupMessagesAtom } from './ui';

/** PDF retrieval jobs this device runs, by job id, as the job bar follows them. */
export const chatPdfJobsAtom = atom<ReadonlyMap<string, PdfJobSnapshot>>(new Map());

function recordPdfJob(snapshot: PdfJobSnapshot): void {
    if (!snapshot?.job_id) return;
    const jobs = store.get(chatPdfJobsAtom);
    const held = jobs.get(snapshot.job_id);
    // A late snapshot of a running job never undoes its end.
    if (held?.ended && !snapshot.ended) return;
    store.set(chatPdfJobsAtom, new Map(jobs).set(snapshot.job_id, snapshot));
}

/**
 * Finished jobs of chats this window does not show, for the closed-sidebar
 * status popup: each until the user opens its chat or dismisses it.
 */
export interface JobReadyNotice {
    threadId: string;
    toolCallId: string;
    kind: JobCallStoredNotification['kind'];
    title: string;
    subject?: string;
    result: JobResult;
}

export const jobReadyNoticesAtom = atom<readonly JobReadyNotice[]>([]);

/** The in-sidebar message reporting a thread's finished job. */
function noticeMessageId(threadId: string): string {
    return `job-ready-${threadId}`;
}

/** A finished job's notice goes, in the status popup and in the sidebar. */
export const dismissJobReadyNoticeAtom = atom(null, (get, set, threadId: string) => {
    const notices = get(jobReadyNoticesAtom);
    if (!notices.some((notice) => notice.threadId === threadId)) return;
    set(jobReadyNoticesAtom, notices.filter((notice) => notice.threadId !== threadId));
    set(removePopupMessageAtom, noticeMessageId(threadId));
});

/** Open Beaver on a finished job's chat. */
export const openJobReadyChatAtom = atom(null, (get, set, threadId: string) => {
    set(dismissJobReadyNoticeAtom, threadId);
    eventManager.dispatch('toggleChat', { forceOpen: true });
    const userId = get(userIdAtom);
    if (!userId) return;
    void set(loadThreadAtom, { user_id: userId, threadId });
});

/** Put a stored job result on the open thread's parked call. Returns whether it was there. */
export const applyStoredJobResultAtom = atom(
    null,
    (get, set, { threadId, toolCallId, result }: { threadId: string; toolCallId: string; result: JobResult }): boolean => {
        if (get(currentThreadIdAtom) !== threadId) return false;
        const runs = withStoredJobResult(get(threadRunsAtom), toolCallId, result);
        if (runs) set(threadRunsAtom, runs);
        const active = runWithStoredJobResult(get(activeRunAtom), toolCallId, result);
        if (active) set(activeRunAtom, active);
        return !!(runs || active);
    },
);

/** The open thread's `awaiting_input`, as the thread list has it. */
const currentAwaitingAtom = atom((get) => {
    const id = get(currentThreadIdAtom);
    return id ? (get(threadEntitiesAtom).get(id)?.awaitingInput ?? null) : null;
});

/** Threads whose parked calls are being reloaded, so one update reloads once. */
const reloading = new Set<string>();

/**
 * Another device stored a job result for the open thread: read the parked
 * run again and put the results on its calls.
 */
async function reloadStoredJobResults(threadId: string): Promise<void> {
    if (reloading.has(threadId)) return;
    reloading.add(threadId);
    try {
        const history = await agentRunService.getThreadRuns(threadId, false);
        if (store.get(currentThreadIdAtom) !== threadId) return;
        const open = new Set(store.get(openJobCallsAtom).filter((call) => !call.result).map((call) => call.tool_call_id));
        let applied = false;
        for (const run of history.runs) {
            for (const deferral of run.parked?.requests ?? []) {
                if (!isJobDeferral(deferral) || !deferral.result || !open.has(deferral.tool_call_id)) continue;
                applied = store.set(applyStoredJobResultAtom, { threadId, toolCallId: deferral.tool_call_id, result: deferral.result }) || applied;
            }
        }
        // A window showing the thread continues it, as on the device that
        // stored the result; thread admission lets one device's resume run.
        // A job the user stopped waits for them to continue.
        if (applied && showsFirst(threadId) && !stoppedOnly()) store.set(continueParkedJobsAtom);
    } catch (error) {
        logger(`jobCalls: could not reload the parked calls of ${threadId}: ${String(error)}`, 1);
    } finally {
        reloading.delete(threadId);
    }
}

/** Whether every ready job call of the open thread ended because the user stopped it. */
function stoppedOnly(): boolean {
    const ready = store.get(openJobCallsAtom).filter((call) => call.result);
    return ready.length > 0 && ready.every((call) => isStoppedJobResult(call.result));
}

/** Whether this window is the first on this device that shows the thread. */
function showsFirst(threadId: string): boolean {
    const runtime = tryGetWindowRuntime();
    if (!runtime || store.get(currentThreadIdAtom) !== threadId) return false;
    const viewer = Zotero.Beaver.presence.getSnapshot().viewers.find((entry) => entry.threadId === threadId);
    return viewer?.windowId === runtime.id;
}

function onAwaitingChanged(): void {
    const awaiting = store.get(currentAwaitingAtom);
    const threadId = store.get(currentThreadIdAtom);
    if (!threadId || !awaiting?.[JOB_READY_KEY]) return;
    if (isRunActive(store.get(activeRunAtom))) return;
    if (!store.get(openJobCallsAtom).some((call) => !call.result)) return;
    void reloadStoredJobResults(threadId);
}

/**
 * Tell the user a job finished for a chat no window shows: the closed-sidebar
 * status popup (or, with the sidebar open, a message in it), and a system
 * notification while Zotero is in the background.
 */
function reportJobReady(notification: JobCallStoredNotification): void {
    // The thread list may not be loaded yet (Zotero is starting): load this
    // thread, so the notice can name the chat.
    if (!store.get(threadEntitiesAtom).has(notification.threadId)) {
        void Zotero.Beaver.threads.getThread(notification.threadId).catch(() => undefined);
    }
    const result = notification.result;
    const title = result.kind === 'table_fill' ? fillLabel(result.result) : pdfLabel(result);
    const heading = notification.subject ? `${title} · ${notification.subject}` : title;
    const openChat = () => {
        tryGetWindowRuntime()?.hostWindow.focus();
        store.set(openJobReadyChatAtom, notification.threadId);
    };
    notifyJobReady(heading, 'Beaver can continue the chat with the result. Click to open it.', openChat);
    const notices = store.get(jobReadyNoticesAtom).filter((notice) => notice.threadId !== notification.threadId);
    store.set(jobReadyNoticesAtom, [
        ...notices,
        {
            threadId: notification.threadId,
            toolCallId: notification.toolCallId,
            kind: notification.kind,
            title,
            ...(notification.subject ? { subject: notification.subject } : {}),
            result: notification.result,
        },
    ]);
    // Posted whether or not the sidebar is open now: whichever surface the
    // user looks at next (the corner popup, or the sidebar) says it.
    store.set(addPopupMessageAtom, {
        id: noticeMessageId(notification.threadId),
        type: 'info',
        title: heading,
        text: 'Beaver can continue the chat with the result.',
        expire: false,
        button: { text: 'Open chat', onClick: openChat },
    });
}

function onStored(notification: JobCallStoredNotification): void {
    const runtime = tryGetWindowRuntime();
    if (!runtime || notification.userId !== store.get(userIdAtom)) return;
    if (store.get(currentThreadIdAtom) === notification.threadId) {
        store.set(applyStoredJobResultAtom, notification);
        // One window resumes: the first that shows the thread. A job the
        // user stopped waits for them to continue (or write).
        if (notification.viewerWindowIds[0] === runtime.id && !isStoppedJobResult(notification.result))
            store.set(continueParkedJobsAtom);
        return;
    }
    if (notification.notifyWindowId === runtime.id) reportJobReady(notification);
}

/** Report the stored results no window could report when they were stored. */
function reportHeld(): void {
    const runtime = tryGetWindowRuntime();
    const userId = store.get(userIdAtom);
    if (!runtime || !userId) return;
    for (const notification of Zotero.Beaver.jobCalls?.takeHeld() ?? []) {
        // Another account's result is not reported here.
        if (notification.userId !== userId) continue;
        onStored({ ...notification, viewerWindowIds: [], notifyWindowId: runtime.id });
    }
}

let watching = false;

/** Follow stored job results and job-ready thread updates, once per renderer. */
export function watchJobCalls(): void {
    if (watching) return;
    const runtime = tryGetWindowRuntime();
    if (!runtime) return;
    try {
        Zotero.Beaver.runtime.subscribeWindow(runtime, JOB_CALL_STORED_EVENT, onStored);
        // Results stored before any window could report them (at startup),
        // once this renderer knows its account.
        const unsubscribeUser = store.sub(userIdAtom, reportHeld);
        Zotero.Beaver.runtime.addWindowCleanup(runtime, unsubscribeUser);
        reportHeld();
        Zotero.Beaver.runtime.subscribeWindow(runtime, PDF_JOB_CHANGED_EVENT, recordPdfJob);
        for (const snapshot of Zotero.Beaver.pdfJobs?.listJobs() ?? []) recordPdfJob(snapshot);
        const unsubscribe = store.sub(currentAwaitingAtom, onAwaitingChanged);
        Zotero.Beaver.runtime.addWindowCleanup(runtime, unsubscribe);
        // Closing the sidebar message closes the notice everywhere: the
        // popup card does not come back once the sidebar closes.
        // Seeded with what is up now: a startup notice may already be posted.
        let shown = new Set(store.get(popupMessagesAtom).map((message) => message.id));
        const unsubscribeMessages = store.sub(popupMessagesAtom, () => {
            const now = new Set(store.get(popupMessagesAtom).map((message) => message.id));
            for (const notice of store.get(jobReadyNoticesAtom)) {
                const id = noticeMessageId(notice.threadId);
                if (shown.has(id) && !now.has(id)) store.set(dismissJobReadyNoticeAtom, notice.threadId);
            }
            shown = now;
        });
        Zotero.Beaver.runtime.addWindowCleanup(runtime, unsubscribeMessages);
        // A notice goes once its chat is open: the job bar takes over.
        const unsubscribeThread = store.sub(currentThreadIdAtom, () => {
            const threadId = store.get(currentThreadIdAtom);
            if (threadId) store.set(dismissJobReadyNoticeAtom, threadId);
        });
        Zotero.Beaver.runtime.addWindowCleanup(runtime, unsubscribeThread);
        watching = true;
    } catch (error) {
        logger(`jobCalls: could not follow job results: ${String(error)}`, 1);
    }
}
