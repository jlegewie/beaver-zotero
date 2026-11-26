/**
 * A run's citation data reaches the renderer after the run's own writes are
 * revoked: page labels preloaded for its citations, and the citations the
 * backend resolves for a run the user stopped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { preloadPageLabelsForCitations, notifyRunComplete } = vi.hoisted(() => ({
    preloadPageLabelsForCitations: vi.fn(),
    notifyRunComplete: vi.fn(),
}));

vi.mock('../../../react/utils/pageLabels', () => ({ preloadPageLabelsForCitations }));

vi.mock('../../../react/runtime/windowRuntime', () => ({
    tryGetWindowRuntime: () => ({ hostWindow: { closed: false, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} } }),
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/services/agentDataProvider', () => ({}));

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyRunComplete,
    notifyUserQuestion: vi.fn(),
}));

import type { Setter } from 'jotai';
import type { WSRunCitationsEvent, WSRunCompleteEvent } from '@beaver/agent-core/protocol/agentProtocol';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { citationsAtom, pageLabelsByAttachmentIdAtom } from '@beaver/agent-core/citations/atoms';
import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { abandonActiveRunLocallyAtom, createWSCallbacks } from '../../../react/atoms/agentRunAtoms';
import { store } from '../../../react/store';
import { chatStore } from '../../helpers/runSession';

describe('run citation page labels', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        chatStore().set(citationsAtom, []);
        store.set(pageLabelsByAttachmentIdAtom, {});
    });

    it('merges labels that arrive after the run released its setter', async () => {
        let resolvePreload!: (labels: Record<number, Record<number, string>>) => void;
        preloadPageLabelsForCitations.mockReturnValue(new Promise(resolve => { resolvePreload = resolve; }));

        // The run's setter, revoked once the run settles.
        let revoked = false;
        const runSet = ((...args: Parameters<Setter>) => {
            if (!revoked) return (chatStore().set as any)(...args);
        }) as Setter;
        const callbacks = createWSCallbacks(runSet);

        callbacks.onRunCitations({
            event: 'run_citations',
            run_id: 'run-1',
            citations: [{
                citation_id: 'c1',
                resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ATTACH01' },
                locations: [{ page_idx: 0 }],
            }],
        } as unknown as WSRunCitationsEvent);
        expect(store.get(citationsAtom)).toHaveLength(1);

        revoked = true;
        resolvePreload({ 101: { 1: '1302' } });
        await vi.waitFor(() => {
            expect(store.get(pageLabelsByAttachmentIdAtom)).toEqual({ 101: { 1: '1302' } });
        });
    });
});

const CITATION = {
    citation_id: 'c1',
    resolved_ref: { kind: 'external', external_id: 'web-ABC' },
};

function streamingRun(): AgentRun {
    return {
        id: 'run-1',
        thread_id: 'thread-1',
        status: 'in_progress',
        model_messages: [{
            kind: 'response',
            parts: [{ part_kind: 'text', content: 'A claim. <citation id="web-ABC"/>' }],
        }],
    } as unknown as AgentRun;
}

function partialRunComplete(): WSRunCompleteEvent {
    return {
        event: 'run_complete',
        run_id: 'run-1',
        usage: null,
        cost: null,
        citations: [CITATION],
        agent_actions: null,
    } as unknown as WSRunCompleteEvent;
}

/** Start a run, then press Stop: the callbacks the run streamed through are revoked. */
function stopStreamingRun() {
    chatStore().set(activeRunAtom, streamingRun());
    const callbacks = createWSCallbacks(chatStore().set);
    store.set(abandonActiveRunLocallyAtom);
    return callbacks;
}

describe('citations of a stopped run', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        preloadPageLabelsForCitations.mockResolvedValue({});
        chatStore().set(citationsAtom, []);
        chatStore().set(threadRunsAtom, []);
        chatStore().set(activeRunAtom, null);
    });

    it('applies the citations its partial run_complete carries after the stop', async () => {
        const callbacks = stopStreamingRun();

        await callbacks.onRunComplete(partialRunComplete());

        expect(store.get(citationsAtom)).toEqual([
            expect.objectContaining({ citation_id: 'c1', run_id: 'run-1' }),
        ]);
        // Nothing else of the stopped run comes back.
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom)).toEqual([
            expect.objectContaining({ id: 'run-1', status: 'canceled' }),
        ]);
    });

    it('applies citations that arrive on run_citations after the stop', () => {
        const callbacks = stopStreamingRun();

        callbacks.onRunCitations?.({
            event: 'run_citations',
            run_id: 'run-1',
            citations: [CITATION],
        } as unknown as WSRunCitationsEvent);

        expect(store.get(citationsAtom)).toEqual([
            expect.objectContaining({ citation_id: 'c1', run_id: 'run-1' }),
        ]);
    });

    it('drops them once the run has left the chat history', async () => {
        const callbacks = stopStreamingRun();
        // Another chat opened, or a retry removed the run.
        chatStore().set(threadRunsAtom, []);

        await callbacks.onRunComplete(partialRunComplete());

        expect(store.get(citationsAtom)).toEqual([]);
    });

    it('does not add them to a run that already has its citations', async () => {
        const callbacks = stopStreamingRun();

        await callbacks.onRunComplete(partialRunComplete());
        await callbacks.onRunComplete(partialRunComplete());

        expect(store.get(citationsAtom)).toHaveLength(1);
    });

    it('does not announce the stopped run as complete', async () => {
        const callbacks = stopStreamingRun();

        await callbacks.onRunComplete(partialRunComplete());

        expect(notifyRunComplete).not.toHaveBeenCalled();
    });
});
