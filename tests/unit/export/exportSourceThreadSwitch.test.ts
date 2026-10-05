import { describe, expect, it, vi } from 'vitest';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { currentThreadIdAtom, currentThreadNameAtom } from '@beaver/agent-core/run-state/atoms';

const state = vi.hoisted(() => ({ store: null as any, releaseLabels: () => {} }));

vi.mock('../../../react/store', async () => {
    const { createStore } = await import('jotai/vanilla');
    state.store = createStore();
    return { store: state.store };
});
vi.mock('../../../react/atoms/threads', async () => {
    const atoms = await import('@beaver/agent-core/run-state/atoms');
    return { currentThreadIdAtom: atoms.currentThreadIdAtom, currentThreadNameAtom: atoms.currentThreadNameAtom };
});
vi.mock('../../../src/utils/libraryIdentity', () => ({ libraryRefForLibraryID: vi.fn(() => 'u') }));
vi.mock('../../../react/utils/citationRenderContext', () => ({
    // Echo the citation state the caller captured.
    prepareCitationRenderContext: vi.fn(async (_content: string, context: unknown) => context),
}));
vi.mock('../../../react/utils/toolCallLabelEnrich', () => ({
    getToolCallResultView: vi.fn(() => null),
    resolveToolCallLabelEnrichMap: vi.fn(() => new Promise(resolve => {
        state.releaseLabels = () => resolve(new Map());
    })),
}));

import { buildNoteExportSource, buildResponseExportSource, buildThreadExportSource } from '../../../react/utils/exportSource';
import { store } from '../../../react/store';

const run = {
    id: 'r1', user_id: 'u', thread_id: 't1', agent_name: 'beaver', status: 'completed',
    user_prompt: { content: 'Question' },
    model_messages: [{
        kind: 'response',
        parts: [
            { part_kind: 'text', content: 'Searching.' },
            { part_kind: 'tool-call', tool_name: 'item_search_by_topic', tool_call_id: 'a', args: {} },
            { part_kind: 'text', content: 'Claim <citation id="u-AAAAAAAA" loc="page3"/>.' },
        ],
    }],
} as any;

describe('buildResponseExportSource', () => {
    it('describes the thread it started from when the reader switches threads mid-export', async () => {
        store.set(currentThreadIdAtom, 't1');
        store.set(currentThreadNameAtom, 'Original thread');
        store.set(citationsAtom, [{
            citation_id: 'c1',
            requested_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA', loc: { kind: 'page', value: '3', raw: 'page3' } },
            pages: [3],
        }]);

        const pending = buildResponseExportSource([run], 'full');
        // The reader opens another thread while tool labels resolve.
        store.set(currentThreadIdAtom, 't2');
        store.set(currentThreadNameAtom, 'Other thread');
        store.set(citationsAtom, []);
        state.releaseLabels();
        const source = await pending;

        expect(source.title).toBe('Original thread');
        expect(source.provenance.threadId).toBe('t1');
        expect(Object.keys(source.citations.citationsByKey)).toContain('zotero:u-AAAAAAAA:page3');
        expect(source.blocks.map(block => block.type)).toEqual(['markdown', 'activity', 'markdown']);
    });

    it('exports a note the agent wrote, as it wrote it', async () => {
        store.set(currentThreadIdAtom, 't1');
        store.set(citationsAtom, []);
        const withNote = {
            ...run,
            model_messages: [{
                kind: 'response',
                parts: [
                    { part_kind: 'text', content: 'Writing a note.' },
                    { part_kind: 'tool-call', tool_name: 'create_note', tool_call_id: 'n1', args: JSON.stringify({ title: 'Key findings', content: '# Summary\n\nClaim <citation id="u-AAAAAAAA"/>.' }) },
                ],
            }],
        };
        const source = await buildNoteExportSource(withNote, 'n1');
        expect(source).toMatchObject({
            kind: 'note',
            title: 'Key findings',
            blocks: [{ type: 'markdown', markdown: '# Summary\n\nClaim <citation id="u-AAAAAAAA"/>.' }],
            provenance: { threadId: 't1', runIds: ['r1'] },
        });
        expect(await buildNoteExportSource(withNote, 'missing')).toBeNull();
    });
});

describe('buildThreadExportSource', () => {
    it('exports every prompt, response, note and tool call of the thread in order', async () => {
        store.set(currentThreadIdAtom, 't1');
        store.set(currentThreadNameAtom, 'Whole thread');
        store.set(citationsAtom, []);
        const second = {
            ...run,
            id: 'r2',
            user_prompt: { content: 'Write it up' },
            model_messages: [{
                kind: 'response',
                parts: [
                    { part_kind: 'tool-call', tool_name: 'create_note', tool_call_id: 'n1', args: JSON.stringify({ title: 'Findings', content: 'Body' }) },
                    { part_kind: 'text', content: 'Done.' },
                ],
            }],
        };
        // A continuation of the second response: no prompt of its own.
        const continuation = {
            ...run,
            id: 'r3',
            user_prompt: { content: '' },
            model_messages: [{ kind: 'response', parts: [{ part_kind: 'text', content: 'Continued.' }] }],
        };

        const pending = buildThreadExportSource([run, second, continuation]);
        state.releaseLabels();
        const source = await pending;

        expect(source.kind).toBe('thread');
        expect(source.title).toBe('Whole thread');
        expect(source.provenance).toEqual({ threadId: 't1', runIds: ['r1', 'r2', 'r3'] });
        expect(source.blocks.map(block => block.type)).toEqual([
            'user', 'markdown', 'activity', 'markdown',
            'user', 'note', 'markdown',
            'markdown',
        ]);
        expect(source.blocks[0]).toEqual({ type: 'user', text: 'Question' });
        expect(source.blocks[4]).toEqual({ type: 'user', text: 'Write it up' });
        expect(source.blocks[2]).toMatchObject({ type: 'activity', calls: [expect.any(String)] });
    });
});
