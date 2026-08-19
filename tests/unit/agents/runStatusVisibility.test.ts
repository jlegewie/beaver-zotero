/**
 * Unit tests for `@beaver/agent-core/run-state/runStatusVisibility`.
 *
 * The rule is worth pinning because both of its mistakes are silent. Left up
 * beside an answer, a status line reads as a hang; missing during the wait
 * before the first token, it reads as a message that was never sent. Both are
 * one boolean away from each other, and neither shows up in a type check.
 */

import { describe, expect, it } from 'vitest';
import type {
    AgentRun,
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    ToolReturnPart,
} from '@beaver/agent-core/agents/types';

type ResponsePart = ModelResponse['parts'][number];

import { shouldShowRunStatus } from '@beaver/agent-core/run-state/runStatusVisibility';

function run(
    messages: ModelMessage[],
    status: AgentRun['status'] = 'in_progress',
): AgentRun {
    return {
        id: 'run-1',
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: 'hello', attachments: [] },
        status,
        model_messages: messages,
        model_name: 'model',
        created_at: '2026-01-01T00:00:00.000Z',
        consent_to_share: false,
    };
}

function response(...parts: ResponsePart[]): ModelMessage {
    return { kind: 'response', run_id: 'run-1', parts };
}

/** The shape a tool result arrives in: a request message, not a response. */
function toolResultMessage(): ModelMessage {
    return {
        kind: 'request',
        run_id: 'run-1',
        parts: [],
    } as unknown as ModelMessage;
}

const toolCall = (toolCallId: string): ResponsePart => ({
    part_kind: 'tool-call',
    tool_name: 'search',
    args: null,
    tool_call_id: toolCallId,
});

const results = (
    ...parts: (ToolReturnPart | RetryPromptPart)[]
): Map<string, ToolReturnPart | RetryPromptPart> =>
    new Map(parts.map((part) => [part.tool_call_id, part]));

const toolReturn = (toolCallId: string): ToolReturnPart => ({
    part_kind: 'tool-return',
    tool_name: 'search',
    content: 'ok',
    tool_call_id: toolCallId,
});

const noResults = new Map<string, ToolReturnPart | RetryPromptPart>();

describe('shouldShowRunStatus', () => {
    it('shows for a run that has been sent and has produced nothing', () => {
        expect(shouldShowRunStatus(run([]), noResults)).toBe(true);
    });

    it('stops as soon as the first text arrives', () => {
        expect(
            shouldShowRunStatus(
                run([response({ part_kind: 'text', content: 'A' })]),
                noResults,
            ),
        ).toBe(false);
    });

    it('treats an empty part as nothing, because that is what it looks like', () => {
        // A text part exists before its first token streams into it, so the run
        // has a part and the reader still has a blank space under the prompt.
        expect(
            shouldShowRunStatus(
                run([response({ part_kind: 'text', content: '' })]),
                noResults,
            ),
        ).toBe(true);
    });

    it('counts thinking as something to look at', () => {
        expect(
            shouldShowRunStatus(
                run([response({ part_kind: 'thinking', content: 'hmm' })]),
                noResults,
            ),
        ).toBe(false);
    });

    it('counts a tool call as something to look at, back or not', () => {
        // A call the reader can see is content in its own right: its card is on
        // screen from the moment the call is made, and it is the card — not this
        // line — that says whether it has come back.
        expect(
            shouldShowRunStatus(run([response(toolCall('call-1'))]), noResults),
        ).toBe(false);
        expect(
            shouldShowRunStatus(
                run([response(toolCall('call-1'))]),
                results(toolReturn('call-1')),
            ),
        ).toBe(false);
    });

    it('comes back in the gap between a tool result and whatever follows it', () => {
        expect(
            shouldShowRunStatus(
                run([response(toolCall('call-1')), toolResultMessage()]),
                results(toolReturn('call-1')),
            ),
        ).toBe(true);
    });

    it('waits for the last of several parallel calls', () => {
        // The calls share a message and their results arrive separately, so one
        // of them landing is not the run coming back — the other card is still
        // spinning, and this line beside it would be a second claim.
        expect(
            shouldShowRunStatus(
                run([
                    response(toolCall('call-1'), toolCall('call-2')),
                    toolResultMessage(),
                ]),
                results(toolReturn('call-1')),
            ),
        ).toBe(false);
    });

    it('looks past the newest message for a call still outstanding', () => {
        // A call made in an earlier message is still the thing being waited on;
        // only the visible-content half of the rule is about the newest one.
        expect(
            shouldShowRunStatus(
                run([
                    response(toolCall('call-1')),
                    toolResultMessage(),
                    response(),
                ]),
                noResults,
            ),
        ).toBe(false);
    });

    it('ignores an auto-loading call, which no client draws', () => {
        // Backend plumbing: treating it as content would leave the reader
        // looking at a blank space with nothing to explain it. Given a result,
        // so the call is back and only the visible-content half is under test.
        expect(
            shouldShowRunStatus(
                run([response(toolCall('auto_load_1'))]),
                results(toolReturn('auto_load_1')),
            ),
        ).toBe(true);
    });

    it('stays quiet while an auto-loading call is outstanding', () => {
        // The deliberate asymmetry, pinned so that removing it is a decision
        // rather than an accident: the call is not content, but it is a step
        // the run is between, and a client that draws such a call would
        // otherwise get this line beside a card already saying so. What it
        // costs a client that hides them is the call's own duration, which is
        // single-digit milliseconds.
        expect(
            shouldShowRunStatus(
                run([response(toolCall('auto_load_1'))]),
                noResults,
            ),
        ).toBe(false);
    });

    it('says nothing for a run that is no longer working', () => {
        for (const status of [
            'completed',
            'error',
            'canceled',
            'awaiting_deferred',
        ] as const) {
            expect(shouldShowRunStatus(run([], status), noResults)).toBe(false);
        }
    });
});
