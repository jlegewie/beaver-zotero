/**
 * The instance's run sessions: one per chat window, ended when the window
 * closes, stopped when the account changes or a library leaves the scope,
 * and closed on shutdown. A session's operations are its own, not its
 * window's, and the undos a retry asks for run in the plugin realm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { providerOptions, notify } = vi.hoisted(() => ({
    providerOptions: [] as Array<{ operationContext?: () => any }>,
    notify: {
        notifyApprovalRequest: vi.fn(),
        notifyBatchApproval: vi.fn(),
        notifyCreditConfirmation: vi.fn(),
        notifyRunComplete: vi.fn(),
        notifyUserQuestion: vi.fn(),
    },
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({ supabase: { auth: {} } }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/zoteroDataProvider', () => ({
    createZoteroDataProvider: (options: { operationContext?: () => any }) => {
        providerOptions.push(options);
        return {};
    },
}));
vi.mock('../../../src/services/deferredToolPolicy', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    loadPreferences: () => ({ groupPreferences: {}, toolToGroup: {} }),
}));
vi.mock('../../../src/services/systemNotifications', () => notify);

import { AgentService } from '@beaver/agent-core/transport/agentService';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { InstanceAgentRuns } from '../../../src/services/agentRuns/registry';
import { createViewerRunHost, type RunViewer } from '../../../src/services/agentRuns/runViewer';

/** A window's viewer whose methods are `vi.fn()`s, except those given. */
function viewer(overrides: Partial<RunViewer> = {}): RunViewer {
    const methods: Record<string, unknown> = {
        externalReferences: () => ({ externalRefs: { ext: { library_id: 1, zotero_key: 'KEY' } } as any, externalItemMapping: {} }),
        getUserId: () => 'user-1',
        navigationSeq: () => 3,
        hostWindow: () => null,
        sidebarVisible: () => false,
        ...overrides,
    };
    return new Proxy({} as RunViewer, {
        get: (_target, name) => (typeof name === 'symbol' || name === 'then' ? undefined : (methods[name] ??= vi.fn())),
    });
}

function fakeAccount() {
    let listener: ((snapshot: { generation: number }) => void) | null = null;
    return {
        account: { subscribe: (next: typeof listener) => { listener = next; next!({ generation: 1 }); return () => { listener = null; }; } } as any,
        publish: (generation: number) => listener?.({ generation }),
    };
}

const beaver = () => (globalThis as any).Zotero.Beaver;

