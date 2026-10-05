import { describe, expect, it } from 'vitest';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { buildResponseBlocks, buildThreadBlocks, splitNoteTags } from '@beaver/agent-export/source/buildSource';

function run(id: string, prompt: string, parts: any[]): AgentRun {
    return {
        id,
        user_id: 'u',
        thread_id: 't',
        agent_name: 'beaver',
        user_prompt: { content: prompt } as any,
        status: 'completed',
        model_messages: [
            { kind: 'request', parts: [{ part_kind: 'user-prompt', content: 'assembled input' }] } as any,
            { kind: 'response', parts } as any,
        ],
    } as AgentRun;
}

describe('buildResponseBlocks', () => {
    it('exports assistant text and create_note bodies in order, skipping other parts', () => {
        const blocks = buildResponseBlocks([run('r1', 'Q', [
            { part_kind: 'thinking', content: 'hidden reasoning' },
            { part_kind: 'text', content: 'Intro' },
            { part_kind: 'tool-call', tool_name: 'search', tool_call_id: 'a', args: '{"query":"x"}' },
            { part_kind: 'tool-call', tool_name: 'create_note', tool_call_id: 'b', args: JSON.stringify({ title: 'My note', content: 'Body' }) },
            { part_kind: 'text', content: 'Outro' },
        ])]);
        expect(blocks).toEqual([
            { type: 'markdown', markdown: 'Intro' },
            { type: 'note', title: 'My note', markdown: 'Body' },
            { type: 'markdown', markdown: 'Outro' },
        ]);
    });

    it('merges consecutive text from a resume chain into one block', () => {
        const blocks = buildResponseBlocks([
            run('r1', 'Q', [{ part_kind: 'text', content: 'Part one' }]),
            run('r2', '', [{ part_kind: 'text', content: 'Part two' }]),
        ]);
        expect(blocks).toEqual([{ type: 'markdown', markdown: 'Part one\n\nPart two' }]);
    });

    it('leaves notes out when includeNotes is false', () => {
        const blocks = buildResponseBlocks([run('r1', 'Q', [
            { part_kind: 'tool-call', tool_name: 'create_note', tool_call_id: 'b', args: { title: 'N', content: 'Body' } },
        ])], { includeNotes: false });
        expect(blocks).toEqual([]);
    });
});

describe('splitNoteTags', () => {
    it('turns <note> tags into note sections', () => {
        expect(splitNoteTags('Before <note title="T">Inside</note> after', true)).toEqual([
            { type: 'markdown', markdown: 'Before ' },
            { type: 'note', title: 'T', markdown: 'Inside' },
            { type: 'markdown', markdown: ' after' },
        ]);
    });

    it('leaves note tags written inside code alone', () => {
        const text = 'Example:\n\n```xml\n<note title="T">Body</note>\n```\n\nAnd `<note>` inline.';
        expect(splitNoteTags(text, true)).toEqual([{ type: 'markdown', markdown: text }]);
    });

    it('does not let an unclosed tag in code consume a later real note', () => {
        const text = 'Write `<note>` like this.\n\n<note title="Real">Line one\n\nLine two</note>\n\nAfter.';
        expect(splitNoteTags(text, true)).toEqual([
            { type: 'markdown', markdown: 'Write `<note>` like this.\n\n' },
            { type: 'note', title: 'Real', markdown: 'Line one\n\nLine two' },
            { type: 'markdown', markdown: '\n\nAfter.' },
        ]);
    });

    it('keeps an unterminated note to the end of the text', () => {
        expect(splitNoteTags('<note title="T">Still writing', true)).toEqual([
            { type: 'note', title: 'T', markdown: 'Still writing' },
        ]);
    });
});

describe('buildThreadBlocks', () => {
    it('puts each prompt before its response and skips empty continuation prompts', () => {
        const blocks = buildThreadBlocks([
            run('r1', 'First question', [{ part_kind: 'text', content: 'A1' }]),
            run('r2', '', [{ part_kind: 'text', content: 'A1 continued' }]),
        ]);
        expect(blocks).toEqual([
            { type: 'user', markdown: 'First question' },
            { type: 'markdown', markdown: 'A1' },
            { type: 'markdown', markdown: 'A1 continued' },
        ]);
    });
});

