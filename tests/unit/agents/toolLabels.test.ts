/**
 * Unit tests for the (now pure) tool-call label layer
 * (`react/agents/toolLabels.ts`).
 *
 * `getToolCallLabel` formats a tool-call header label from the request args plus
 * either the hydrated tool-result `view` (completed calls) or host-resolved
 * `enrich` data (pending/failed). It performs no Zotero loads. These tests cover
 * the view-derived path, the request-side enrich path, the no-enrich fallback
 * (no meaningless bare locators), and the view-derived helpers.
 */

import { describe, it, expect } from 'vitest';
import {
    getToolCallLabel,
    getViewDisplayName,
    getToolResultLabelSuffix,
    getLabelEnrichmentNeeds,
} from '../../../react/agents/toolLabels';
import { getToolResultRenderableCount } from '../../../react/types/toolResultViews';
import type {
    ItemListView,
    AnnotationListView,
    CollectionListView,
    AttachmentSearchView,
    ExternalReferenceListView,
} from '../../../react/types/toolResultViews';
import type { ToolCallPart } from '../../../react/agents/types';

function tc(tool_name: string, args: Record<string, unknown> = {}): ToolCallPart {
    return { part_kind: 'tool-call', tool_name, args, tool_call_id: 't1' };
}

const readView = (displayName: string, locationLabel: string): ItemListView => ({
    view_type: 'item_list',
    tool_name: 'read',
    items: [{ kind: 'item', library_id: 1, zotero_key: 'AAA', display_name: displayName, location_label: locationLabel }],
});

const itemListView = (count: number): ItemListView => ({
    view_type: 'item_list',
    tool_name: 'item_search_by_topic',
    items: Array.from({ length: count }, (_, i) => ({
        kind: 'item' as const, library_id: 1, zotero_key: `K${i}`, display_name: `Item ${i}`,
    })),
});

const annotationView = (sources: string[]): AnnotationListView => ({
    view_type: 'annotation_list',
    tool_name: 'get_annotations',
    variant: 'compact',
    annotations: sources.map((s, i) => ({
        kind: 'annotation' as const, library_id: 1, zotero_key: `A${i}`, source_display_name: s,
    })),
});

describe('getToolCallLabel', () => {
    it('builds a completed read label from the view (name + actual locator, no count suffix)', () => {
        const label = getToolCallLabel(tc('read', { file: '1-AAA', pages: '5-10' }), 'completed', {
            view: readView('Smith 2005', 'Page 5-10'),
        });
        expect(label).toBe('Reading: Smith 2005, Page 5-10');
    });

    it('appends a (N results) suffix for completed search views', () => {
        const label = getToolCallLabel(tc('item_search_by_topic', { topic_query: 'social capital' }), 'completed', {
            view: itemListView(3),
        });
        expect(label).toBe('Item search: "social capital" (3 results)');
    });

    it('enriches a pending read label with the host-resolved name + requested range', () => {
        const label = getToolCallLabel(tc('read', { file: '1-AAA', pages: '5-10' }), 'in_progress', {
            enrich: { itemDisplayName: 'Smith 2005' },
        });
        expect(label).toBe('Reading: Smith 2005, p. 5-10');
    });

    it('falls back to the base label (never a bare locator) when nothing resolves the name', () => {
        const label = getToolCallLabel(tc('read', { file: '1-AAA', pages: '5-10' }), 'in_progress');
        expect(label).toBe('Reading');
        expect(label).not.toContain('5-10');
        expect(label).not.toContain('p.');
    });

    it('uses the note title for a completed read_note label', () => {
        const view: ItemListView = {
            view_type: 'item_list',
            tool_name: 'read_note',
            items: [{ kind: 'item', library_id: 1, zotero_key: 'N1', display_name: 'My note title', item_type: 'note' }],
        };
        expect(getToolCallLabel(tc('read_note', { note_id: '1-N1' }), 'completed', { view })).toBe(
            'Reading note: "My note title"',
        );
    });

    it('shows the host-resolved scope name + view count for completed list_collections', () => {
        const view: CollectionListView = { view_type: 'collection_list', tool_name: 'list_collections', collections: [], total_count: 5 };
        const label = getToolCallLabel(tc('list_collections', { library: 1 }), 'completed', {
            view,
            enrich: { libraryName: 'My Library' },
        });
        expect(label).toBe('List collections: "My Library" (5 collections)');
    });

    it('falls back to the host-resolved source name for an empty completed annotation view', () => {
        const view = annotationView([]);
        const label = getToolCallLabel(tc('get_annotations', { attachment_id: '1-AAA' }), 'completed', {
            view,
            enrich: { itemDisplayName: 'Smith 2020' },
        });
        expect(label).toBe('Get annotations: Smith 2020');
    });
});