describe('the instance\'s run sessions', () => {
    let runs: InstanceAgentRuns;

    beforeEach(() => {
        providerOptions.length = 0;
        vi.clearAllMocks();
        (globalThis as any).Zotero.Beaver = {
            ...(beaver() ?? {}),
            searchableLibraryIds: [1, 2],
            libraryRevocations: 0,
            account: { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'user-1' } } }) },
            mutations: { cancelOwner: vi.fn() },
            syncPause: { releaseOwnerRuns: vi.fn() },
            libraryOperations: { run: vi.fn(async () => ({})) },
        };
        runs = new InstanceAgentRuns();
    });

    afterEach(() => vi.restoreAllMocks());

    it('gives each chat window one session, kept for every attach', () => {
        const first = runs.attachWindow('window-1', viewer());
        expect(runs.attachWindow('window-1', viewer()).sessionId).toBe(first.sessionId);
        const second = runs.attachWindow('window-2', viewer());
        expect(second.sessionId).not.toBe(first.sessionId);
        expect(runs.list().map((entry) => entry.windowId)).toEqual(['window-1', 'window-2']);
    });

    it('runs a session\'s operations as its own, with its chat, run and approval policy', () => {
        const port = runs.attachWindow('window-1', viewer());
        port.set('currentThreadId', 'thread-1');
        port.set('activeRun', { id: 'run-1', status: 'in_progress' } as AgentRun);
        port.set('runApprovalPolicy', { runId: 'run-1', fullAccess: true, approvedResources: new Set() });

        const operation = providerOptions[0].operationContext!();
        expect(operation).toMatchObject({
            owner: `run:${port.sessionId}`,
            threadId: 'thread-1',
            runId: 'run-1',
            fullAccess: true,
            accountGeneration: 1,
            userId: 'user-1',
        });
        // The window's mappings are copied, not shared.
        expect(operation.externalRefs).toEqual({ ext: { library_id: 1, zotero_key: 'KEY' } });
    });

    it('grants a created note to the run that is still running, and only while its window is open', () => {
        const port = runs.attachWindow('window-1', viewer());
        port.set('activeRun', { id: 'run-1', status: 'in_progress' } as AgentRun);
        const operation = providerOptions[0].operationContext!();

        operation.grantCreatedNote(1, 'NOTE0001');
        const granted = port.get('runApprovalPolicy') as { runId: string; approvedResources: Set<string> };
        expect(granted.runId).toBe('run-1');
        expect(granted.approvedResources.size).toBe(1);

        runs.closeWindow('window-1', 'Main window closed');
        operation.grantCreatedNote(1, 'NOTE0002');
        expect(port.get('runApprovalPolicy')).toBe(granted);
    });

    it('ends a closing window\'s session: its queued operations and sync pauses go with it', () => {
        const leave = vi.fn();
        const port = runs.attachWindow('window-1', viewer({ leaveJobWaitOnClose: leave }));

        runs.closeWindow('window-1', 'Main window closed', { rememberInterruptedThread: true });

        expect(leave).toHaveBeenCalledOnce();
        expect(runs.list()).toEqual([]);
        expect(beaver().mutations.cancelOwner).toHaveBeenCalledWith(`run:${port.sessionId}`);
        expect(beaver().syncPause.releaseOwnerRuns).toHaveBeenCalledWith(`run:${port.sessionId}`);
        // A later attach of the same window starts a new session.
        expect(runs.attachWindow('window-1', viewer()).sessionId).not.toBe(port.sessionId);
    });

    it('cancels a closing window\'s queued operations ahead of closing its session', () => {
        const port = runs.attachWindow('window-1', viewer());
        runs.cancelQueuedWork('window-1');
        expect(beaver().mutations.cancelOwner).toHaveBeenCalledExactlyOnceWith(`run:${port.sessionId}`);
        expect(runs.list()).toHaveLength(1);
    });

    it('stops every session\'s run when a library leaves the scope or the account changes', () => {
        const close = vi.spyOn(AgentService.prototype, 'close').mockImplementation(() => {});
        const { account, publish } = fakeAccount();
        runs.start(account);
        const port = runs.attachWindow('window-1', viewer());
        port.set('activeRun', { id: 'run-1', status: 'in_progress', model_messages: [] } as unknown as AgentRun);

        publish(1);
        expect(close).not.toHaveBeenCalled();

        beaver().libraryRevocations = 1;
        publish(1);
        expect(close).toHaveBeenCalledWith(1000, 'Library access changed');

        close.mockClear();
        publish(2);
        expect(close).toHaveBeenCalledWith(1000, 'Account changed');
        // Sessions stay for their windows; only their runs ended.
        expect(runs.list()).toHaveLength(1);
    });

    it('leaves each session to its window\'s unload once shutdown has begun', () => {
        const close = vi.spyOn(AgentService.prototype, 'close').mockImplementation(() => {});
        const { account, publish } = fakeAccount();
        runs.start(account);
        runs.attachWindow('window-1', viewer());
        (globalThis as any).Zotero.__beaverShuttingDown = true;
        try {
            // Disposing the account at a quit revokes it.
            publish(2);
            expect(close).not.toHaveBeenCalled();
            expect(runs.list()).toHaveLength(1);
        } finally {
            (globalThis as any).Zotero.__beaverShuttingDown = false;
        }
    });

    it('closes every session on shutdown and starts none afterwards', () => {
        const leave = vi.fn();
        runs.attachWindow('window-1', viewer({ leaveJobWaitOnClose: leave }));
        runs.attachWindow('window-2', viewer({ leaveJobWaitOnClose: leave }));

        runs.dispose('Beaver plugin shutting down');

        expect(runs.list()).toEqual([]);
        expect(leave).toHaveBeenCalledTimes(2);
        expect(() => runs.attachWindow('window-3', viewer())).toThrow(/shut down/);
    });

    it('reports a session\'s state for diagnostics', () => {
        const port = runs.attachWindow('window-1', viewer());
        port.set('currentThreadId', 'thread-1');
        const snapshot = runs.snapshot(port.sessionId)!;
        expect(snapshot).toMatchObject({ sessionId: port.sessionId, windowId: 'window-1', threadId: 'thread-1' });
        expect(runs.snapshot('missing')).toBeNull();
    });
});