describe('buildResponseBlocks content', () => {
    // Two model responses: work in progress around tool calls, then the answer.
    const runs = () => [run('r1', 'Q', [
        { part_kind: 'text', content: 'I will search.' },
        { part_kind: 'tool-call', tool_name: 'item_search_by_topic', tool_call_id: 'a', args: { topic_query: 'x' } },
        { part_kind: 'text', content: 'Narrowing down.' },
        { part_kind: 'tool-call', tool_name: 'item_search_by_topic', tool_call_id: 'b', args: { topic_query: 'y' } },
        { part_kind: 'tool-call', tool_name: 'extract', tool_call_id: 'c', args: {} },
        { part_kind: 'text', content: 'The answer.' },
        { part_kind: 'tool-call', tool_name: 'create_note', tool_call_id: 'd', args: { title: 'N', content: 'Note body' } },
        { part_kind: 'tool-call', tool_name: 'return_suggestions', tool_call_id: 'e', args: {} },
    ])];
    const describe = (part: any) => (part.tool_name === 'return_suggestions' ? null : `Called ${part.tool_call_id}`);

    it('exports only what follows the last tool call as the final answer, keeping notes written there', () => {
        // Notes and follow-up suggestions after the answer do not end it.
        expect(buildResponseBlocks(runs(), { content: 'final', describeToolCall: describe })).toEqual([
            { type: 'markdown', markdown: 'The answer.' },
            { type: 'note', title: 'N', markdown: 'Note body' },
        ]);
    });

    it('falls back to the last text when a response ends with a tool call', () => {
        const endsWithSearch = run('r1', 'Q', [
            { part_kind: 'text', content: 'Searching.' },
            { part_kind: 'tool-call', tool_name: 'item_search_by_topic', tool_call_id: 'a', args: {} },
        ]);
        expect(buildResponseBlocks([endsWithSearch], { content: 'final' })).toEqual([
            { type: 'markdown', markdown: 'Searching.' },
        ]);
    });

    it('keeps the whole last answer, notes included, when a response ends with a tool call', () => {
        const canceled = run('r1', 'Q', [
            { part_kind: 'text', content: 'Searching.' },
            { part_kind: 'tool-call', tool_name: 'item_search_by_topic', tool_call_id: 'a', args: {} },
            { part_kind: 'text', content: 'Answer <note title="Details">Details</note> Done.' },
            { part_kind: 'tool-call', tool_name: 'item_search_by_topic', tool_call_id: 'b', args: {} },
        ]);
        expect(buildResponseBlocks([canceled], { content: 'final' })).toEqual([
            { type: 'markdown', markdown: 'Answer ' },
            { type: 'note', title: 'Details', markdown: 'Details' },
            { type: 'markdown', markdown: ' Done.' },
        ]);
        const noteOnly = run('r2', 'Q', [
            { part_kind: 'tool-call', tool_name: 'item_search_by_topic', tool_call_id: 'a', args: {} },
            { part_kind: 'tool-call', tool_name: 'create_note', tool_call_id: 'n', args: { title: 'N', content: 'Body' } },
            { part_kind: 'tool-call', tool_name: 'item_search_by_topic', tool_call_id: 'b', args: {} },
        ]);
        expect(buildResponseBlocks([noteOnly], { content: 'final' })).toEqual([
            { type: 'note', title: 'N', markdown: 'Body' },
        ]);
    });

    it('exports everything in full, with consecutive tool calls grouped as activity', () => {
        expect(buildResponseBlocks(runs(), { content: 'full', describeToolCall: describe })).toEqual([
            { type: 'markdown', markdown: 'I will search.' },
            { type: 'activity', calls: ['Called a'] },
            { type: 'markdown', markdown: 'Narrowing down.' },
            { type: 'activity', calls: ['Called b', 'Called c'] },
            { type: 'markdown', markdown: 'The answer.' },
            { type: 'note', title: 'N', markdown: 'Note body' },
        ]);
    });

    it('leaves tool calls out of a full export without a describer', () => {
        expect(buildResponseBlocks(runs(), { content: 'full' })).toEqual([
            { type: 'markdown', markdown: 'I will search.\n\nNarrowing down.\n\nThe answer.' },
            { type: 'note', title: 'N', markdown: 'Note body' },
        ]);
    });
});
