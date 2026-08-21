import { beforeEach, describe, expect, it, vi } from 'vitest';

// The loader's only dependency is the runs REST call; stubbing it keeps the
// supabase-backed transport out of the import graph.
const getThreadRunsMock = vi.fn();
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentRunService: { getThreadRuns: (...args: unknown[]) => getThreadRunsMock(...args) },
}));

import type { AgentRun, ModelMessage } from '@beaver/agent-core/agents/types';
import { loadThreadRuns } from '@beaver/agent-core/run-state/loadThreadRuns';

function makeRun(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: '', is_resume: false },
        status: 'completed',
        model_messages: [],
        created_at: '2024-01-01T00:00:00Z',
        completed_at: '2024-01-01T00:01:00Z',
        consent_to_share: false,
        model_name: 'gpt-5',
        ...overrides,
    };
}

function toolCallMessage(calls: { id: string; args: any; name?: string }[]): ModelMessage {
    return {
        kind: 'response',
        parts: calls.map(call => ({
            part_kind: 'tool-call' as const,
            tool_name: call.name ?? 'search_library',
            args: call.args,
            tool_call_id: call.id,
        })),
    } as ModelMessage;
}

function toolReturnMessage(returns: { id: string; content?: any; name?: string }[]): ModelMessage {
    return {
        kind: 'request',
        parts: returns.map(ret => ({
            part_kind: 'tool-return' as const,
            tool_name: ret.name ?? 'search_library',
            content: ret.content ?? 'ok',
            tool_call_id: ret.id,
        })),
    } as ModelMessage;
}

describe('loadThreadRuns', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getThreadRunsMock.mockResolvedValue({ runs: [], agent_actions: null });
    });

    it('requests the thread runs with their agent actions and passes them back untouched', async () => {
        const actions = [{ id: 'action-1' }];
        getThreadRunsMock.mockResolvedValue({ runs: [makeRun('run-1')], agent_actions: actions });

        const result = await loadThreadRuns('thread-1');

        expect(getThreadRunsMock).toHaveBeenCalledWith('thread-1', true);
        expect(result.agentActions).toBe(actions);
    });

    it('marks a stale in_progress run canceled and stamps a completion time', async () => {
        getThreadRunsMock.mockResolvedValue({
            runs: [
                makeRun('run-1', { status: 'in_progress', completed_at: undefined }),
                makeRun('run-2', { status: 'in_progress', completed_at: '2024-02-02T00:00:00Z' }),
                makeRun('run-3', { status: 'error' }),
            ],
            agent_actions: null,
        });

        const { runs } = await loadThreadRuns('thread-1');

        expect(runs.map(run => run.status)).toEqual(['canceled', 'canceled', 'error']);
        expect(runs[0].completed_at).toBeTruthy();
        // An in_progress run that already carries a completion time keeps it
        expect(runs[1].completed_at).toBe('2024-02-02T00:00:00Z');
    });

    it('collects every run\'s citations in order, each stamped with its run id', async () => {
        getThreadRunsMock.mockResolvedValue({
            runs: [
                makeRun('run-1', { metadata: { citations: [{ citation_id: 'c1' }, { citation_id: 'c2' }] } as any }),
                makeRun('run-2', { metadata: undefined }),
                makeRun('run-3', { metadata: { citations: [{ citation_id: 'c3' }] } as any }),
            ],
            agent_actions: null,
        });

        const { citations } = await loadThreadRuns('thread-1');

        expect(citations).toEqual([
            { citation_id: 'c1', run_id: 'run-1' },
            { citation_id: 'c2', run_id: 'run-1' },
            { citation_id: 'c3', run_id: 'run-3' },
        ]);
    });

    it('invokes the handler once per tool-return part, in run and message order', async () => {
        getThreadRunsMock.mockResolvedValue({
            runs: [
                makeRun('run-1', {
                    model_messages: [
                        toolCallMessage([{ id: 'call-1', args: null }]),
                        toolReturnMessage([{ id: 'call-1' }]),
                        // A retry-prompt part shares the shape of a tool return
                        // but must not be visited.
                        { kind: 'request', parts: [{ part_kind: 'retry-prompt', tool_name: 'x', content: 'retry', tool_call_id: 'call-1' }] } as ModelMessage,
                    ],
                }),
                makeRun('run-2', {
                    model_messages: [
                        toolReturnMessage([{ id: 'call-2' }, { id: 'call-3' }]),
                    ],
                }),
            ],
            agent_actions: null,
        });

        const seen: string[] = [];
        await loadThreadRuns('thread-1', {
            onToolReturn: (part) => {
                seen.push(part.tool_call_id);
            },
        });

        expect(seen).toEqual(['call-1', 'call-2', 'call-3']);
    });

    it('hands each tool return the args of its originating tool call', async () => {
        getThreadRunsMock.mockResolvedValue({
            runs: [
                makeRun('run-1', {
                    model_messages: [
                        toolCallMessage([
                            { id: 'call-1', args: { query: 'first' } },
                            { id: 'call-2', args: '{"raw":"string args"}' },
                        ]),
                        toolReturnMessage([{ id: 'call-1' }, { id: 'call-2' }]),
                    ],
                }),
                // A return whose call lives in an earlier run still resolves:
                // the args map spans the whole thread.
                makeRun('run-2', { model_messages: [toolReturnMessage([{ id: 'call-1' }, { id: 'orphan' }])] }),
            ],
            agent_actions: null,
        });

        const seen: [string, unknown][] = [];
        await loadThreadRuns('thread-1', {
            onToolReturn: (part, toolCallArgs) => {
                seen.push([part.tool_call_id, toolCallArgs]);
            },
        });

        expect(seen).toEqual([
            ['call-1', { query: 'first' }],
            ['call-2', '{"raw":"string args"}'],
            ['call-1', { query: 'first' }],
            ['orphan', undefined],
        ]);
    });

    it('awaits each handler before visiting the next part', async () => {
        getThreadRunsMock.mockResolvedValue({
            runs: [makeRun('run-1', { model_messages: [toolReturnMessage([{ id: 'a' }, { id: 'b' }])] })],
            agent_actions: null,
        });

        const events: string[] = [];
        await loadThreadRuns('thread-1', {
            onToolReturn: async (part) => {
                events.push(`start:${part.tool_call_id}`);
                await Promise.resolve();
                events.push(`end:${part.tool_call_id}`);
            },
        });

        expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    });

    it('returns empty state for a thread with no runs and never calls the handler', async () => {
        const onToolReturn = vi.fn();

        const result = await loadThreadRuns('thread-1', { onToolReturn });

        expect(result.runs).toEqual([]);
        expect(result.citations).toEqual([]);
        expect(result.agentActions).toBeNull();
        expect(onToolReturn).not.toHaveBeenCalled();
    });
});
