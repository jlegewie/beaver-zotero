/**
 * Live tests for runs that lose their socket and reconnect within seconds.
 *
 * Each test drives a real agent run through the headless chat endpoints
 * (`chat-send`, `approve-action`, `current-ids`, `load-thread`, …) and drops
 * its socket with `/beaver/test/chat-drop-connection`, either at once or at a
 * chosen moment of the next backend request (`after_next_write`,
 * `during_next_read`). They check what reconnecting must never break: the run
 * ends as it would have without the drop, its saved answer matches what was
 * streamed (nothing duplicated or missing), every write is applied exactly
 * once, and only an explicit Stop ends the run as cancelled.
 *
 * These runs hit the real backend and model and bill real credits, so the
 * suite only runs with `BEAVER_LIVE_AGENT_RUNS=1`:
 *
 *   BEAVER_LIVE_AGENT_RUNS=1 ZOTERO_HTTP_PORT=<port> \
 *     npx vitest run --config vitest.live.config.ts tests/live/runReattach.live.test.ts
 *
 * Prerequisites: a logged-in dev build against a backend that reattaches runs,
 * the composer in "Ask permission" mode (the default after a reload), and the
 * user library searchable.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';

const ENABLED = process.env.BEAVER_LIVE_AGENT_RUNS === '1';
const RUN_TIMEOUT_MS = 240_000;

/** Long enough that a drop lands while the model is still writing. */
const LONG_ANSWER =
    'Without using any tools, write about 350 words on the history of public libraries, '
    + 'in plain paragraphs.';

/** Long enough that the stop, delivered after the reconnect, lands mid-answer. */
const VERY_LONG_ANSWER =
    'Without using any tools, write about 1500 words on the history of public libraries, '
    + 'in plain paragraphs.';

interface RunSummary {
    id: string;
    status: string;
    errorType: string | null;
    reasonCode: string | null;
    text: string;
    toolCalls: Array<{ id: string; name: string }>;
    toolReturns: string[];
}

interface RunEvent {
    at: number;
    runId: string;
    kind: 'detached' | 'reattached' | 'reattach_failed' | 'reply_from_memory' | 'undelivered_actions';
    detail?: string;
}

interface Snapshot {
    ok: boolean;
    threadId: string | null;
    runs: RunSummary[];
    runEvents: RunEvent[];
    armedDrop: string | null;
    collectionCount: number | null;
    noteCount: number | null;
}

interface Ids {
    ok: boolean;
    error?: string;
    threadId: string | null;
    activeRunId: string | null;
    activeRunStatus: string | null;
    activeRunError: { type: string } | null;
    isPending: boolean;
    isReconnecting: boolean;
    reattachResolution: { runId: string } | null;
    resolutionView: 'checking' | 'still_running' | null;
    replacementNotes: Record<string, string>;
    admission: { state: string; reason: string | null; unreachable: boolean } | null;
    transport: { connected: boolean; run: { state: string } | null };
    lastRunId: string | null;
    pendingApprovals: Array<{ actionId: string; actionType: string }>;
    pendingQuestionIds: string[];
    settle?: string | null;
}

function call<T = Ids>(name: string, body: Record<string, unknown> = {}, timeout = 30_000): Promise<T> {
    return post<T>(`/beaver/test/${name}`, body, { timeout });
}

