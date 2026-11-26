/**
 * The instance's run sessions (`addon.agentRuns`).
 *
 * Chat runs execute in the plugin realm. A session covers one chat: it is
 * created when a window opens the chat (or starts a new one), and every run of
 * that chat happens in it. Windows view sessions: a window shows one chat at
 * a time and views that chat's session, any number of windows may view the
 * same one, and a session with work going needs none. Switching chats or
 * closing a window only changes what is viewed; the session goes on, and
 * leaves the registry once nothing views it and it has nothing left to do.
 *
 * What ends runs early is decided here as well: the account changing or a
 * library leaving the searchable scope (`closeAll`), and the instance shutting
 * down (`shutdown`).
 *
 * Thread lists read the sessions' activity (`listActivity`, published as
 * `agent-runs:activity`): which chats have a run going, and which of those
 * wait for the user.
 */

import { atom, createStore } from 'jotai/vanilla';
import { AgentService } from '@beaver/agent-core/transport/agentService';
import { activeRunAtom, currentThreadIdAtom, currentThreadNameAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { openParkedRunAtom } from '@beaver/agent-core/run-state/parkedRun';
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { pendingBatchApprovalsAtom } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import { pendingTableCardsAtom } from '@beaver/agent-core/run-state/pendingTableCards';
import { pendingCreditConfirmationsAtom } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { TABLE_FILL_CHANGED_EVENT } from '@beaver/agent-core/protocol/tableFillProtocol';
import { logger } from '@beaver/agent-core/platform/logger';
import { isRunActive } from '@beaver/agent-core/agents/types';
import type { ModelConfig } from '@beaver/agent-core/types/models';
import type { MessageAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import { createZoteroDataProvider } from '../zoteroDataProvider';
import { getDeferredToolPreference } from '../agentDataProvider/utils';
import type { OperationContext } from '../agentDataProvider/operationContext';
import type { InstanceAccount } from '../instanceAccount';
import type { AwaitingInput } from '../threads/awaitingInput';
import { RUN_ACTIVITY_EVENT, type RunActivity } from './runActivity';
import { RunSession } from './runSession';
import { createSessionPort, sessionBusy, sessionOwner, type SessionPort } from './sessionPort';
import { createViewerRunHost, type RunViewer } from './runViewer';
import { sessionStateAtoms } from './sessionState';
import { currentWriter, releaseWriter, sessionClaimHolder } from './threadWriter';
import { emitAttachmentResolved } from './attachmentResolvedEvent';
import { copyIn } from './copyIn';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import type { ExternalRefContext } from '../../utils/noteCitationExpand';
import { libraryRefForLibraryID, resolveLibraryRef } from '../../utils/libraryIdentity';
import { pendingApprovalsAtom } from './pendingApprovals';
import { jobWaitAtom } from './jobWait';
import {
    grantCreatedNoteEditsForRunAtom,
    isActionApprovedForCurrentRun,
    isFullAccessGrantedForRun,
    runApprovalPolicyAtom,
} from './runApprovalPolicy';
import {
    abandonActiveRunLocallyAtom,
    buildModelSelectionOptions,
    closeWSConnectionForShutdownAtom,
    isWSChatPendingAtom,
    isWSConnectedAtom,
    requestJobResume,
} from './runEngine';

/** Chats that may have a run going at once (`setCapacity` changes it, for tests). */
export const DEFAULT_RUN_CAPACITY = 4;


/** A message started with no window (`InstanceAgentRuns.submit`). */
export interface ApiSubmission {
    text: string;
    /**
     * Zotero items, as references. Only those in a searchable library are
     * sent, as bare references; any other kind of attachment is left out.
     */
    attachments?: MessageAttachment[];
    /** The model; the account's default when absent. */
    model?: ModelConfig | null;
    origin: { kind: 'api'; label: string };
}

/** What a run started with no window may attach: Zotero items (`item`) and attachments (`source`). */
const API_ATTACHMENT_TYPES = new Set<string>(['item', 'source']);

interface SessionEntry {
    readonly session: RunSession;
    readonly port: SessionPort;
    /** Windows viewing the session, and opens about to (their tokens). */
    readonly holders: Set<string>;
    /** The window that sent the session's latest message. */
    originWindowId: string | null;
    /** The window whose command the session handles now. */
    issuerWindowId: string | null;
    /** The thread the registry indexes the session under. */
    threadId: string | null;
    /** The model of the session's latest message. */
    model: ModelConfig | null;
    /** Set for a run started with no window: every write waits for approval, and nothing grants more. */
    askEveryWrite: boolean;
    /** The external-reference mappings of the last window that stopped viewing the session. */
    leftReferences: ExternalRefContext | null;
    busy: boolean;
    startedAt: number;
    /** The sync pause of the session's run, and whether that run is still pending. */
    syncPause: { key: string; pending: boolean } | null;
    readonly cleanups: Array<() => void>;
}

/** A session as `/beaver/test/runs` lists it. */
export interface RunSessionSummary {
    sessionId: string;
    viewers: string[];
    threadId: string | null;
    busy: boolean;
    activeRunId: string | null;
    activeRunStatus: string | null;
    pending: boolean;
    connected: boolean;
    writer: boolean;
    jobWait: boolean;
}

/** Where the engine runs: the plugin realm has no document of its own. */
const ENGINE_REALM = typeof (globalThis as { document?: unknown }).document === 'undefined' ? 'plugin' : 'window';

/**
 * The active run's identity and status: what the registry follows of it.
 * A streamed part changes the run but not this, so streaming wakes nothing.
 */
const activeRunStateAtom = atom((get) => {
    const run = get(activeRunAtom);
    return run ? `${run.id}:${run.status}` : null;
});

/** Session state whose change may change whether a session is busy, or what its activity shows. */
const WATCHED_ATOMS = [
    currentThreadIdAtom,
    activeRunStateAtom,
    isWSChatPendingAtom,
    jobWaitAtom,
    pendingApprovalsAtom,
    pendingQuestionsAtom,
    pendingBatchApprovalsAtom,
    pendingTableCardsAtom,
    pendingCreditConfirmationsAtom,
] as const;

/** Open cards of a session's live run, counted by the kinds `awaiting_input` uses. */
function awaitingOf(session: RunSession): AwaitingInput | null {
    const { get } = session.store;
    if (!isRunActive(get(activeRunAtom))) return null;
    const counts: Record<string, number> = {};
    const add = (kind: string, size: number) => {
        if (size > 0) counts[kind] = size;
    };
    add('agent_action_approval', get(pendingApprovalsAtom).size);
    add('ask_user_question', get(pendingQuestionsAtom).size);
    add('batch_approval', get(pendingBatchApprovalsAtom).size);
    add('table_card', get(pendingTableCardsAtom).size);
    add('credit_confirmation', get(pendingCreditConfirmationsAtom).size);
    return Object.keys(counts).length ? counts : null;
}

/**
 * A session parked on a fill: it waits for the fill with no socket and no run
 * going. Once the fill's result starts resuming the run, it counts again.
 */
function parkedOnJob(session: RunSession): boolean {
    const { get } = session.store;
    return !!get(jobWaitAtom)
        && !session.parkedResumeStarting
        && !isRunActive(get(activeRunAtom))
        && !get(isWSChatPendingAtom)
        && !session.agentService.isConnected()
        && session.connectLoopsInFlight === 0;
}

let openSeq = 0;

export class InstanceAgentRuns {
    private readonly sessions = new Map<string, SessionEntry>();
    private readonly byThread = new Map<string, SessionEntry>();
    private readonly viewers = new Map<string, RunViewer>();
    /** The session each window views. */
    private readonly views = new Map<string, string>();
    private readonly cleanups: Array<() => void> = [];
    private disposed = false;
    private capacity = DEFAULT_RUN_CAPACITY;
    private unsubscribeAccount: (() => void) | null = null;
    private refreshScheduled = false;
    private publishedActivity = '';

    /** Follow the account: runs end when it changes or a library leaves the searchable scope. */
    start(account: InstanceAccount): void {
        this.unsubscribeAccount?.();
        let generation: number | null = null;
        // Increased by the account whenever a library leaves the searchable scope.
        let revocations = Zotero.Beaver?.libraryRevocations ?? 0;
        this.unsubscribeAccount = account.subscribe((snapshot) => {
            // Shutdown disposes the account too; `shutdown` ends the runs then.
            if (Zotero.__beaverShuttingDown) return;
            const nextRevocations = Zotero.Beaver?.libraryRevocations ?? 0;
            if (generation !== null && generation !== snapshot.generation) this.closeAll('Account changed');
            else if (nextRevocations !== revocations) this.closeAll('Library access changed');
            revocations = nextRevocations;
            generation = snapshot.generation;
        });
        // A fill a session waits on may have ended: its parked run resumes.
        const runtime = Zotero.Beaver?.runtime;
        if (runtime) {
            this.cleanups.push(runtime.subscribe(TABLE_FILL_CHANGED_EVENT, (snapshot: { job_id?: string; state?: string }) => {
                if (snapshot?.state !== 'done') return;
                for (const { session } of this.sessions.values()) {
                    if (session.store.get(jobWaitAtom)?.jobId === snapshot.job_id) requestJobResume(session);
                }
            }));
        }
    }

    /** Register a chat window's viewer, until the window closes (`detachWindow`). */
    attachWindow(windowId: string, viewer: RunViewer): void {
        if (this.disposed) throw new Error('Agent runs are shut down');
        this.viewers.set(windowId, viewer);
    }

    /**
     * The session of `threadId` (a new chat's for null), created when there is
     * none, held for `holder` until it is released or the holder views
     * another. Holding keeps an idle session in the registry.
     */
    acquire(holder: string, threadId: string | null): SessionPort {
        if (this.disposed) throw new Error('Agent runs are shut down');
        let entry = threadId ? this.byThread.get(threadId) : undefined;
        if (!entry) entry = this.create(threadId);
        entry.holders.add(holder);
        return this.portFor(entry, holder);
    }

    /**
     * Show `sessionId` in `windowId`: the window views that session from now
     * on, and stops viewing the one it showed before. Returns the window's
     * port of the session.
     */
    view(windowId: string, sessionId: string): SessionPort {
        const entry = this.sessions.get(sessionId);
        if (!entry || this.disposed) throw new Error('No such run session');
        const previous = this.views.get(windowId);
        this.views.set(windowId, sessionId);
        entry.holders.add(windowId);
        if (previous && previous !== sessionId) this.drop(previous, windowId);
        return this.portFor(entry, windowId);
    }

    /** Open `threadId` in `windowId` (a new chat for null): acquire its session and view it. */
    open(windowId: string, threadId: string | null): SessionPort {
        const token = `${windowId}:open:${++openSeq}`;
        const port = this.acquire(token, threadId);
        try {
            return this.view(windowId, port.sessionId);
        } finally {
            this.release(token, port.sessionId);
        }
    }

    /** Release what `holder` held of `sessionId`. */
    release(holder: string, sessionId: string): void {
        this.drop(sessionId, holder);
    }

    /** The session of `threadId`, if one is in the registry. */
    sessionForThread(threadId: string): SessionPort | null {
        const entry = this.byThread.get(threadId);
        return entry ? entry.port : null;
    }

    /**
     * The window closed: it views nothing any more and its viewer is gone.
     * Its sessions go on; one with nothing to do leaves the registry.
     */
    detachWindow(windowId: string): void {
        const viewed = this.views.get(windowId);
        this.views.delete(windowId);
        for (const entry of this.sessions.values()) {
            if (entry.originWindowId === windowId) entry.originWindowId = null;
            if (entry.issuerWindowId === windowId) entry.issuerWindowId = null;
        }
        // While the window still has its viewer: the session keeps what it showed.
        if (viewed) this.drop(viewed, windowId);
        this.viewers.delete(windowId);
    }

    /** Stop every session's run (account change, library scope loss). Sessions stay while viewed. */
    closeAll(reason: string): void {
        for (const entry of [...this.sessions.values()]) {
            const { session } = entry;
            try {
                Zotero.Beaver?.mutations?.cancelOwner(sessionOwner(session));
                session.agentService.close(1000, reason);
                session.store.set(abandonActiveRunLocallyAtom);
                session.store.set(jobWaitAtom, null);
                releaseWriter(session);
            } catch (error) {
                logger(`agentRuns: stopping session ${session.id} failed: ${error}`, 1);
            }
            this.refresh(entry);
        }
        this.publishActivity();
    }

    /**
     * Zotero quits or Beaver shuts down: park each run that waits only on
     * cards, close any other with 1000 and record its chat as interrupted,
     * and end every session. Called once writes have settled.
     */
    shutdown(reason: string): void {
        for (const entry of [...this.sessions.values()]) {
            try {
                entry.session.store.set(closeWSConnectionForShutdownAtom, reason, { rememberInterruptedThread: true });
            } catch (error) {
                logger(`agentRuns: closing session ${entry.session.id} failed: ${error}`, 1);
            }
            this.end(entry);
        }
        this.publishActivity();
    }

    /** Shut down: refuse new sessions, and close each session's run (`shutdown`). */
    dispose(reason: string): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribeAccount?.();
        this.unsubscribeAccount = null;
        this.cleanups.splice(0).forEach((cleanup) => cleanup());
        this.shutdown(reason);
        this.viewers.clear();
        this.views.clear();
    }

    /** Change how many chats may have a run going at once; for tests. */
    setCapacity(capacity: number): void {
        this.capacity = Math.max(1, Math.floor(capacity));
    }

    /** The chats with a run going. */
    listActivity(): RunActivity[] {
        return [...this.sessions.values()]
            .filter((entry) => entry.busy)
            .map((entry) => ({
                threadId: entry.session.store.get(currentThreadIdAtom),
                sessionId: entry.session.id,
                awaiting: awaitingOf(entry.session),
                startedAt: entry.startedAt,
            }));
    }

    list(): RunSessionSummary[] {
        return [...this.sessions.values()].map((entry) => {
            const { session } = entry;
            const activeRun = session.store.get(activeRunAtom);
            return {
                sessionId: session.id,
                viewers: [...entry.holders].filter((holder) => this.viewers.has(holder)),
                threadId: session.store.get(currentThreadIdAtom),
                busy: sessionBusy(session),
                activeRunId: activeRun?.id ?? null,
                activeRunStatus: activeRun?.status ?? null,
                pending: session.store.get(isWSChatPendingAtom),
                connected: session.store.get(isWSConnectedAtom),
                writer: !!currentWriter(session),
                jobWait: !!session.store.get(jobWaitAtom),
            };
        });
    }

    /** A session's state for diagnostics: summary values, counts for collections. */
    snapshot(sessionId: string): Record<string, unknown> | null {
        const entry = this.sessions.get(sessionId);
        if (!entry) return null;
        const { store } = entry.session;
        const state: Record<string, unknown> = {};
        for (const [name, atom] of sessionStateAtoms()) state[name] = summarize(store.get(atom));
        const activeRun = store.get(activeRunAtom);
        return {
            engineRealm: ENGINE_REALM,
            ...this.list().find((summary) => summary.sessionId === sessionId),
            origin: entry.originWindowId,
            threadName: store.get(currentThreadNameAtom),
            runs: store.get(threadRunsAtom).map((run) => ({ id: run.id, status: run.status })),
            activeRun: activeRun
                ? { id: activeRun.id, status: activeRun.status, active: isRunActive(activeRun), messages: activeRun.model_messages.length }
                : null,
            state,
        };
    }

    /**
     * Start a new chat with no window (`origin: api`). The prompt carries its
     * context explicitly: items as references in a searchable library, no
     * reader or selection. Every write the run
     * proposes waits for the user's approval, in any window that opens the
     * chat, and nothing it approves grants further writes. Resolves once the
     * run is accepted, with its session, or with why it was refused.
     */
    submit(input: ApiSubmission): { sessionId: string } | { error: 'shut_down' | 'not_signed_in' | 'capacity' | 'empty'; message?: string } {
        if (this.disposed) return { error: 'shut_down' };
        const userId = Zotero.Beaver?.account?.getSnapshot().session?.user.id;
        if (!userId) return { error: 'not_signed_in' };
        if (!input.text?.trim()) return { error: 'empty' };
        const holder = `api:${++openSeq}`;
        const port = this.acquire(holder, null);
        const entry = this.sessions.get(port.sessionId)!;
        const refusal = this.capacityRefusal(entry);
        if (refusal) {
            this.release(holder, port.sessionId);
            return { error: 'capacity', message: refusal.text };
        }
        // Each reference's library as its portable reference names it; only
        // the reference itself is sent, nothing else the caller attached to it.
        const searchable = new Set(Zotero.Beaver?.searchableLibraryIds ?? []);
        const attachments = (input.attachments ?? []).flatMap((attachment): MessageAttachment[] => {
            if (!API_ATTACHMENT_TYPES.has(attachment.type)) return [];
            const ref = attachment as { library_ref?: string | null; library_id?: number | null; zotero_key?: string };
            const libraryId = resolveLibraryRef(ref);
            if (libraryId == null || !searchable.has(libraryId) || typeof ref.zotero_key !== 'string') return [];
            const libraryRef = libraryRefForLibraryID(libraryId) ?? undefined;
            return [{ type: attachment.type, library_id: libraryId, zotero_key: ref.zotero_key, library_ref: libraryRef } as MessageAttachment];
        });
        entry.askEveryWrite = true;
        const model = input.model ? copyIn(input.model) : null;
        logger(`agentRuns: session ${port.sessionId} starts a run for ${input.origin.label}`, 3);
        void port.withThreadWriter((scope) => {
            // As a window's send does: the chat is busy from here on, so a
            // window that opens it shows the response going, with Stop.
            scope.set('prepareForNewRun');
            scope.set('isWSChatPending', true);
            scope.set('currentThreadName', input.text.substring(0, 35));
            return scope.startMessageRun({
            prompt: {
                content: input.text,
                ...(attachments.length ? { attachments } : {}),
                filters: { libraries: null, collections: null, tags: null },
            },
            threadId: null,
            userId,
            model,
            modelOptions: buildModelSelectionOptions(model),
            });
        })
            .catch((error) => {
                logger(`agentRuns: the run of session ${port.sessionId} failed to start: ${error}`, 1);
                port.set('isWSChatPending', false);
            })
            .finally(() => this.release(holder, port.sessionId));
        return { sessionId: port.sessionId };
    }

    /** The port the registry uses itself (API submissions, development commands). */
    portOf(sessionId: string): SessionPort | null {
        return this.sessions.get(sessionId)?.port ?? null;
    }

    private create(threadId: string | null): SessionEntry {
        let entry: SessionEntry | null = null;
        const dataProvider = createZoteroDataProvider({
            operationContext: () => this.operationContext(entry!),
        });
        const viewerOf = (windowId: string | null) =>
            windowId && entry?.holders.has(windowId) ? this.viewers.get(windowId) ?? null : null;
        const session = new RunSession(
            createStore(),
            new AgentService(undefined, dataProvider),
            createViewerRunHost({
                viewers: () => (entry ? [...entry.holders].flatMap((holder) => this.viewers.get(holder) ?? []) : []),
                origin: () => viewerOf(entry?.originWindowId ?? null),
                issuer: () => viewerOf(entry?.issuerWindowId ?? null),
                owner: () => (entry ? sessionOwner(entry.session) : undefined),
                threadId: () => entry?.session.store.get(currentThreadIdAtom) ?? null,
                live: () => !!entry && !entry.session.ended,
                model: () => entry?.model ?? null,
                openChat: () => this.openInMainWindow(entry),
            }),
        );
        entry = {
            session,
            port: createSessionPort(session),
            holders: new Set(),
            originWindowId: null,
            issuerWindowId: null,
            threadId,
            model: null,
            askEveryWrite: false,
            leftReferences: null,
            busy: false,
            startedAt: Date.now(),
            syncPause: null,
            cleanups: [],
        };
        const created = entry;
        if (threadId) session.store.set(currentThreadIdAtom, threadId);
        this.sessions.set(session.id, created);
        if (threadId) this.byThread.set(threadId, created);
        session.lifecycleListener = () => this.scheduleRefresh();
        session.capacityRefusal = () => this.capacityRefusal(created);
        for (const atom of WATCHED_ATOMS) created.cleanups.push(session.store.sub(atom, () => this.scheduleRefresh()));
        // The session waits on the fills its runs start.
        created.cleanups.push(session.agentService.onJobWait((wait) => {
            const waitThread = wait.threadId ?? session.store.get(currentThreadIdAtom);
            if (!waitThread) return;
            session.store.set(jobWaitAtom, { threadId: waitThread, runId: wait.runId, toolCallId: wait.toolCallId, jobId: wait.jobId });
        }));
        // A fill's run may have parked after the fill ended (a reattach).
        created.cleanups.push(session.store.sub(openParkedRunAtom, () => {
            if (session.store.get(jobWaitAtom)) requestJobResume(session);
        }));
        logger(`agentRuns: session ${session.id} created for ${threadId ?? 'a new chat'} (engine in the ${ENGINE_REALM} realm)`, 3);
        return created;
    }

    /** The port `holder` uses: commands it issues are attributed to it. */
    private portFor(entry: SessionEntry, holder: string): SessionPort {
        return createSessionPort(entry.session, {
            viewerAttached: () => entry.holders.has(holder) && this.viewers.has(holder),
            onCommand: () => {
                if (this.viewers.has(holder)) entry.issuerWindowId = holder;
            },
            isOrigin: () => entry.originWindowId === holder,
            onSend: (model) => {
                if (this.viewers.has(holder)) {
                    entry.originWindowId = holder;
                    // A message from a window follows the user's approval settings.
                    entry.askEveryWrite = false;
                }
                entry.model = model;
            },
        });
    }

    private drop(sessionId: string, holder: string): void {
        const entry = this.sessions.get(sessionId);
        if (!entry) return;
        // A run going on without this window keeps the mappings it showed.
        const viewer = this.viewers.get(holder);
        if (viewer && entry.holders.has(holder)) entry.leftReferences = copyIn(viewer.externalReferences());
        entry.holders.delete(holder);
        this.refresh(entry);
        this.publishActivity();
    }

    private scheduleRefresh(): void {
        if (this.refreshScheduled) return;
        this.refreshScheduled = true;
        // Zotero 7's plugin scope has no `queueMicrotask`.
        void Promise.resolve().then(() => {
            this.refreshScheduled = false;
            for (const entry of [...this.sessions.values()]) this.refresh(entry);
            this.publishActivity();
        });
    }

    /**
     * Bring the registry's record of a session up to date: the thread it is
     * indexed under and whether it is busy. A session nothing holds and with
     * nothing to do leaves the registry.
     */
    private refresh(entry: SessionEntry): void {
        if (entry.session.ended) return;
        const { session } = entry;
        const threadId = session.store.get(currentThreadIdAtom);
        if (threadId !== entry.threadId) {
            if (entry.threadId && this.byThread.get(entry.threadId) === entry) this.byThread.delete(entry.threadId);
            entry.threadId = threadId;
            if (threadId) {
                const other = this.byThread.get(threadId);
                if (other && other !== entry) logger(`agentRuns: two sessions show chat ${threadId}`, 1);
                else this.byThread.set(threadId, entry);
            }
        }
        this.followSyncPause(entry);
        const busy = sessionBusy(session);
        if (busy && !entry.busy) entry.startedAt = Date.now();
        entry.busy = busy;
        if (!busy && entry.holders.size === 0) this.end(entry);
    }

    private publishActivity(): void {
        const activity = this.listActivity();
        const key = JSON.stringify(activity.map((entry) => [entry.sessionId, entry.threadId, entry.awaiting]));
        if (key === this.publishedActivity) return;
        this.publishedActivity = key;
        Zotero.Beaver?.runtime?.publish(RUN_ACTIVITY_EVENT, activity);
    }

    /**
     * Zotero sync stays paused while a run writes to the library (the data
     * provider pauses it under the run's key): let it resume once the run is
     * no longer pending, or another run replaces it.
     */
    private followSyncPause(entry: SessionEntry): void {
        const syncPause = Zotero.Beaver?.syncPause;
        if (!syncPause) return;
        const { get } = entry.session.store;
        const runId = get(activeRunAtom)?.id;
        const key = runId ? `chat:${sessionOwner(entry.session)}:${runId}` : null;
        const pending = !!key && get(isWSChatPendingAtom);
        const previous = entry.syncPause;
        if (previous?.key === key && previous?.pending === pending) return;
        if (previous && previous.key !== key) syncPause.scheduleResumeAfterRun(previous.key);
        entry.syncPause = key ? { key, pending } : null;
        if (!key) return;
        if (pending) syncPause.cancelScheduledResume(key);
        else syncPause.scheduleResumeAfterRun(key);
    }

    /** The session leaves the registry: nothing holds it and it has nothing to do, or the instance shuts down. */
    private end(entry: SessionEntry): void {
        const { session } = entry;
        if (session.ended) return;
        const owner = sessionOwner(session);
        releaseWriter(session);
        session.ended = true;
        session.lifecycleListener = null;
        session.capacityRefusal = null;
        entry.cleanups.splice(0).forEach((cleanup) => cleanup());
        this.sessions.delete(session.id);
        if (entry.threadId && this.byThread.get(entry.threadId) === entry) this.byThread.delete(entry.threadId);
        for (const [windowId, viewed] of this.views) if (viewed === session.id) this.views.delete(windowId);
        try {
            if (session.agentService.isConnected()) session.agentService.close(1000, 'Chat closed');
        } catch (error) {
            logger(`agentRuns: closing the socket of session ${session.id} failed: ${error}`, 1);
        }
        Zotero.Beaver?.mutations?.cancelOwner(owner);
        Zotero.Beaver?.syncPause?.releaseOwnerRuns(owner);
        Zotero.Beaver?.presence?.detach(sessionClaimHolder(session));
        logger(`agentRuns: session ${session.id} ended`, 3);
    }

    /** Why `entry` may not start a run now: too many chats already have one going. */
    private capacityRefusal(entry: SessionEntry): { title: string; text: string } | null {
        let running = 0;
        for (const other of this.sessions.values()) {
            if (other === entry || !sessionBusy(other.session) || parkedOnJob(other.session)) continue;
            running++;
        }
        if (running < this.capacity) return null;
        return {
            title: 'Too many responses at once',
            text: `Beaver is already working on ${running === 1 ? 'another chat' : `${running} chats`}. Wait for one to finish, or stop one, then send again. Your message is kept.`,
        };
    }

    /** A notification of a session no window shows was clicked: open its chat in a main window. */
    private openInMainWindow(entry: SessionEntry | null): void {
        const threadId = entry?.session.store.get(currentThreadIdAtom);
        if (!threadId) return;
        try {
            const main = Zotero.getMainWindow?.();
            const runtime = main ? Zotero.Beaver?.runtime?.resolveWindowFrom(main) : undefined;
            if (!runtime) return;
            void Zotero.Beaver.runtime.dispatchWindowCommand('show-chat', { windowId: runtime.id, threadId })
                .catch((error: unknown) => logger(`agentRuns: opening chat ${threadId} failed: ${error}`, 1));
        } catch (error) {
            logger(`agentRuns: opening chat ${threadId} failed: ${error}`, 1);
        }
    }

    /** What an operation requested by a session's run may do, captured per request. */
    private operationContext(entry: SessionEntry): OperationContext {
        const { session } = entry;
        const { store } = session;
        const runId = store.get(activeRunAtom)?.id;
        const currentPolicy = store.get(runApprovalPolicyAtom);
        const policy = currentPolicy ? { ...currentPolicy, approvedResources: new Set(currentPolicy.approvedResources) } : undefined;
        const account = Zotero.Beaver?.account;
        const generation = account?.getGeneration();
        const references = this.referencesOf(entry);
        const live = () => !session.ended && generation === Zotero.Beaver?.account?.getGeneration();
        return {
            accountGeneration: generation,
            userId: account?.getSnapshot().session?.user.id,
            onAttachmentResolved: (payload) => {
                if (live()) emitAttachmentResolved(session.agentService, payload);
            },
            owner: sessionOwner(session),
            threadId: store.get(currentThreadIdAtom),
            runId,
            fullAccess: !entry.askEveryWrite && !!policy && isFullAccessGrantedForRun(policy, runId ?? null),
            preference: (tool, data) => {
                if (entry.askEveryWrite) return 'always_ask';
                if (policy && isActionApprovedForCurrentRun(policy, runId ?? null, tool, data)) return 'always_apply';
                return getDeferredToolPreference(tool, data);
            },
            externalRefs: references.externalRefs,
            externalItemMapping: references.externalItemMapping,
            grantCreatedNote: (libraryId, zoteroKey) => {
                if (!entry.askEveryWrite && live() && runId && store.get(activeRunAtom)?.id === runId) {
                    store.set(grantCreatedNoteEditsForRunAtom, { runId, libraryId, zoteroKey });
                }
            },
        };
    }

    /** The chat's external-reference mappings, from a window that views it. */
    /**
     * The chat's external-reference mappings: those of a window that shows it
     * (the chat's whole history), else those the last such window left, and
     * over either the references the session's own runs found.
     */
    private referencesOf(entry: SessionEntry): ExternalRefContext {
        const holder = [entry.issuerWindowId, entry.originWindowId, ...entry.holders]
            .find((id) => !!id && entry.holders.has(id) && this.viewers.has(id));
        const shown = holder ? this.viewers.get(holder)!.externalReferences() : entry.leftReferences;
        const { get } = entry.session.store;
        return {
            externalRefs: { ...(shown?.externalRefs ?? {}), ...get(externalReferenceMappingAtom) },
            externalItemMapping: { ...(shown?.externalItemMapping ?? {}), ...get(externalReferenceItemMappingAtom) },
        };
    }
}

/** A value reduced to what a diagnostics read needs. */
function summarize(value: unknown): unknown {
    // Duck-typed: a window may have set the value, and its Map is not this realm's.
    if (value && typeof value === 'object' && typeof (value as { size?: unknown }).size === 'number') {
        return { size: (value as { size: number }).size };
    }
    if (Array.isArray(value)) return { length: value.length };
    if (value && typeof value === 'object') return 'id' in value ? { id: (value as { id: unknown }).id } : '[object]';
    return value;
}
