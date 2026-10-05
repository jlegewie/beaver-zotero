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

import { buildResponseExportSource } from '../../../react/utils/exportSource';
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
});