const ids = () => call<Ids>('current-ids');
const snapshot = (body: Record<string, unknown> = {}) => call<Snapshot>('run-snapshot', body);

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `read` until `done` holds; fails with the last value after `timeoutMs`. */
async function waitFor<T>(
    label: string,
    read: () => Promise<T>,
    done: (value: T) => boolean,
    timeoutMs = RUN_TIMEOUT_MS,
    intervalMs = 300,
): Promise<T> {
    const start = Date.now();
    let last: T = await read();
    while (!done(last)) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last).slice(0, 2000)}`);
        }
        await sleep(intervalMs);
        last = await read();
    }
    return last;
}

/** Wait until the open chat is quiet: no run, no reconnect, no admission wait. */
function waitUntilQuiet(label = 'the run to settle', timeoutMs = RUN_TIMEOUT_MS): Promise<Ids> {
    return waitFor(label, ids, (state) =>
        !state.isPending
        && !state.isReconnecting
        && state.reattachResolution === null
        && (state.admission === null || state.admission.state === 'idle'),
    timeoutMs);
}

/** Wait for a pending write approval. */
function waitForApproval(): Promise<Ids> {
    return waitFor('an approval', ids, (state) => state.pendingApprovals.length > 0 || !state.isPending);
}

function eventsFor(snap: Snapshot, runId: string): RunEvent['kind'][] {
    return snap.runEvents.filter((event) => event.runId === runId).map((event) => event.kind);
}

function runOf(snap: Snapshot, runId: string): RunSummary {
    const run = snap.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Run ${runId} not in snapshot: ${snap.runs.map((r) => r.id).join(', ')}`);
    return run;
}

