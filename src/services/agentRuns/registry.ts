/**
 * The instance's run sessions (`addon.agentRuns`).
 *
 * Chat runs execute in the plugin realm. Each chat window gets one session
 * when it attaches, reused for every run it starts, and reaches it through a
 * `SessionPort`. The window is the session's only viewer: it registers a
 * `RunViewer` for the window's side of a run, and the session's transport,
 * timers, data provider and writer claim live here.
 *
 * What ends a session's runs is decided here as well: the window closing
 * (`closeWindow`), the account changing or a library leaving the searchable
 * scope, and the plugin shutting down (`dispose`).
 */

import { createStore } from 'jotai/vanilla';
import { AgentService } from '@beaver/agent-core/transport/agentService';
import { activeRunAtom, currentThreadIdAtom, currentThreadNameAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { logger } from '@beaver/agent-core/platform/logger';
import { isRunActive } from '@beaver/agent-core/agents/types';
import { createZoteroDataProvider } from '../zoteroDataProvider';
import { loadPreferences } from '../deferredToolPolicy';
import type { OperationContext } from '../agentDataProvider/operationContext';
import type { InstanceAccount } from '../instanceAccount';
import { RunSession } from './runSession';
import { createSessionPort, sessionOwner, type SessionPort } from './sessionPort';
import { createViewerRunHost, type RunViewer } from './runViewer';
import { sessionStateAtoms } from './sessionState';
import { currentWriter } from './threadWriter';
import { emitAttachmentResolved } from './attachmentResolvedEvent';
import {
    grantCreatedNoteEditsForRunAtom,
    isActionApprovedForCurrentRun,
    isFullAccessGrantedForRun,
    runApprovalPolicyAtom,
} from './runApprovalPolicy';
import {
    abandonActiveRunLocallyAtom,
    closeWSConnectionForShutdownAtom,
    isWSChatPendingAtom,
    isWSConnectedAtom,
} from './runEngine';

interface SessionEntry {
    readonly session: RunSession;
    readonly windowId: string;
    viewer: RunViewer | null;
    readonly port: SessionPort;
}

/** A session as `/beaver/test/runs` lists it. */
export interface RunSessionSummary {
    sessionId: string;
    windowId: string;
    viewerAttached: boolean;
    threadId: string | null;
    activeRunId: string | null;
    activeRunStatus: string | null;
    pending: boolean;
    connected: boolean;
    writer: boolean;
}

/** Where the engine runs: the plugin realm has no document of its own. */
const ENGINE_REALM = typeof (globalThis as { document?: unknown }).document === 'undefined' ? 'plugin' : 'window';

export class InstanceAgentRuns {
    private readonly sessions = new Map<string, SessionEntry>();
    private disposed = false;
    private unsubscribeAccount: (() => void) | null = null;

    /** Follow the account: runs end when it changes or a library leaves the searchable scope. */
    start(account: InstanceAccount): void {
        this.unsubscribeAccount?.();
        let generation: number | null = null;
        // Increased by the account whenever a library leaves the searchable scope.
        let revocations = Zotero.Beaver?.libraryRevocations ?? 0;
        this.unsubscribeAccount = account.subscribe((snapshot) => {
            // Shutdown disposes the account too. Each session is closed by its
            // window's unload instead, once active writes have settled, so it
            // can park or record its run.
            if (Zotero.__beaverShuttingDown) return;
            const nextRevocations = Zotero.Beaver?.libraryRevocations ?? 0;
            if (generation !== null && generation !== snapshot.generation) this.closeAll('Account changed');
            else if (nextRevocations !== revocations) this.closeAll('Library access changed');
            revocations = nextRevocations;
            generation = snapshot.generation;
        });
    }

    /**
     * The session of a chat window, created on first attach. `viewer` is the
     * window's side of its runs, until the window closes.
     */
    attachWindow(windowId: string, viewer: RunViewer): SessionPort {
        if (this.disposed) throw new Error('Agent runs are shut down');
        const existing = this.sessions.get(windowId);
        if (existing) {
            existing.viewer = viewer;
            return existing.port;
        }
        let entry: SessionEntry | null = null;
        const dataProvider = createZoteroDataProvider({
            operationContext: () => this.operationContext(entry!),
        });
        const session = new RunSession(
            createStore(),
            new AgentService(undefined, dataProvider),
            createViewerRunHost(() => windowId, () => entry?.viewer ?? null, {
                owner: () => (entry ? sessionOwner(entry.session) : undefined),
                threadId: () => entry?.session.store.get(currentThreadIdAtom) ?? null,
            }),
        );
        entry = {
            session,
            windowId,
            viewer,
            port: createSessionPort(session, () => !!entry?.viewer),
        };
        this.sessions.set(windowId, entry);
        logger(`agentRuns: session ${session.id} attached to window ${windowId} (engine in the ${ENGINE_REALM} realm)`, 3);
        return entry.port;
    }

    /**
     * The window started closing: cancel the operations its session has
     * queued, as the window's own are. Executing ones settle; the session
     * itself is closed by `closeWindow`.
     */
    cancelQueuedWork(windowId: string): void {
        const entry = this.sessions.get(windowId);
        if (entry) Zotero.Beaver?.mutations?.cancelOwner(sessionOwner(entry.session));
    }

    /**
     * The window closed: park a run that waits only on cards, close any other
     * with 1000 (recording the interrupted chat when asked), and end the
     * session. The window's operations still queued are cancelled; executing
     * ones settle.
     */
    closeWindow(windowId: string, reason: string, options?: { rememberInterruptedThread?: boolean }): void {
        const entry = this.sessions.get(windowId);
        if (!entry) return;
        try {
            entry.session.store.set(closeWSConnectionForShutdownAtom, reason, options);
        } catch (error) {
            logger(`agentRuns: closing session ${entry.session.id} failed: ${error}`, 1);
        }
        this.endSession(entry);
    }

    /** Stop every session's run (account change, library scope loss). Sessions stay. */
    closeAll(reason: string): void {
        for (const { session } of this.sessions.values()) {
            try {
                session.agentService.close(1000, reason);
                session.store.set(abandonActiveRunLocallyAtom);
            } catch (error) {
                logger(`agentRuns: stopping session ${session.id} failed: ${error}`, 1);
            }
        }
    }

    list(): RunSessionSummary[] {
        return [...this.sessions.values()].map(({ session, windowId, viewer }) => {
            const activeRun = session.store.get(activeRunAtom);
            return {
                sessionId: session.id,
                windowId,
                viewerAttached: !!viewer,
                threadId: session.store.get(currentThreadIdAtom),
                activeRunId: activeRun?.id ?? null,
                activeRunStatus: activeRun?.status ?? null,
                pending: session.store.get(isWSChatPendingAtom),
                connected: session.store.get(isWSConnectedAtom),
                writer: !!currentWriter(session),
            };
        });
    }

    /** A session's state for diagnostics: summary values, counts for collections. */
    snapshot(sessionId: string): Record<string, unknown> | null {
        const entry = [...this.sessions.values()].find(({ session }) => session.id === sessionId);
        if (!entry) return null;
        const { store } = entry.session;
        const state: Record<string, unknown> = {};
        for (const [name, atom] of sessionStateAtoms()) state[name] = summarize(store.get(atom));
        const activeRun = store.get(activeRunAtom);
        return {
            engineRealm: ENGINE_REALM,
            ...this.list().find((summary) => summary.sessionId === sessionId),
            threadName: store.get(currentThreadNameAtom),
            runs: store.get(threadRunsAtom).map((run) => ({ id: run.id, status: run.status })),
            activeRun: activeRun
                ? { id: activeRun.id, status: activeRun.status, active: isRunActive(activeRun), messages: activeRun.model_messages.length }
                : null,
            state,
        };
    }

    /** Shut down: refuse new sessions, and close each session's run as its window would. */
    dispose(reason: string): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribeAccount?.();
        this.unsubscribeAccount = null;
        for (const entry of [...this.sessions.values()]) {
            this.closeWindow(entry.windowId, reason, { rememberInterruptedThread: true });
        }
    }

    private endSession(entry: SessionEntry): void {
        const owner = sessionOwner(entry.session);
        entry.viewer = null;
        this.sessions.delete(entry.windowId);
        Zotero.Beaver?.mutations?.cancelOwner(owner);
        Zotero.Beaver?.syncPause?.releaseOwnerRuns(owner);
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
        const references = entry.viewer?.externalReferences();
        return {
            accountGeneration: generation,
            userId: account?.getSnapshot().session?.user.id,
            onAttachmentResolved: (payload) => {
                if (entry.viewer && generation === Zotero.Beaver?.account?.getGeneration()) {
                    emitAttachmentResolved(session.agentService, payload);
                }
            },
            owner: sessionOwner(session),
            threadId: store.get(currentThreadIdAtom),
            runId,
            fullAccess: !!policy && isFullAccessGrantedForRun(policy, runId ?? null),
            preference: (tool, data) => {
                if (policy && isActionApprovedForCurrentRun(policy, runId ?? null, tool, data)) return 'always_apply';
                const prefs = loadPreferences();
                return prefs.groupPreferences[prefs.toolToGroup[tool] ?? tool] ?? 'always_ask';
            },
            externalRefs: { ...(references?.externalRefs ?? {}) },
            externalItemMapping: { ...(references?.externalItemMapping ?? {}) },
            grantCreatedNote: (libraryId, zoteroKey) => {
                if (
                    entry.viewer &&
                    runId &&
                    generation === Zotero.Beaver?.account?.getGeneration() &&
                    store.get(activeRunAtom)?.id === runId
                ) {
                    store.set(grantCreatedNoteEditsForRunAtom, { runId, libraryId, zoteroKey });
                }
            },
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