describe('getViewDisplayName', () => {
    it('returns the single source name for a scoped annotation view', () => {
        expect(getViewDisplayName(annotationView(['Smith 2020', 'Smith 2020']), 'get_annotations')).toBe('Smith 2020');
    });

    it('returns null for an unscoped multi-source annotation view', () => {
        expect(getViewDisplayName(annotationView(['Smith 2020', 'Jones 2019']), 'find_annotations')).toBeNull();
    });

    it('returns null for an empty annotation view', () => {
        expect(getViewDisplayName(annotationView([]), 'get_annotations')).toBeNull();
    });

    it('returns the row display name for a single-item read view', () => {
        expect(getViewDisplayName(readView('Smith 2005', 'Page 1-3'), 'read')).toBe('Smith 2005');
    });
});

describe('getToolResultLabelSuffix', () => {
    it('returns null for read/view (locator is inline, not a count)', () => {
        expect(getToolResultLabelSuffix(readView('Smith 2005', 'Page 1-3'), 'read')).toBeNull();
    });

    it('returns a result count for search item lists', () => {
        expect(getToolResultLabelSuffix(itemListView(3), 'item_search_by_topic')).toBe(' (3 results)');
        expect(getToolResultLabelSuffix(itemListView(1), 'item_search_by_topic')).toBe(' (1 result)');
    });

    it('returns a match count for attachment search', () => {
        const view: AttachmentSearchView = {
            view_type: 'attachment_search', tool_name: 'find_in_attachments', query: 'q',
            total_matches: 4, attachment_count: 2, attachments: [],
        };
        expect(getToolResultLabelSuffix(view, 'find_in_attachments')).toBe(' (4 matches)');
    });

    it('returns a found count for lookup_work', () => {
        const view: ExternalReferenceListView = {
            view_type: 'external_reference_list', tool_name: 'lookup_work', references: [], found_count: 2,
        };
        expect(getToolResultLabelSuffix(view, 'lookup_work')).toBe(' (2 found)');
    });
});

describe('getToolResultRenderableCount (expansion gating)', () => {
    it('counts item-list rows, including zero (so empty results do not expand)', () => {
        expect(getToolResultRenderableCount(itemListView(3))).toBe(3);
        expect(getToolResultRenderableCount(itemListView(0))).toBe(0);
    });

    it('uses total_count for collection lists', () => {
        const view: CollectionListView = { view_type: 'collection_list', tool_name: 'list_collections', collections: [], total_count: 5 };
        expect(getToolResultRenderableCount(view)).toBe(5);
    });
});

describe('getLabelEnrichmentNeeds', () => {
    it('needs an item name when a content tool has no view', () => {
        expect(getLabelEnrichmentNeeds(tc('read', { file: '1-AAA' }), null)).toEqual({ itemName: true, scope: false });
    });

    it('needs no item name once the view supplies it', () => {
        expect(getLabelEnrichmentNeeds(tc('read', { file: '1-AAA' }), readView('Smith 2005', 'Page 1-3'))).toEqual({
            itemName: false, scope: false,
        });
    });

    it('needs an item name for an empty annotation view (source not in view)', () => {
        expect(getLabelEnrichmentNeeds(tc('get_annotations', { attachment_id: '1-AAA' }), annotationView([]))).toEqual({
            itemName: true, scope: false,
        });
    });

    it('always needs scope resolution for list_* tools', () => {
        const view: CollectionListView = { view_type: 'collection_list', tool_name: 'list_collections', collections: [], total_count: 2 };
        expect(getLabelEnrichmentNeeds(tc('list_collections', { library: 1 }), view)).toEqual({ itemName: false, scope: true });
    });
});
