import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider, createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalReferenceListView } from '@beaver/agent-core/run-state/toolResultViews';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { setHost } from '@beaver/agent-ui/host';
import {
    ExternalReferenceListResultView,
    searchFilterLabels,
} from '../../../react/components/agentRuns/toolResultViews/ExternalReferenceListResultView';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

/** Records the props each row hands the host's action buttons. */
const actionProps: any[] = [];
setHost({
    components: {
        externalReferenceActions: (props: any) => {
            actionProps.push(props);
            return null;
        },
    },
} as any);

function render(view: ExternalReferenceListView, detailsOpen = false): string {
    actionProps.length = 0;
    return renderToStaticMarkup(
        React.createElement(Provider, { store: createStore() }, React.createElement(ExternalReferenceListResultView, {
            view,
            searchDetails: { open: detailsOpen, id: 'search-details-call' },
        })),
    );
}

const pubmedRecord: ExternalReference = {
    source: 'pubmed',
    source_id: 'W4390000001',
    retrieved_at: '2026-11-02T14:00:00Z',
    title: 'Semaglutide and weight loss',
    authors: ['Lee, Min'],
    year: 2024,
    journal: { name: 'New England Journal of Medicine', volume: '390', issue: '9', pages: '801-812' },
    zotero_fields: { journalAbbreviation: 'N Engl J Med' },
    identifiers: { pmid: '41234567', pmcid: 'PMC1', doi: '10.1056/x' },
    raw_publication_types: ['Randomized Controlled Trial'],
    is_retracted: true,
    details: { kind: 'work', pmc_free_after: '2020-01-01' },
    library_items: [],
};

const openalexSnapshot: ExternalReference = {
    source: 'openalex',
    source_id: 'W4390000001',
    retrieved_at: '2026-11-02T14:00:01Z',
    citation_count: 812,
    library_items: [],
};

const trialRecord: ExternalReference = {
    source: 'clinicaltrials',
    source_id: 'NCT03548935',
    title: 'Official title',
    item_type: 'report',
    url: 'https://clinicaltrials.gov/study/NCT03548935',
    zotero_fields: { reportNumber: 'NCT03548935', institution: 'clinicaltrials.gov' },
    details: {
        kind: 'trial',
        brief_title: 'Semaglutide Trial',
        status: 'TERMINATED',
        why_stopped: 'Sponsor decision',
        phases: ['PHASE3'],
        study_type: 'INTERVENTIONAL',
        enrollment_count: 500,
        enrollment_type: 'ESTIMATED',
        conditions: ['A', 'B', 'C', 'D', 'E', 'F'],
        interventions: [{ name: 'Semaglutide', type: 'DRUG' }],
        lead_sponsor: 'Novo Nordisk A/S',
        start_date: '2018-06',
        primary_completion_date: '2020-03',
        has_results: true,
        documents: [{ type_abbrev: 'Prot_SAP', label: 'Study Protocol and Statistical Analysis Plan' }],
    },
    library_items: [],
};

