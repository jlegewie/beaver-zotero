import { describe, expect, it } from 'vitest';
import { AgentRun } from '../../../react/agents/types';
import {
    buildRunCompletionAnnouncement,
    extractAssistantResponseText,
    toScreenReaderText,
} from '../../../react/utils/screenReaderAnnouncements';

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id: 'run-1',
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: {
            content: 'Question?',
            attachments: [],
        },
        status: 'completed',
        model_messages: [],
        model_name: 'model',
        consent_to_share: false,
        created_at: '2026-01-01T00:00:00.000Z',
        ...overrides,
    } as AgentRun;
}

describe('screen reader announcements', () => {
    it('normalizes markdown and inline tags for live region text', () => {
        expect(toScreenReaderText('## Title\n\nSee [paper](https://example.com) and `code` <citation item_id="1-ABC"/>.'))
            .toBe('Title See paper and code .');
    });

    it('extracts only assistant text parts from a run', () => {
        const run = makeRun({
            model_messages: [
                {
                    kind: 'response',
                    run_id: 'run-1',
                    parts: [
                        { part_kind: 'thinking', content: 'hidden reasoning' },
                        { part_kind: 'text', content: '**Final** answer.' },
                        { part_kind: 'tool-call', tool_name: 'search', args: null, tool_call_id: 'tool-1' },
                    ],
                },
            ],
        });

        expect(extractAssistantResponseText(run)).toBe('Final answer.');
    });

    it('announces completed short responses verbatim', () => {
        const run = makeRun({
            model_messages: [
                {
                    kind: 'response',
                    run_id: 'run-1',
                    parts: [{ part_kind: 'text', content: 'The answer is yes.' }],
                },
            ],
        });

        expect(buildRunCompletionAnnouncement(run)).toBe('Beaver response: The answer is yes.');
    });

    it('summarizes very long completed responses instead of filling the live region', () => {
        const run = makeRun({
            model_messages: [
                {
                    kind: 'response',
                    run_id: 'run-1',
                    parts: [{ part_kind: 'text', content: `${'word '.repeat(900)}` }],
                },
            ],
        });

        expect(buildRunCompletionAnnouncement(run)).toBe(
            'Response complete. Beaver wrote about 900 words. Navigate to the latest message to read it.'
        );
    });

    it('announces error and canceled runs', () => {
        expect(buildRunCompletionAnnouncement(makeRun({
            status: 'error',
            error: { type: 'server_error', message: 'Server unavailable.' },
        }))).toBe('Beaver response failed: Server unavailable.');

        expect(buildRunCompletionAnnouncement(makeRun({ status: 'canceled' }))).toBe('Response canceled.');
    });
});
