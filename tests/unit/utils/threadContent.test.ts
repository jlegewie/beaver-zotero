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
import type { ToolCallPart, ToolReturnPart } from '../../../react/agents/types';

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
