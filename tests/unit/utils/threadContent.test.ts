/**
 * Unit tests for tool-call detail formatting in thread export
 * (`react/utils/threadContent.ts`).
 *
 * Regression guard: the export label is built via `getToolCallLabel(..., { view })`,
 * which now bakes in the result count. `getToolCallDetails` must NOT also append
 * a `(N results)` suffix from the legacy `metadata.summary.result_count`, or the
 * count would appear twice.
 */

import { describe, it, expect } from 'vitest';
import { getToolCallDetails } from '../../../react/utils/threadContent';
import type { ToolCallPart, ToolReturnPart } from '@beaver/agent-core/agents/types';

function tc(tool_name: string, args: Record<string, unknown> = {}): ToolCallPart {
    return { part_kind: 'tool-call', tool_name, args, tool_call_id: 't1' };
}

function ret(tool_name: string, metadata: Record<string, unknown>): ToolReturnPart {
    return { part_kind: 'tool-return', tool_name, content: {}, tool_call_id: 't1', metadata };
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

describe('getToolCallDetails', () => {
    it('does not double-count: the view suffix is used, not the legacy summary count', () => {
        // Result carries BOTH a view and a legacy summary.result_count.
        const result = ret('item_search_by_topic', {
            view: {
                view_type: 'item_list',
                tool_name: 'item_search_by_topic',
                items: [
                    { kind: 'item', library_id: 1, zotero_key: 'A', display_name: 'A' },
                    { kind: 'item', library_id: 1, zotero_key: 'B', display_name: 'B' },
                    { kind: 'item', library_id: 1, zotero_key: 'C', display_name: 'C' },
                ],
            },
            summary: { result_count: 3 },
        });
        const map = new Map<string, any>([['t1', result]]);
        const details = getToolCallDetails(tc('item_search_by_topic', { topic_query: 'x' }), map);

        expect(details).toContain('(3 results)');
        expect(count(details, '(3 results)')).toBe(1);
    });

    it('uses the host-resolved library name from the enrich map, not the raw library ref', () => {
        const result = ret('list_collections', {
            view: { view_type: 'collection_list', tool_name: 'list_collections', collections: [], total_count: 44 },
        });
        const map = new Map<string, any>([['t1', result]]);
        const enrichMap = new Map([['t1', { libraryName: 'My Library' }]]);
        const details = getToolCallDetails(tc('list_collections', { library: 'u' }), map, enrichMap);

        expect(details).toContain('"My Library"');
        expect(details).not.toContain('"u"');
    });

    it('falls back to the raw library arg when no enrich map is supplied', () => {
        const result = ret('list_collections', {
            view: { view_type: 'collection_list', tool_name: 'list_collections', collections: [], total_count: 44 },
        });
        const map = new Map<string, any>([['t1', result]]);
        const details = getToolCallDetails(tc('list_collections', { library: 'u' }), map);

        expect(details).toContain('"u"');
    });

    it('uses the view-typed count wording (collections), not a summary result count', () => {
        const result = ret('list_collections', {
            view: { view_type: 'collection_list', tool_name: 'list_collections', collections: [], total_count: 5 },
            summary: { result_count: 5 },
        });
        const map = new Map<string, any>([['t1', result]]);
        const details = getToolCallDetails(tc('list_collections', {}), map);

        expect(details).toContain('(5 collections)');
        expect(details).not.toContain('results');
    });
});

describe('getToolCallDetails for database searches', () => {
    it('does not repeat a query the label already shows', () => {
        const details = getToolCallDetails(tc('openalex_search_by_topic', { query: 'peer effects' }), new Map());
        expect(details).toBe('[Literature search: peer effects]');
    });

    it('labels a name lookup by all its names', () => {
        const details = getToolCallDetails(tc('openalex_resolve_names', { names: ['Katrin Wisniewski'], kind: 'author' }), new Map());
        expect(details).toBe('[Author lookup: Katrin Wisniewski]');
        expect(getToolCallDetails(tc('openalex_resolve_names', { names: ['Nature', 'Science', 'Cell'], kind: 'venue' }), new Map()))
            .toBe('[Journal lookup: Nature, Science, Cell]');
        const names = ['Katrin Wisniewski', 'Esther Duflo', 'Abhijit Banerjee', 'Michael Kremer'];
        expect(getToolCallDetails(tc('openalex_resolve_names', { names, kind: 'author' }), new Map()))
            .toBe(`[Author lookup: ${names.join(', ')}]`);
    });

    it('reads names the model sent as a JSON-encoded list', () => {
        expect(getToolCallDetails(tc('openalex_resolve_names', { names: '["Alice Smith", "Bob Jones", "Carol Gray"]', kind: 'author' }), new Map()))
            .toBe('[Author lookup: Alice Smith, Bob Jones, Carol Gray]');
    });

    it('keeps the full terms of a long trial search, once', () => {
        const condition = 'type 2 diabetes mellitus with obesity and chronic kidney disease stage 3';
        const details = getToolCallDetails(tc('trials_search', { condition, intervention: 'tirzepatide' }), new Map());
        expect(details).toBe(`[ClinicalTrials.gov search: ${condition} · tirzepatide]`);
        const mixed = getToolCallDetails(tc('trials_search', { query: 'randomized', condition, intervention: 'tirzepatide' }), new Map());
        expect(mixed).toBe(`[ClinicalTrials.gov search: randomized · ${condition} · tirzepatide]`);
    });

    it('keeps every author id of a filter-only listing', () => {
        expect(getToolCallDetails(tc('openalex_search_by_keywords', { author_ids: ['A101', 'A102', 'A103'] }), new Map()))
            .toBe('[Literature search: Works by A101, A102, A103]');
    });

    it('keeps a keyword list argument of other tools', () => {
        expect(getToolCallDetails(tc('some_tool', { keywords: ['peer', 'effects'] }), new Map())).toBe('[Some tool: "peer, effects"]');
    });

    it('copies a call whose arguments were stored as null', () => {
        expect(getToolCallDetails({ part_kind: 'tool-call', tool_name: 'external_search', args: 'null', tool_call_id: 't1' }, new Map()))
            .toBe('[Web search]');
    });

    it('ignores a search_label on tools that never had one', () => {
        expect(getToolCallDetails(tc('trials_search', { condition: 'obesity', search_label: 'Stale' }), new Map()))
            .toBe('[ClinicalTrials.gov search: obesity]');
    });

    it('keeps the full text of a long query, once', () => {
        const query = 'Research on how classmates or school peers influence student achievement and test scores';
        const details = getToolCallDetails(tc('openalex_search_by_topic', { query }), new Map());
        expect(details).toBe(`[Literature search: ${query}]`);
    });

    it('still reads the search_label of an older thread', () => {
        const details = getToolCallDetails(tc('external_search', { query: 'q', search_label: 'Peer effects' }), new Map());
        expect(details).toBe('[Web search: Peer effects]');
    });
});
