/**
 * The instance's run sessions: one per chat, viewed by any number of windows
 * and going on with none while it has work; it ends once nothing views it and
 * it is idle. Runs stop when the account changes or a library leaves the
 * scope, and end on shutdown. A session's operations are its own, not a
 * window's, and the undos a retry asks for run in the plugin realm.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: () => ({ frontendVersion: '0.0.0-test', clientType: 'zotero-plugin', clientFeatures: [], zoteroInstance: {} }),
}));

import { AgentService } from '@beaver/agent-core/transport/agentService';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { InstanceAgentRuns } from '../../../src/services/agentRuns/registry';
import { createViewerRunHost, type RunViewer } from '../../../src/services/agentRuns/runViewer';

/** A window's viewer whose methods are `vi.fn()`s, except those given. */
function viewer(overrides: Partial<RunViewer> = {}): RunViewer {
    const methods: Record<string, unknown> = {
        externalReferences: () => ({ externalRefs: { ext: { library_id: 1, zotero_key: 'KEY' } } as any, externalItemMapping: {} }),
        getUserId: () => 'user-1',
        getModel: () => null,
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

const flush = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
};

const streaming = (id = 'run-1') => ({ id, status: 'in_progress', model_messages: [] }) as unknown as AgentRun;

describe('the instance\'s run sessions', () => {
    let runs: InstanceAgentRuns;
    let published: Array<{ name: string; detail: unknown }>;
    let fillListener: ((snapshot: unknown) => void) | null;

    beforeEach(() => {
        providerOptions.length = 0;
        published = [];
        fillListener = null;
        vi.clearAllMocks();
        (globalThis as any).Zotero.Beaver = {
            ...(beaver() ?? {}),
            searchableLibraryIds: [1, 2],
            libraryRevocations: 0,
            account: { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'user-1' } } }) },
            mutations: { cancelOwner: vi.fn() },
            syncPause: { releaseOwnerRuns: vi.fn(), scheduleResumeAfterRun: vi.fn(), cancelScheduledResume: vi.fn() },
            libraryOperations: { run: vi.fn(async () => ({})) },
            presence: undefined,
            runtime: {
                publish: (name: string, detail: unknown) => published.push({ name, detail }),
                subscribe: (_name: string, listener: (snapshot: unknown) => void) => {
                    fillListener = listener;
                    return () => { fillListener = null; };
                },
            },
        };
        runs = new InstanceAgentRuns();
    });

    afterEach(() => vi.restoreAllMocks());

    it('gives each chat one session, which every window that opens the chat views', () => {
        runs.attachWindow('window-1', viewer());
        runs.attachWindow('window-2', viewer());
        const first = runs.open('window-1', 'thread-1');
        expect(runs.open('window-2', 'thread-1').sessionId).toBe(first.sessionId);
        // A new chat is a session of its own.
        const fresh = runs.open('window-1', null);
        expect(fresh.sessionId).not.toBe(first.sessionId);
        expect(runs.list().find((entry) => entry.sessionId === first.sessionId)?.viewers).toEqual(['window-2']);
        expect(runs.sessionForThread('thread-1')?.sessionId).toBe(first.sessionId);
    });

    it('keeps a session with a run going when its window opens another chat, and ends it once the run is over', async () => {
        runs.attachWindow('window-1', viewer());
        const port = runs.open('window-1', 'thread-1');
        port.set('activeRun', streaming());
        runs.open('window-1', 'thread-2');
        await flush();
        expect(runs.sessionForThread('thread-1')?.sessionId).toBe(port.sessionId);

        port.set('activeRun', { ...streaming(), status: 'completed' });
        await flush();
        expect(runs.sessionForThread('thread-1')).toBeNull();
        expect(beaver().mutations.cancelOwner).toHaveBeenCalledWith(`run:${port.sessionId}`);
        expect(beaver().syncPause.releaseOwnerRuns).toHaveBeenCalledWith(`run:${port.sessionId}`);
    });

    it('ends an idle chat as soon as nothing views it', () => {
        runs.attachWindow('window-1', viewer());
        const port = runs.open('window-1', 'thread-1');
        runs.open('window-1', 'thread-2');
        expect(runs.sessionForThread('thread-1')).toBeNull();
        expect(runs.portOf(port.sessionId)).toBeNull();
    });

    it('lets a run go on with no window, and keeps nothing of the window that closed', async () => {
        const shown = viewer();
        runs.attachWindow('window-1', shown);
        const port = runs.open('window-1', 'thread-1');
        port.set('activeRun', streaming());

        runs.detachWindow('window-1');
        await flush();

        const [session] = runs.list();
        expect(session).toMatchObject({ sessionId: port.sessionId, viewers: [], busy: true });
        // Nothing stopped the run: its operations and sync pauses stay.
        expect(beaver().mutations.cancelOwner).not.toHaveBeenCalled();
        expect(beaver().syncPause.releaseOwnerRuns).not.toHaveBeenCalled();
        // Another window opening the chat views the same session.
        runs.attachWindow('window-2', viewer());
        expect(runs.open('window-2', 'thread-1').sessionId).toBe(port.sessionId);
    });

    it('runs a session\'s operations as its own, with its chat, run and approval policy', () => {
        runs.attachWindow('window-1', viewer());
        const port = runs.open('window-1', 'thread-1');
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
        // A window's mappings are copied, not shared.
        expect(operation.externalRefs).toEqual({ ext: { library_id: 1, zotero_key: 'KEY' } });
    });

    it('grants a created note to the run that is still running, with or without a window', () => {
        runs.attachWindow('window-1', viewer());
        const port = runs.open('window-1', 'thread-1');
        port.set('activeRun', { id: 'run-1', status: 'in_progress' } as AgentRun);
        const operation = providerOptions[0].operationContext!();

        runs.detachWindow('window-1');
        operation.grantCreatedNote(1, 'NOTE0001');
        const granted = port.get('runApprovalPolicy') as { runId: string; approvedResources: Set<string> };
        expect(granted.runId).toBe('run-1');
        expect(granted.approvedResources.size).toBe(1);

        port.set('activeRun', { id: 'run-2', status: 'in_progress' } as AgentRun);
        operation.grantCreatedNote(1, 'NOTE0002');
        expect(port.get('runApprovalPolicy')).toBe(granted);
    });

    it('refuses a run beyond its capacity, not counting a session parked on a fill', async () => {
        runs.setCapacity(2);
        runs.attachWindow('window-1', viewer());
        const notified = vi.fn();
        const ports = ['thread-1', 'thread-2', 'thread-3'].map((thread) => {
            const port = runs.acquire(`holder-${thread}`, thread);
            return port;
        });
        ports[0].set('activeRun', streaming('run-1'));
        ports[1].set('activeRun', streaming('run-2'));
        await flush();

        const third = runs.portOf(ports[2].sessionId)!;
        await third.withThreadWriter(async () => notified());
        expect(notified).not.toHaveBeenCalled();

        // The second run parks on a fill: it holds no socket and no slot.
        ports[1].set('activeRun', { ...streaming('run-2'), status: 'completed' });
        ports[1].set('jobWait', { threadId: 'thread-2', runId: 'run-2', toolCallId: 'call-1', jobId: 'job-1' });
        await flush();
        expect(runs.list().find((entry) => entry.sessionId === ports[1].sessionId)?.busy).toBe(true);
        await third.withThreadWriter(async () => notified());
        expect(notified).toHaveBeenCalledOnce();
    });

    it('reports the chats with a run going, and what they wait on, to thread lists', async () => {
        runs.attachWindow('window-1', viewer());
        const port = runs.open('window-1', 'thread-1');
        port.set('activeRun', streaming());
        await flush();
        expect(runs.listActivity()).toEqual([expect.objectContaining({ threadId: 'thread-1', sessionId: port.sessionId, awaiting: null })]);
        expect(published.at(-1)).toMatchObject({ name: 'agent-runs:activity' });

        port.set('pendingQuestions', new Map([['q1', { id: 'q1' }]]));
        await flush();
        expect(runs.listActivity()[0].awaiting).toEqual({ ask_user_question: 1 });

        port.set('pendingQuestions', new Map());
        port.set('activeRun', { ...streaming(), status: 'completed' });
        await flush();
        expect(runs.listActivity()).toEqual([]);
        expect(published.at(-1)?.detail).toEqual([]);
    });

    it('waits on the fills its runs start, and resumes when one ends, with no window', async () => {
        const resume = vi.spyOn(await import('../../../src/services/agentRuns/runEngine'), 'requestJobResume');
        runs.start(fakeAccount().account);
        runs.attachWindow('window-1', viewer());
        const port = runs.open('window-1', 'thread-1');
        // The wait the session's transport reports (its run's `job_wait_request`) becomes the session's.
        const transport = port.debugTransport() as unknown as { jobWaitListeners: Set<(wait: unknown) => void> };
        transport.jobWaitListeners.forEach((listener) => listener({ runId: 'run-1', threadId: 'thread-1', toolCallId: 'call-1', jobId: 'job-1' }));
        expect(port.get('jobWait')).toEqual({ runId: 'run-1', threadId: 'thread-1', toolCallId: 'call-1', jobId: 'job-1' });

        runs.detachWindow('window-1');
        fillListener!({ job_id: 'job-2', state: 'done' });
        expect(resume).not.toHaveBeenCalled();
        fillListener!({ job_id: 'job-1', state: 'running' });
        expect(resume).not.toHaveBeenCalled();
        fillListener!({ job_id: 'job-1', state: 'done' });
        expect(resume).toHaveBeenCalledOnce();
    });

    it('stops every session\'s run when a library leaves the scope or the account changes', () => {
        const close = vi.spyOn(AgentService.prototype, 'close').mockImplementation(() => {});
        const { account, publish } = fakeAccount();
        runs.start(account);
        runs.attachWindow('window-1', viewer());
        const port = runs.open('window-1', 'thread-1');
        port.set('activeRun', streaming());

        publish(1);
        expect(close).not.toHaveBeenCalled();

        beaver().libraryRevocations = 1;
        publish(1);
        expect(close).toHaveBeenCalledWith(1000, 'Library access changed');

        close.mockClear();
        publish(2);
        expect(close).toHaveBeenCalledWith(1000, 'Account changed');
        // The window still views its chat; only the run ended.
        expect(runs.list()).toHaveLength(1);
    });

    it('leaves runs to shutdown once it has begun', () => {
        const close = vi.spyOn(AgentService.prototype, 'close').mockImplementation(() => {});
        const { account, publish } = fakeAccount();
        runs.start(account);
        runs.attachWindow('window-1', viewer());
        runs.open('window-1', 'thread-1').set('activeRun', streaming());
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

    it('ends every session on shutdown, with no window too, and starts none afterwards', () => {
        runs.attachWindow('window-1', viewer());
        runs.open('window-1', 'thread-1');
        runs.acquire('api:1', null).set('activeRun', streaming());

        runs.dispose('Beaver plugin shutting down');

        expect(runs.list()).toEqual([]);
        expect(() => runs.open('window-1', null)).toThrow(/shut down/);
        expect(runs.submit({ text: 'Hello', origin: { kind: 'api', label: 'test' } })).toEqual({ error: 'shut_down' });
    });

    it('starts a run with no window, refusing one it may not start', () => {
        beaver().account.getSnapshot = () => ({ session: null });
        expect(runs.submit({ text: 'Hello', origin: { kind: 'api', label: 'test' } })).toEqual({ error: 'not_signed_in' });
        beaver().account.getSnapshot = () => ({ session: { user: { id: 'user-1' } } });
        expect(runs.submit({ text: '  ', origin: { kind: 'api', label: 'test' } })).toEqual({ error: 'empty' });
        runs.setCapacity(1);
        runs.acquire('holder', 'thread-1').set('activeRun', streaming());
        expect(runs.submit({ text: 'Hello', origin: { kind: 'api', label: 'test' } })).toMatchObject({ error: 'capacity' });
        expect(runs.list()).toHaveLength(1);
    });

    it('starts a windowless run with only the items in the searchable scope, every write waiting for approval', async () => {
        const connect = vi.spyOn(AgentService.prototype, 'connect').mockResolvedValue(undefined as never);
        // The personal library is 1; the group the references name is not on this device.
        const zotero = (globalThis as any).Zotero;
        const { Libraries, Groups } = zotero;
        zotero.Libraries = { ...Libraries, userLibraryID: 1 };
        zotero.Groups = { getLibraryIDFromGroupID: () => false };
        onTestFinished(() => Object.assign(zotero, { Libraries, Groups }));
        beaver().account.getSnapshot = () => ({ session: { user: { id: 'user-1' } } });
        const { sessionId } = runs.submit({
            text: 'Summarize these',
            attachments: [
                // Sent as the bare reference, without what the caller added to it.
                { type: 'source', library_id: 1, library_ref: 'u', zotero_key: 'KEEPKEY1', parent_item: { library_id: 9, zotero_key: 'EXCLUDED' }, custom_content: 'x' },
                // Named by its portable reference only: a group outside the scope.
                { type: 'saved_search', library_ref: 'g999', zotero_key: 'DROPKEY1' },
                // Its reference names a library other than its stale numeric id.
                { type: 'source', library_id: 1, library_ref: 'g999', zotero_key: 'DROPKEY2' },
                { type: 'item', library_id: 2, zotero_key: 'KEEPKEY2' },
                // Other kinds carry their library elsewhere, or none: left out.
                { type: 'table', reference: { key: 'g999-TABLE001' } },
                { type: 'external_file', ext_key: 'file-1' },
            ] as any[],
            origin: { kind: 'api', label: 'test' },
        }) as { sessionId: string };
        await vi.waitFor(() => expect(connect).toHaveBeenCalled());
        // Busy, as a window's send leaves it: a window that opens the chat shows Stop.
        expect(runs.portOf(sessionId)!.get('isWSChatPending')).toBe(true);
        const request = connect.mock.calls[0][0] as { user_prompt: { attachments: Array<{ zotero_key?: string; ext_key?: string }> } };
        expect(request.user_prompt.attachments).toEqual([
            { type: 'source', library_id: 1, zotero_key: 'KEEPKEY1', library_ref: 'u' },
            { type: 'item', library_id: 2, zotero_key: 'KEEPKEY2', library_ref: undefined },
        ]);

        const operation = providerOptions.at(-1)!.operationContext!();
        expect(operation.preference('create_note', {})).toBe('always_ask');
        expect(operation.fullAccess).toBe(false);
        // Approving a note it created grants nothing further.
        operation.grantCreatedNote(1, 'NOTE0001');
        expect(runs.portOf(sessionId)!.get('runApprovalPolicy')).toMatchObject({ approvedResources: new Set() });
    });

    it('keeps the reference mappings of a window that stops showing a running chat', () => {
        runs.attachWindow('window-1', viewer());
        const port = runs.open('window-1', 'thread-1');
        port.set('activeRun', streaming());
        runs.detachWindow('window-1');

        const operation = providerOptions[0].operationContext!();
        expect(operation.externalRefs).toEqual({ ext: { library_id: 1, zotero_key: 'KEY' } });
    });

    it('reports a session\'s state for diagnostics', () => {
        runs.attachWindow('window-1', viewer());
        const port = runs.open('window-1', 'thread-1');
        const snapshot = runs.snapshot(port.sessionId)!;
        expect(snapshot).toMatchObject({ sessionId: port.sessionId, viewers: ['window-1'], threadId: 'thread-1' });
        expect(runs.snapshot('missing')).toBeNull();
    });
});