describe('ExternalReferenceListResultView', () => {
    it('renders a PubMed search with its header and the combined record per row', () => {
        const html = render({
            view_type: 'external_reference_list',
            tool_name: 'pubmed_search',
            references: [pubmedRecord],
            extra_snapshots: [openalexSnapshot],
            tool_info: {
                info_type: 'search',
                source: 'pubmed',
                source_label: 'PubMed',
                query: 'semaglutide obesity',
                query_translation: '"semaglutide"[MeSH Terms] AND "obesity"[MeSH Terms]',
                filters: { min_year: 2020, max_year: 2024 },
                total_count: 155,
                returned: 1,
                offset: 0,
                search_url: 'https://pubmed.ncbi.nlm.nih.gov/?term=semaglutide+obesity',
                attribution: 'Courtesy of the U.S. National Library of Medicine',
            },
        });
        expect(html).not.toContain('Showing');
                expect(html).toContain('Courtesy of the U.S. National Library of Medicine');
        expect(html).not.toContain('search-details-call');
        expect(html).toContain('N Engl J Med. 2024;390(9):801-812.');
        expect(html).toContain('PMID 41234567');
        expect(html).toContain('Randomized Controlled Trial');
        expect(html).toContain('Free PMC article');
        expect(html).toContain('Retracted');
        expect(actionProps[0].item.citation_count).toBe(812);
        expect(actionProps[0].webUrl).toBe('https://pubmed.ncbi.nlm.nih.gov/41234567/');
    });

    it('renders a trial search with the registry\'s required attribution and the trial row', () => {
        const html = render({
            view_type: 'external_reference_list',
            tool_name: 'search_trials',
            references: [trialRecord],
            tool_info: {
                info_type: 'search',
                source: 'clinicaltrials',
                source_label: 'ClinicalTrials.gov',
                filters: { condition: 'obesity', status: ['recruiting'], phase: ['phase3'] },
                total_count: 1,
                returned: 1,
                data_as_of: '2026-10-30',
                attribution: 'Source: ClinicalTrials.gov',
                search_url: 'https://clinicaltrials.gov/search?cond=obesity',
            },
        });
        expect(html).toContain('Data as of Oct 30, 2026 · Source: ClinicalTrials.gov');
        expect(html).toContain('Semaglutide Trial');
        expect(html).toContain('Terminated');
        expect(html).toContain('Phase 3 · Interventional · 500 participants (est.)');
        expect(html).toContain('Novo Nordisk A/S');
        expect(html).toContain('A, B, C, D, E +1 more');
        expect(html).toContain('Results posted');
        expect(html).toContain('Protocol &amp; SAP');
        expect(html).toContain('Jun 2018');
        expect(html).toContain('Mar 2020');
        expect(actionProps[0].webUrl).toBe('https://clinicaltrials.gov/study/NCT03548935');
    });

    it('renders get_trial rows as trials with the registry attribution but no search header', () => {
        const html = render({ view_type: 'external_reference_list', tool_name: 'get_trial', references: [trialRecord], found_count: 1 });
        expect(html).toContain('Semaglutide Trial');
        expect(html).toContain('Source: ClinicalTrials.gov');
        expect(html).not.toContain('Open on');
    });

    it('renders unknown details and an unknown info_type as plain cards', () => {
        const html = render({
            view_type: 'external_reference_list',
            tool_name: 'future_search',
            references: [{ source: 'eric', source_id: 'eric:1', title: 'A future record', details: { kind: 'webpage', site: 'x' }, library_items: [] }],
            tool_info: { info_type: 'graph', nodes: 3 },
        });
        expect(html).toContain('A future record');
        expect(html).not.toContain('Showing');
    });

    it('renders a related-works view stored before the discriminator existed', () => {
        const html = render({
            view_type: 'external_reference_list',
            tool_name: 'find_related_works',
            references: [],
            tool_info: { relation: 'references', total_count: 0, work: null } as any,
        });
        expect(html).toContain('No references found');
    });
});

describe('search details panel', () => {
    const view: ExternalReferenceListView = {
        view_type: 'external_reference_list',
        tool_name: 'pubmed_search',
        references: [pubmedRecord],
        tool_info: {
            info_type: 'search',
            source: 'pubmed',
            source_label: 'PubMed',
            query: 'semaglutide obesity',
            query_translation: '"semaglutide"[MeSH Terms] AND "obesity"[MeSH Terms]',
            filters: { min_year: 2020, max_year: 2024 },
            returned: 1,
        },
    };

    it('shows the query, filters and the query as PubMed ran it, with a copy button', () => {
        const html = render(view, true);
        expect(html).toContain('id="search-details-call"');
        expect(html).toContain('>Query<');
        expect(html).toContain('semaglutide obesity');
        expect(html).toContain('Published 2020–2024');
        expect(html).toContain('As PubMed ran it');
        expect(html).toContain('aria-label="Copy the query as PubMed ran it"');
    });

    it('opens on an empty search too', () => {
        const html = render({ ...view, references: [] }, true);
        expect(html).toContain('As PubMed ran it');
        expect(html).toContain('No results in PubMed');
    });
});

describe('trial details', () => {
    it('lists the registry link, summary, documents and data date', async () => {
        const { default: ExternalReferenceDetails } = await import('../../../react/components/externalReferences/ExternalReferenceDetails');
        const html = renderToStaticMarkup(React.createElement(Provider, { store: createStore() },
            React.createElement(ExternalReferenceDetails, { item: { ...trialRecord, abstract: 'Summary text', details: { ...(trialRecord.details as any), data_as_of: '2026-10-30' } } })));
        expect(html).toContain('ClinicalTrials.gov</a>');
        expect(html).toContain('Summary text');
        expect(html).toContain('Study Protocol and Statistical Analysis Plan');
        expect(html).toContain('Data as of Oct 30, 2026');
    });
});

describe('searchFilterLabels', () => {
    it('labels known filters and shows unknown ones as key and value', () => {
        expect(searchFilterLabels({
            query: 'x', status: ['recruiting', 'not_yet_recruiting'], has_results: true,
            start_year_min: 2018, sort: 'newest', future_flag: 'on',
        })).toEqual(['Recruiting, Not yet recruiting', 'With results', 'Started 2018 or later', 'Newest first', 'Future flag: on']);
    });
});
