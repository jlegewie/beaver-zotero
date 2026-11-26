import { describe, it, expect } from 'vitest';
import { getToolCallLabel, toolCallSearchText } from '@beaver/agent-core/run-state/toolLabels';
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

describe('web page tool labels', () => {
    const page = {
        source: 'exa', source_id: 'web-MJNNMKH4ED', title: 'Obesity and overweight', url: 'https://www.who.int/x',
        details: { kind: 'webpage' as const, site: 'who.int', site_name: 'World Health Organization' }, library_items: [],
    };

    it('labels a web search by its query and counts the pages it found', () => {
        const part = toolCall({ tool_name: 'web_search', args: { query: 'obesity prevalence', objective: 'WHO figures' } });
        expect(getToolCallLabel(part, 'in_progress')).toBe('Web search: obesity prevalence');
        const view = {
            view_type: 'external_reference_list' as const,
            tool_name: 'web_search',
            references: [page, { ...page, source_id: 'web-X45SUKGLKI' }],
            tool_info: { info_type: 'search' as const, source: 'exa', source_label: 'Web', returned: 2 },
        };
        expect(getToolCallLabel(part, 'completed', { view })).toBe('Web search: obesity prevalence (2 results)');
    });

    it('leaves the official-answer prefix out of a web search label', () => {
        const part = toolCall({
            tool_name: 'web_search',
            args: { query: 'Prefer a specific primary or official answer page. WHO adult obesity prevalence' },
        });
        expect(getToolCallLabel(part, 'in_progress')).toBe('Web search: WHO adult obesity prevalence');
        const bare = toolCall({ tool_name: 'web_search', args: { query: 'Prefer a specific primary or official answer page.' } });
        expect(getToolCallLabel(bare, 'in_progress')).toBe('Web search');
    });

    it('labels a web read with the site, without its synthetic page range', () => {
        const part = toolCall({ tool_name: 'read', args: { file: 'web-MJNNMKH4ED', pages: '1-3' } });
        const view = { view_type: 'external_reference_list' as const, tool_name: 'read', references: [page] };
        expect(getToolCallLabel(part, 'completed', { view })).toBe('Reading: World Health Organization');
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
            .toBe('ClinicalTrials.gov search: obesity · semaglutide');
        expect(getToolCallLabel(toolCall({ tool_name: 'get_trial', args: { nct_ids: ['NCT03548935'] } }), 'in_progress'))
            .toBe('ClinicalTrials.gov record: NCT03548935');
    });

    it('counts the trials of a trial lookup that also lists their publications', () => {
        const part = toolCall({ tool_name: 'get_trial', args: { nct_ids: ['NCT03548935'] } });
        const references = [
            { source: 'clinicaltrials', source_id: 'NCT03548935', details: { kind: 'trial' as const }, library_items: [] },
            { source: 'pubmed', source_id: 'pmid:1', details: { kind: 'work' as const }, library_items: [] },
            { source: 'pubmed', source_id: 'pmid:2', library_items: [] },
        ];
        const view = { view_type: 'external_reference_list' as const, tool_name: 'get_trial', references };
        expect(getToolCallLabel(part, 'completed', { view: { ...view, found_count: 1 } })).toBe('ClinicalTrials.gov record: NCT03548935 (1 found)');
    });
});