describe('the host of a session', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Beaver = {
            ...(beaver() ?? {}),
            account: { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'account-user' } } }) },
            libraryOperations: { run: vi.fn(async () => ({})) },
        };
    });

    /** A host for `viewers`, the first of them the window that started the run. */
    function hostFor(viewers: RunViewer[], options: { origin?: RunViewer | null; openChat?: () => void } = {}) {
        return createViewerRunHost({
            viewers: () => viewers,
            origin: () => (options.origin === undefined ? viewers[0] ?? null : options.origin),
            issuer: () => null,
            owner: () => 'run:s1',
            threadId: () => 'thread-1',
            live: () => true,
            model: () => ({ id: 'session-model' }) as any,
            openChat: options.openChat,
        });
    }

    it('does without a window: inputs fall back to the session\'s, effects are dropped', async () => {
        const host = hostFor([]);
        expect(host.getUserId()).toBe('account-user');
        expect(host.getModel()).toEqual({ id: 'session-model' });
        expect(host.agentActions()).toEqual([]);
        expect(host.navigationSeq()).toBe(0);
        expect(host.confirmUndo([], [])).toBe('cancel');
        const part = { part_kind: 'tool-return' } as any;
        expect(await host.upgradeToolReturn(part, null)).toBe(part);
    });

    it('notifies once however many windows show the run, for the window that shows it', () => {
        const win = { closed: false } as unknown as Window;
        const first = viewer({ hostWindow: () => win, sidebarVisible: () => true });
        const second = viewer({ hostWindow: () => null });
        const host = hostFor([first, second]);
        const event = { action_id: 'a1' } as any;

        host.approvalRequested(event, { silent: false });
        host.approvalRequested(event, { silent: true });
        host.notifyRunComplete();

        expect(notify.notifyApprovalRequest).toHaveBeenCalledOnce();
        expect(notify.notifyRunComplete).toHaveBeenCalledOnce();
        // Every window refreshes what the approval changes.
        expect(first.approvalRequested).toHaveBeenCalledTimes(2);
        expect(second.approvalRequested).toHaveBeenCalledTimes(2);
        const [target] = notify.notifyApprovalRequest.mock.calls[0] as unknown as [{ hostWindow(): Window | null; sidebarVisible(): boolean }];
        expect(target.hostWindow()).toBe(win);
        expect(target.sidebarVisible()).toBe(true);
    });

    it('notifies for a run no window shows, opening its chat when clicked', () => {
        const main = { closed: false } as unknown as Window;
        (globalThis as any).Zotero.getMainWindow = () => main;
        const openChat = vi.fn();
        const host = hostFor([], { openChat });

        host.notifyRunComplete();

        expect(notify.notifyRunComplete).toHaveBeenCalledOnce();
        const [target] = notify.notifyRunComplete.mock.calls[0] as unknown as [{ hostWindow(): Window | null; open(): void }];
        expect(target.hostWindow()).toBe(main);
        target.open();
        expect(openChat).toHaveBeenCalledOnce();
    });

    it('applies a run\'s annotations and opens its table only in the window that started it', async () => {
        const origin = viewer();
        const other = viewer();
        const host = hostFor([other, origin], { origin });

        await host.prepareAgentActions('run-1', []);
        host.openCreatedTable('u-TABLE001', 'run-1', 'call-1');

        expect(origin.prepareAgentActions).toHaveBeenCalledExactlyOnceWith('run-1', [], true);
        expect(other.prepareAgentActions).not.toHaveBeenCalled();
        expect(origin.openCreatedTable).toHaveBeenCalledOnce();
        expect(other.openCreatedTable).not.toHaveBeenCalled();

        // With the window that started it gone, another loads the item data,
        // and no window applies annotations or opens the table.
        const orphaned = hostFor([other], { origin: null });
        await orphaned.prepareAgentActions('run-1', []);
        orphaned.openCreatedTable('u-TABLE001', 'run-1', 'call-1');
        expect(other.prepareAgentActions).toHaveBeenCalledExactlyOnceWith('run-1', [], false);
        expect(other.openCreatedTable).not.toHaveBeenCalled();
    });

    it('undoes a retry\'s applied actions as the session\'s library operations, newest first', async () => {
        const host = hostFor([viewer()]);
        const older = { id: 'a1', action_type: 'edit_note', status: 'applied', created_at: '2026-01-01T00:00:00Z', proposed_data: {} } as any;
        const newer = { id: 'a2', action_type: 'create_note', status: 'applied', created_at: '2026-01-02T00:00:00Z', proposed_data: {} } as any;

        await host.undoAppliedActions([older, newer]);

        const run = beaver().libraryOperations.run as ReturnType<typeof vi.fn>;
        expect(run.mock.calls.map((call) => call[0])).toEqual(['undoCreateNoteAction', 'undoEditNoteAction']);
        expect(run.mock.calls[0][2]).toMatchObject({ owner: 'run:s1' });
        expect(run.mock.calls[1][1][1]).toMatchObject({ threadId: 'thread-1', externalRefs: { ext: { library_id: 1, zotero_key: 'KEY' } } });
    });
});
