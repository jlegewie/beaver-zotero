/**
 * The rule that keeps model-facing text out of the UI: a ModelRequest is never
 * rendered as content.
 *
 * A tool can append a directive to its own result, which reaches the client as
 * a `user-prompt` part inside the request message that carries the tool return.
 * The user never wrote it, so surfacing it would attribute backend instructions
 * to them. `ModelMessagesView` is the consumer this guards — it is the only one
 * that would render a request message's parts as content if the check were
 * relaxed. The text extractors (`threadContent`, `screenReaderAnnouncements`)
 * carry a second, independent guard: they take only `text` parts, a kind a
 * request message cannot hold.
 */

import { describe, expect, it } from 'vitest';
import { ModelMessage, ModelResponse } from '@beaver/agent-core/agents/types';
import { isRenderableMessage, isThinkingInProgress } from '@beaver/agent-core/agents/messageVisibility';

/** A request message shaped like one carrying a tool result plus an injected directive. */
const requestWithInjectedPrompt = {
    kind: 'request',
    run_id: 'run-1',
    instructions: '',
    parts: [
        { part_kind: 'tool-return', tool_name: 'ask_user_question', content: {}, tool_call_id: 'tool-1' },
        { part_kind: 'user-prompt', content: 'Take your recommended option and do that work now.' },
    ],
} as ModelMessage;

const plainRequest = {
    kind: 'request',
    run_id: 'run-1',
    instructions: '',
    parts: [{ part_kind: 'user-prompt', content: 'Clean up my metadata' }],
} as ModelMessage;

const assistantResponse = {
    kind: 'response',
    run_id: 'run-1',
    parts: [{ part_kind: 'text', content: 'Applied the fixes to all 53 items.' }],
} as ModelMessage;

describe('isRenderableMessage', () => {
    it('rejects a request carrying a tool-injected user-prompt part', () => {
        expect(isRenderableMessage(requestWithInjectedPrompt)).toBe(false);
    });

    it('rejects a plain request: its user-prompt is the assembled prompt, not the typed message', () => {
        expect(isRenderableMessage(plainRequest)).toBe(false);
    });

    it('accepts response messages', () => {
        expect(isRenderableMessage(assistantResponse)).toBe(true);
    });
});

/**
 * Who owns a gap. The shimmering "Thinking" line and the run status indicator
 * are both working indicators, and both consult this: get it wrong one way and a
 * quiet stretch shows two spinners claiming the same thing, wrong the other way
 * and it shows none.
 */
describe('isThinkingInProgress', () => {
    const responseWith = (...parts: unknown[]) =>
        ({ kind: 'response', run_id: 'run-1', parts } as ModelResponse);

    it('is true while reasoning is all the response has produced', () => {
        expect(
            isThinkingInProgress(
                responseWith({ part_kind: 'thinking', content: 'Weighing the options…' }),
            ),
        ).toBe(true);
    });

    it('is false for an empty reasoning part, which renders nothing to shimmer', () => {
        expect(
            isThinkingInProgress(responseWith({ part_kind: 'thinking', content: '' })),
        ).toBe(false);
    });

    it('is false for a response that has produced nothing at all', () => {
        expect(isThinkingInProgress(responseWith())).toBe(false);
    });

    it('ends as soon as there is text, empty or not', () => {
        for (const content of ['Here is what I found.', '']) {
            expect(
                isThinkingInProgress(
                    responseWith(
                        { part_kind: 'thinking', content: 'Weighing the options…' },
                        { part_kind: 'text', content },
                    ),
                ),
            ).toBe(false);
        }
    });

    it('ends at a tool call: a step is being taken, not considered', () => {
        expect(
            isThinkingInProgress(
                responseWith(
                    { part_kind: 'thinking', content: 'Weighing the options…' },
                    { part_kind: 'tool-call', tool_name: 'search', args: null, tool_call_id: 'c1' },
                ),
            ),
        ).toBe(false);
    });

    it('survives a return_suggestions call, which is follow-up prompts rather than a step', () => {
        expect(
            isThinkingInProgress(
                responseWith(
                    { part_kind: 'thinking', content: 'Weighing the options…' },
                    {
                        part_kind: 'tool-call',
                        tool_name: 'return_suggestions',
                        args: null,
                        tool_call_id: 'c1',
                    },
                ),
            ),
        ).toBe(true);
    });
});