describe('OpenAlex and trial search labels', () => {
    const openAlexView = (shown: number, total: number | null, filters: Record<string, unknown> = {}) => ({
        view_type: 'external_reference_list' as const,
        tool_name: 'openalex_search_by_keywords',
        references: Array.from({ length: shown }, (_, i) => ({ source: 'openalex', source_id: `W${i}`, library_items: [] })),
        tool_info: {
            info_type: 'search' as const, source: 'openalex', source_label: 'OpenAlex',
            filters, total_count: total, returned: shown,
        },
    });

    it('labels a topic search by its query and counts its reranked list, which has no total', () => {
        const part = toolCall({ tool_name: 'openalex_search_by_topic', args: { query: 'peer effects in classrooms' } });
        expect(getToolCallLabel(part, 'in_progress')).toBe('Literature search: peer effects in classrooms');
        expect(getToolCallLabel(part, 'completed', { view: openAlexView(18, null) }))
            .toBe('Literature search: peer effects in classrooms (18 results)');
    });

    it('labels a keyword search by its query and its page of the hits', () => {
        const part = toolCall({ tool_name: 'openalex_search_by_keywords', args: { query: '"growth mindset" AND intervention' } });
        expect(getToolCallLabel(part, 'completed', { view: openAlexView(20, 1234) }))
            .toBe('Literature search: "growth mindset" AND intervention (20 of 1234)');
    });

    it('labels a filter-only listing by the author and venue names passed while it runs', () => {
        const part = toolCall({
            tool_name: 'openalex_search_by_keywords',
            args: { authors: ['Legewie', 'A5036443997'], venues: ['American Sociological Review'], min_year: 2016, max_year: 2016 },
        });
        expect(getToolCallLabel(part, 'in_progress'))
            .toBe('Literature search: Works by Legewie, A5036443997 in American Sociological Review, 2016');
    });

    it('labels a filter-only listing by the names the view resolved, and by ids while it runs', () => {
        const part = toolCall({
            tool_name: 'openalex_search_by_keywords',
            args: { author_ids: ['A5012345678'], venue_ids: ['S1', 'S2'], min_year: 2020, sort: 'citations' },
        });
        expect(getToolCallLabel(part, 'in_progress'))
            .toBe('Literature search: Works by A5012345678 in S1, S2, since 2020');
        const view = openAlexView(20, 87, {
            authors: ['Katrin Wisniewski (A5012345678)'],
            venues: ['Nature (S1)', 'S2'],
        });
        expect(getToolCallLabel(part, 'completed', { view }))
            .toBe('Literature search: Works by Katrin Wisniewski in Nature, S2, since 2020 (20 of 87)');
        expect(getToolCallLabel(toolCall({ tool_name: 'openalex_search_by_keywords', args: { min_year: 2021, max_year: 2021 } }), 'in_progress'))
            .toBe('Literature search: Works 2021');
        expect(getToolCallLabel(toolCall({
            tool_name: 'openalex_search_by_keywords',
            args: { work_types: ['book'], language: 'DE', open_access_only: true, sort: 'newest' },
        }), 'completed')).toBe('Literature search: Works (book, de, open access)');
    });

    it('shows the query, not the progress line that repeats it, while a search runs', () => {
        const part = toolCall({
            tool_name: 'openalex_search_by_topic',
            args: { query: 'peer effects' },
            progress: 'Searching OpenAlex: peer effects',
        });
        expect(getToolCallLabel(part, 'in_progress')).toBe('Literature search: peer effects');
    });

    it('labels a name lookup by its kind and names, and counts candidates or found names', () => {
        const one = toolCall({ tool_name: 'openalex_resolve_names', args: { names: ['Katrin Wisniewski'], kind: 'author' } });
        const names = (results: Array<{ query: string; candidates: unknown[] }>) => ({
            view_type: 'openalex_names' as const, kind: 'author' as const, results: results as any,
        });
        expect(getToolCallLabel(one, 'in_progress')).toBe('Author lookup: Katrin Wisniewski');
        expect(getToolCallLabel(one, 'completed', { view: names([{ query: 'Katrin Wisniewski', candidates: [{}, {}] }]) }))
            .toBe('Author lookup: Katrin Wisniewski (2 candidates)');
        expect(getToolCallLabel(one, 'completed', { view: names([{ query: 'Katrin Wisniewski', candidates: [] }]) }))
            .toBe('Author lookup: Katrin Wisniewski (not found)');

        const three = toolCall({ tool_name: 'openalex_resolve_names', args: { names: ['Nature', 'Science', 'Cell'], kind: 'venue' } });
        const view = names([
            { query: 'Nature', candidates: [{}] },
            { query: 'Science', candidates: [] },
            { query: 'Cell', candidates: [{}] },
        ]);
        expect(getToolCallLabel(three, 'completed', { view })).toBe('Journal lookup: Nature, Science, Cell (2 of 3 found)');
    });

    it('names the database capabilities a load_capability call loads', () => {
        const load = (id: string) => getToolCallLabel(toolCall({ tool_name: 'load_capability', args: { id } }), 'completed');
        expect(load('openalex')).toBe('Loading tools: Literature Search');
        expect(load('pubmed_search')).toBe('Loading tools: PubMed Search');
        expect(load('clinical_trials')).toBe('Loading tools: Clinical Trials');
    });

    it('labels trials_search like the search it replaces, from its terms only', () => {
        expect(getToolCallLabel(toolCall({ tool_name: 'trials_search', args: { condition: 'obesity', intervention: 'semaglutide' } }), 'in_progress'))
            .toBe('ClinicalTrials.gov search: obesity · semaglutide');
        expect(getToolCallLabel(toolCall({ tool_name: 'trials_search', args: { condition: 'obesity', search_label: 'Stale' } }), 'in_progress'))
            .toBe('ClinicalTrials.gov search: obesity');
    });

    it('keeps the model-written search_label of searches in older threads', () => {
        expect(getToolCallLabel(toolCall({ tool_name: 'external_search', args: { query: 'x', search_label: 'Peer effects' } }), 'completed'))
            .toBe('Web search: Peer effects');
        expect(getToolCallLabel(toolCall({ tool_name: 'search_trials', args: { condition: 'obesity', search_label: 'Obesity trials' } }), 'completed'))
            .toBe('ClinicalTrials.gov search: Obesity trials');
        expect(getToolCallLabel(toolCall({ tool_name: 'external_search', args: { query: 'peer effects' } }), 'completed'))
            .toBe('Web search: peer effects');
    });
});

describe('toolCallSearchText', () => {
    it('gives the full search the label truncates, and nothing for other tools', () => {
        const long = 'school desegregation effects on Black student achievement in Southern districts';
        expect(toolCallSearchText(toolCall({ tool_name: 'openalex_search_by_topic', args: { query: long } }))).toBe(long);
        expect(toolCallSearchText(toolCall({ tool_name: 'openalex_resolve_names', args: { names: '["A", "B", "C"]', kind: 'author' } })))
            .toBe('A, B, C');
        expect(toolCallSearchText(toolCall({ tool_name: 'trials_search', args: { query: 'randomized', condition: 'obesity' } })))
            .toBe('randomized · obesity');
        expect(toolCallSearchText(toolCall({ tool_name: 'search_trials', args: { condition: 'obesity', search_label: 'Obesity trials' } })))
            .toBe('Obesity trials');
        expect(toolCallSearchText(toolCall({ tool_name: 'item_search_by_topic', args: { query: 'x' } }))).toBeNull();
    });
});
