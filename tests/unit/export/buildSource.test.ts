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