describe('the host of a session that runs for a window', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Beaver = {
            ...(beaver() ?? {}),
            account: { getGeneration: () => 1 },
            libraryOperations: { run: vi.fn(async () => ({})) },
        };
    });

    it('does without its window once it is gone: inputs read empty, effects are dropped', async () => {
        const host = createViewerRunHost(() => 'window-1', () => null, { owner: () => 'run:s', threadId: () => null });
        expect(host.windowId()).toBeUndefined();
        expect(host.getUserId()).toBeNull();
        expect(host.agentActions()).toEqual([]);
        expect(host.navigationSeq()).toBe(-1);
        expect(host.confirmUndo([], [])).toBe('cancel');
        const part = { part_kind: 'tool-return' } as any;
        expect(await host.upgradeToolReturn(part, null)).toBe(part);
        // Nothing left to show a notification for.
        host.notifyRunComplete();
        host.approvalRequested({ action_id: 'a1' } as any, { silent: false });
        expect(notify.notifyRunComplete).not.toHaveBeenCalled();
        expect(notify.notifyApprovalRequest).not.toHaveBeenCalled();
    });

    it('decides notifications itself, once, for the window that shows the run', () => {
        const win = { closed: false } as unknown as Window;
        let shown: RunViewer | null = viewer({ hostWindow: () => win, sidebarVisible: () => true });
        const host = createViewerRunHost(() => 'window-1', () => shown, { owner: () => 'run:s', threadId: () => null });
        const event = { action_id: 'a1' } as any;

        host.approvalRequested(event, { silent: false });
        host.approvalRequested(event, { silent: true });
        host.notifyRunComplete();

        expect(notify.notifyApprovalRequest).toHaveBeenCalledOnce();
        expect(notify.notifyRunComplete).toHaveBeenCalledOnce();
        expect(shown!.approvalRequested).toHaveBeenCalledTimes(2);
        // The target reads the window when a notification is shown or
        // clicked, so one queued meanwhile finds it gone with its session.
        const [target] = notify.notifyApprovalRequest.mock.calls[0] as unknown as [{ hostWindow(): Window | null; sidebarVisible(): boolean }];
        expect(target.hostWindow()).toBe(win);
        expect(target.sidebarVisible()).toBe(true);
        shown = null;
        expect(target.hostWindow()).toBeNull();
    });

    it('undoes a retry\'s applied actions as the session\'s library operations, newest first', async () => {
        const shown = viewer();
        const host = createViewerRunHost(() => 'window-1', () => shown, { owner: () => 'run:s1', threadId: () => 'thread-1' });
        const older = { id: 'a1', action_type: 'edit_note', status: 'applied', created_at: '2026-01-01T00:00:00Z', proposed_data: {} } as any;
        const newer = { id: 'a2', action_type: 'create_note', status: 'applied', created_at: '2026-01-02T00:00:00Z', proposed_data: {} } as any;

        await host.undoAppliedActions([older, newer]);

        const run = beaver().libraryOperations.run as ReturnType<typeof vi.fn>;
        expect(run.mock.calls.map((call) => call[0])).toEqual(['undoCreateNoteAction', 'undoEditNoteAction']);
        expect(run.mock.calls[0][2]).toMatchObject({ owner: 'run:s1' });
        expect(run.mock.calls[1][1][1]).toMatchObject({ threadId: 'thread-1', externalRefs: { ext: { library_id: 1, zotero_key: 'KEY' } } });
    });
});