function normalized(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** The runs as the server saved them: reopen the thread from history. */
async function serverRuns(threadId: string): Promise<Snapshot & { actions: Array<{ id: string; action_type: string; status: string }> }> {
    await call('new-thread');
    const loaded = await call<Ids & { loaded: boolean; actions: Array<{ id: string; action_type: string; status: string }> }>(
        'load-thread', { threadId }, 60_000,
    );
    expect(loaded.ok).toBe(true);
    const snap = await snapshot();
    return { ...snap, actions: loaded.actions };
}

/** Send and wait until the run has streamed some text. */
async function sendAndWaitForText(text: string, minChars = 120): Promise<string> {
    const sent = await call<Ids>('chat-send', { text, newThread: true, waitForDone: false }, 60_000);
    expect(sent.ok, sent.error).toBe(true);
    const state = await waitFor('the run to start', ids, (current) => current.activeRunId !== null);
    const runId = state.activeRunId!;
    await waitFor(
        'streamed text',
        () => snapshot(),
        (snap) => (snap.runs.find((run) => run.id === runId)?.text.length ?? 0) >= minChars,
        120_000,
        150,
    );
    return runId;
}

/** Ask for a collection that needs approval; returns the run and the approval. */
async function proposeCollection(name: string): Promise<{ runId: string; actionId: string }> {
    const sent = await call<Ids>('chat-send', {
        text: `Create a new top-level collection named "${name}" in my library. Do nothing else and do not ask me anything.`,
        newThread: true,
        waitForDone: false,
    }, 60_000);
    expect(sent.ok, sent.error).toBe(true);
    const state = await waitForApproval();
    expect(state.pendingApprovals, 'expected create_collection to ask for approval').toHaveLength(1);
    expect(state.pendingApprovals[0].actionType).toBe('create_collection');
    return { runId: state.activeRunId!, actionId: state.pendingApprovals[0].actionId };
}

let zoteroAvailable = false;
/** Collections created by a test, undone afterwards. */
const appliedActions: string[] = [];

beforeAll(async () => {
    if (!ENABLED) return;
    zoteroAvailable = await isZoteroAvailable();
});

beforeEach((ctx) => {
    if (!ENABLED) {
        ctx.skip();
        return;
    }
    skipIfNoZotero(ctx, zoteroAvailable);
});

afterEach(async () => {
    if (!ENABLED || !zoteroAvailable) return;
    await call('chat-drop-connection', { disarm: true }).catch(() => {});
    // A failed test can leave a run going; stop it so the next test starts clean.
    const state = await ids().catch(() => null);
    if (state?.isPending) await call('chat-stop').catch(() => {});
    for (const actionId of appliedActions.splice(0)) {
        await call('undo-action', { actionId }).catch(() => {});
    }
});

describe.sequential('run reattach after a short drop', () => {
    it('reattaches a run dropped while it streams text and saves the answer once', async () => {
        const runId = await sendAndWaitForText(LONG_ANSWER);
        const drop = await call<{ ok: boolean; error?: string }>('chat-drop-connection', {});
        expect(drop.ok, drop.error).toBe(true);

        const settled = await waitUntilQuiet();
        const local = await snapshot();
        expect(eventsFor(local, runId)).toEqual(expect.arrayContaining(['detached', 'reattached']));
        expect(eventsFor(local, runId)).not.toContain('reattach_failed');
        expect(runOf(local, runId).status).toBe('completed');

        const saved = await serverRuns(settled.threadId!);
        const savedRun = runOf(saved, runId);
        expect(savedRun.status).toBe('completed');
        expect(normalized(savedRun.text)).toBe(normalized(runOf(local, runId).text));
        expect(normalized(savedRun.text).length).toBeGreaterThan(400);
    }, RUN_TIMEOUT_MS * 2);

    it('answers a read request re-sent after the reattach from memory', async () => {
        const armed = await call<{ ok: boolean }>('chat-drop-connection', { when: 'during_next_read' });
        expect(armed.ok).toBe(true);
        const sent = await call<Ids>('chat-send', {
            text: 'Search my library for items about "science" and tell me in one sentence how many you found.',
            newThread: true,
            waitForDone: false,
        }, 60_000);
        expect(sent.ok, sent.error).toBe(true);
        const running = await waitFor('the run to start', ids, (state) => state.activeRunId !== null);
        const runId = running.activeRunId!;

        const settled = await waitUntilQuiet();
        const local = await snapshot();
        expect(local.armedDrop, 'the run made no read request').toBeNull();
        const events = eventsFor(local, runId);
        expect(events).toEqual(expect.arrayContaining(['detached', 'reattached', 'reply_from_memory']));
        expect(events).not.toContain('reattach_failed');
        expect(runOf(local, runId).status).toBe('completed');

        const saved = await serverRuns(settled.threadId!);
        const savedRun = runOf(saved, runId);
        expect(savedRun.status).toBe('completed');
        // Every tool call got exactly one answer.
        for (const toolCall of savedRun.toolCalls) {
            expect(savedRun.toolReturns.filter((id) => id === toolCall.id)).toHaveLength(1);
        }
        expect(normalized(savedRun.text)).toBe(normalized(runOf(local, runId).text));
    }, RUN_TIMEOUT_MS * 2);

    it('keeps an approval through the drop and applies it once afterwards', async () => {
        const name = `reattach-approval-${Date.now()}`;
        const { runId, actionId } = await proposeCollection(name);

        const drop = await call<{ ok: boolean; error?: string }>('chat-drop-connection', {});
        expect(drop.ok, drop.error).toBe(true);
        await waitFor('the reattach', snapshot, (snap) => eventsFor(snap, runId).includes('reattached'), 60_000);
        const state = await ids();
        expect(state.pendingApprovals.map((approval) => approval.actionId)).toEqual([actionId]);

        await call('approve-action', { actionId, waitForDone: true, timeoutMs: RUN_TIMEOUT_MS }, RUN_TIMEOUT_MS);
        appliedActions.push(actionId);
        const settled = await waitUntilQuiet();

        expect((await snapshot({ countCollectionsNamed: name })).collectionCount).toBe(1);
        const saved = await serverRuns(settled.threadId!);
        expect(runOf(saved, runId).status).toBe('completed');
        expect(saved.actions.find((action) => action.id === actionId)?.status).toBe('applied');
    }, RUN_TIMEOUT_MS * 2);

    it('delivers an approval given during the drop once the run is reattached', async () => {
        const name = `reattach-held-${Date.now()}`;
        const { runId, actionId } = await proposeCollection(name);

        const drop = await call<{ ok: boolean; error?: string }>('chat-drop-connection', { holdMs: 4000 });
        expect(drop.ok, drop.error).toBe(true);
        const during = await ids();
        expect(during.isReconnecting).toBe(true);
        await call('approve-action', { actionId });
        appliedActions.push(actionId);

        const settled = await waitUntilQuiet();
        const local = await snapshot({ countCollectionsNamed: name });
        expect(eventsFor(local, runId)).toEqual(expect.arrayContaining(['detached', 'reattached']));
        expect(eventsFor(local, runId)).not.toContain('reattach_failed');
        expect(local.collectionCount).toBe(1);

        const saved = await serverRuns(settled.threadId!);
        expect(runOf(saved, runId).status).toBe('completed');
        expect(saved.actions.find((action) => action.id === actionId)?.status).toBe('applied');
    }, RUN_TIMEOUT_MS * 2);

    it('applies a write once when the socket drops before its result is sent', async () => {
        const name = `reattach-write-${Date.now()}`;
        const { runId, actionId } = await proposeCollection(name);

        await call('chat-drop-connection', { when: 'after_next_write' });
        await call('approve-action', { actionId });
        appliedActions.push(actionId);

        const settled = await waitUntilQuiet();
        const local = await snapshot({ countCollectionsNamed: name });
        expect(local.armedDrop).toBeNull();
        const events = eventsFor(local, runId);
        expect(events).toEqual(expect.arrayContaining(['detached', 'reattached', 'reply_from_memory']));
        expect(events).not.toContain('reattach_failed');
        expect(local.collectionCount).toBe(1);

        // The server received the result: the run went on and saved the action.
        const saved = await serverRuns(settled.threadId!);
        expect(runOf(saved, runId).status).toBe('completed');
        expect(saved.actions.find((action) => action.id === actionId)?.status).toBe('applied');
    }, RUN_TIMEOUT_MS * 2);

    it('shows a stop during the drop at once and ends the run as cancelled by the user', async () => {
        // Long enough that the server is still writing when the stop arrives.
        const runId = await sendAndWaitForText(VERY_LONG_ANSWER, 60);
        await call('chat-drop-connection', { holdMs: 3000 });
        const stopped = await call<Ids>('chat-stop');
        const afterStop = await snapshot();
        expect(runOf(afterStop, runId).status).toBe('canceled');
        expect(stopped.isPending).toBe(false);
        expect(stopped.admission?.reason).toBe('stop_unconfirmed');

        const settled = await waitUntilQuiet();
        const saved = await serverRuns(settled.threadId!);
        const savedRun = runOf(saved, runId);
        if (savedRun.status === 'completed') {
            // The server finished before the stop reached it.
            expect(settled.replacementNotes[runId]).toMatch(/before your stop reached it/);
        } else {
            expect(savedRun.status).toBe('canceled');
            expect(savedRun.reasonCode).toBe('client_cancel');
        }
    }, RUN_TIMEOUT_MS * 2);

    it('survives a second drop while the first is being reattached', async () => {
        const runId = await sendAndWaitForText(LONG_ANSWER);
        await call('chat-drop-connection', {});
        // Drop again as soon as a new socket is open, before or right after
        // the server confirms the reattach.
        const deadline = Date.now() + 30_000;
        let second: { ok: boolean } = { ok: false };
        while (!second.ok && Date.now() < deadline) {
            second = await call<{ ok: boolean }>('chat-drop-connection', {});
            if (!second.ok) await sleep(50);
        }
        expect(second.ok, 'no new socket to drop').toBe(true);

        const settled = await waitUntilQuiet();
        const local = await snapshot();
        const events = eventsFor(local, runId);
        // A second drop before the server confirmed the reattach is retried
        // by the reattach loop; one after it detaches the run again.
        expect(events.filter((kind) => kind === 'detached').length).toBeGreaterThanOrEqual(1);
        expect(events).toContain('reattached');
        expect(events).not.toContain('reattach_failed');
        expect(runOf(local, runId).status).toBe('completed');

        const saved = await serverRuns(settled.threadId!);
        expect(normalized(runOf(saved, runId).text)).toBe(normalized(runOf(local, runId).text));
    }, RUN_TIMEOUT_MS * 2);

    it('resolves a refused reattach without a red card that is later replaced', async () => {
        const runId = await sendAndWaitForText(LONG_ANSWER, 60);
        await call('chat-drop-connection', { badToken: true });

        // Sample what the run's card shows until the chat settles.
        const samples: Ids[] = [];
        await waitFor('the resolution', async () => {
            const state = await ids();
            samples.push(state);
            return state;
        }, (state) =>
            !state.isPending
            && state.reattachResolution === null
            && (state.admission === null || state.admission.state === 'idle'));
        const local = await snapshot();
        expect(eventsFor(local, runId)).toContain('reattach_failed');

        const final = runOf(local, runId);
        expect(['completed', 'canceled']).toContain(final.status);
        // No sample showed the connection error card while the outcome was
        // still being resolved.
        const redCard = samples.filter((state) =>
            state.activeRunId === runId
            && state.activeRunStatus === 'error'
            && state.resolutionView === null,
        );
        expect(redCard, 'the error card was shown before the outcome').toHaveLength(0);
        if (final.status === 'completed') {
            expect(samples.at(-1)!.replacementNotes[runId]).toMatch(/while you were disconnected/);
        }
    }, RUN_TIMEOUT_MS * 2);
});

describe.sequential('a write applied whose result was lost with a refused reattach', () => {
    it('records the write as applied and does not apply it again on Continue', async () => {
        const name = `reattach-lost-${Date.now()}`;
        const { runId, actionId } = await proposeCollection(name);

        await call('chat-drop-connection', { when: 'after_next_write', badToken: true });
        await call('approve-action', { actionId });
        appliedActions.push(actionId);

        // The plugin records the write itself once the reattach is refused.
        const reported = await waitFor('the write to be reported', snapshot, (snap) =>
            eventsFor(snap, runId).includes('undelivered_actions'), 60_000);
        expect(eventsFor(reported, runId)).toContain('reattach_failed');
        // The card shows it applied once the server has recorded it, which
        // can take a retry.
        await waitFor(
            'the card to show the write applied',
            () => call<{ actions: Array<{ id: string; status: string }> }>('list-actions'),
            (listed) => listed.actions.find((action) => action.id === actionId)?.status === 'applied',
            90_000,
        );

        // The server holds the run, waiting on the lost result, for its grace
        // period, then saves it as interrupted.
        const settled = await waitUntilQuiet('the server to give up on the run', 200_000);
        const saved = await serverRuns(settled.threadId!);
        expect(saved.actions.find((action) => action.id === actionId)?.status).toBe('applied');
        expect(runOf(saved, runId).status).not.toBe('completed');

        const continued = await call<Ids>('chat-continue', { runId, timeoutMs: RUN_TIMEOUT_MS }, RUN_TIMEOUT_MS);
        expect(continued.ok, continued.error).toBe(true);
        // The model knows the collection exists and does not propose it again.
        expect(continued.pendingApprovals).toHaveLength(0);
        await waitUntilQuiet();
        expect((await snapshot({ countCollectionsNamed: name })).collectionCount).toBe(1);
    }, 600_000);
});

describe.sequential('a write applied without asking whose result was lost with a refused reattach', () => {
    it('records the auto-applied note and does not create it again on Continue', async () => {
        const marker = `reattach-note-${Date.now()}`;
        await call('chat-drop-connection', { when: 'after_next_write', badToken: true });
        // create_note applies without asking by default.
        const sent = await call<Ids>('chat-send', {
            text: `Create a standalone note titled "${marker}" with the text "hello". Do nothing else.`,
            newThread: true,
            waitForDone: false,
        }, 60_000);
        expect(sent.ok, sent.error).toBe(true);
        const running = await waitFor('the run to start', ids, (state) => state.activeRunId !== null);
        const runId = running.activeRunId!;

        const recorded = await waitFor('the write to be recorded', snapshot, (snap) =>
            eventsFor(snap, runId).includes('undelivered_actions'), 120_000);
        expect(eventsFor(recorded, runId)).toContain('reattach_failed');

        const settled = await waitUntilQuiet('the server to give up on the run', 200_000);
        const saved = await serverRuns(settled.threadId!);
        const note = saved.actions.find((action) => action.action_type === 'create_note');
        expect(note?.status).toBe('applied');
        appliedActions.push(note!.id);

        const continued = await call<Ids>('chat-continue', { runId, timeoutMs: RUN_TIMEOUT_MS }, RUN_TIMEOUT_MS);
        expect(continued.ok, continued.error).toBe(true);
        await waitUntilQuiet();
        expect((await snapshot({ countNotesContaining: marker })).noteCount).toBe(1);
    }, 600_000);
});
