import { describe, it, expect } from 'vitest';
import { getToolCallLabel } from '@beaver/agent-core/run-state/toolLabels';
import type { ToolCallPart } from '@beaver/agent-core/agents/types';

function toolCall(overrides: Partial<ToolCallPart> = {}): ToolCallPart {
    return {
        part_kind: 'tool-call',
        tool_name: 'edit_metadata',
        tool_call_id: 'call_1',
        args: { item_id: '1-ABCD1234', edits: { abstractNote: 'unchanged' } },
        ...overrides,
    };
}

describe('getToolCallLabel', () => {
    it('names underline annotation calls by their style', () => {
        const call = (args: Record<string, unknown>) => toolCall({ tool_name: 'create_highlight_annotations', args });

        expect(getToolCallLabel(call({ style: 'underline' }), 'in_progress'))
            .toBe('Creating underline annotations');
        expect(getToolCallLabel(call({}), 'in_progress'))
            .toBe('Creating highlight annotations');
    });

    it('reports a write that changed nothing', () => {
        expect(getToolCallLabel(toolCall(), 'completed', { noChange: true }))
            .toBe('Edit metadata: no change needed');
    });

    it('keeps the plain label when the write did change something', () => {
        expect(getToolCallLabel(toolCall(), 'completed', { noChange: false }))
            .toBe('Edit metadata');
        expect(getToolCallLabel(toolCall(), 'completed')).toBe('Edit metadata');
    });

    it('lets an in-progress progress message win over the no-change label', () => {
        const part = toolCall({ progress: 'Applying edits' });
        expect(getToolCallLabel(part, 'in_progress', { noChange: true }))
            .toBe('Edit metadata: Applying edits');
    });

    it('humanizes the name of a tool this client has no label for', () => {
        const part = toolCall({ tool_name: 'find_patent_families', args: {} });
        expect(getToolCallLabel(part, 'completed')).toBe('Find patent families');
        expect(getToolCallLabel({ ...part, progress: 'Querying the registry' }, 'in_progress'))
            .toBe('Find patent families: Querying the registry');
    });

    it('names find_book_chapters', () => {
        const part = toolCall({ tool_name: 'find_book_chapters', args: { book: ['10.1002/9783527677429'] } });
        expect(getToolCallLabel(part, 'completed')).toBe('Book chapters');
    });

    // create_items normally renders as an agent-action card, so its label is only
    // reached when the call created nothing. Without a base label the row read
    // "Calling function".
    it('names create_items rather than falling back to the generic label', () => {
        const part = toolCall({
            tool_name: 'create_items',
            args: { external_reference_ids: ['W123'] },
        });
        expect(getToolCallLabel(part, 'completed')).toBe('Import items');
        expect(getToolCallLabel(part, 'completed', { noChange: true }))
            .toBe('Import items: no change needed');
    });

    it('names the tag a manage_tags call operates on', () => {
        const part = toolCall({ tool_name: 'manage_tags', args: { action: 'rename', name: 'methods', new_name: 'methodology' } });
        expect(getToolCallLabel(part, 'completed')).toBe('Manage tags: "methods"');
    });

    it('does not call a write on a missing target unnecessary', () => {
        const part = toolCall({ tool_name: 'manage_tags', args: { action: 'delete', name: 'gone' } });
        expect(getToolCallLabel(part, 'completed', { noChange: true }))
            .toBe('Manage tags: no change needed');
        expect(getToolCallLabel(part, 'completed', { noChange: true, notFound: true }))
            .toBe('Manage tags: nothing found to change');
    });
});

describe('getToolCallLabel for create_items', () => {
    const importCall = (items: unknown[]) => toolCall({ tool_name: 'create_items', args: { items } });

    it('names the lookup while the sources are being resolved', () => {
        expect(getToolCallLabel(importCall([{ id: '10.1/a' }, { id: 'https://x.org' }]), 'in_progress'))
            .toMatch(/looking up 2 sources…$/);
        expect(getToolCallLabel(importCall([{ id: '10.1/a' }]), 'in_progress')).toMatch(/looking up 1 source…$/);
    });

    it('drops the lookup note once the call completed', () => {
        expect(getToolCallLabel(importCall([{ id: '10.1/a' }]), 'completed')).not.toMatch(/looking up/);
    });
});

describe('getToolCallLabel for list_items', () => {
    const listCall = (args: Record<string, unknown>) => toolCall({ tool_name: 'list_items', args });

    it('names a built-in view instead of the library', () => {
        expect(getToolCallLabel(listCall({ special_collection: 'unfiled', library: 'u' }), 'completed'))
            .toBe('List items: "Unfiled Items"');
        expect(getToolCallLabel(listCall({ special_collection: 'publications' }), 'completed'))
            .toBe('List items: "My Publications"');
    });

    it('ignores an unknown view', () => {
        expect(getToolCallLabel(listCall({ special_collection: 'trash' }), 'completed')).toBe('List items');
    });
});

describe('external record tool labels', () => {
    const searchView = (shown: number, total: number) => ({
        view_type: 'external_reference_list' as const,
        tool_name: 'pubmed_search',
        references: Array.from({ length: shown }, (_, i) => ({ source: 'pubmed', source_id: `pmid:${i}`, library_items: [] })),
        tool_info: { info_type: 'search' as const, source: 'pubmed', source_label: 'PubMed', total_count: total, returned: shown },
    });

    it('labels a PubMed search by its query and its page of the hits', () => {
        const part = toolCall({ tool_name: 'pubmed_search', args: { query: 'semaglutide obesity' } });
        expect(getToolCallLabel(part, 'in_progress')).toBe('PubMed search: semaglutide obesity');
        expect(getToolCallLabel(part, 'completed', { view: searchView(20, 155) })).toBe('PubMed search: semaglutide obesity (20 of 155)');
    });

    it('labels a trial search by its terms and a trial lookup by its id', () => {
        expect(getToolCallLabel(toolCall({ tool_name: 'search_trials', args: { condition: 'obesity', intervention: 'semaglutide' } }), 'in_progress'))
            .toBe('Trial search: obesity · semaglutide');
        expect(getToolCallLabel(toolCall({ tool_name: 'get_trial', args: { nct_ids: ['NCT03548935'] } }), 'in_progress'))
            .toBe('Clinical trial: NCT03548935');
    });
});

