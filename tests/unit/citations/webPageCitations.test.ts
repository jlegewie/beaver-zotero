import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider, createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import type { CitedSource } from '@beaver/agent-core/types/citations';
import CitedSourcesList, { mergeWebPagesByDoi } from '@beaver/agent-ui/chat/CitedSourcesList';
import { externalReferenceToCsl, externalReferenceUri } from '@beaver/agent-export/citations/externalCsl';
import { externalRecordPresentation } from '@beaver/agent-core/citations/externalRecordDisplay';
import { loadThreadRuns } from '@beaver/agent-core/run-state/loadThreadRuns';
import { runCitations, type Citation } from '@beaver/agent-core/types/citations';

const page = (id: string, fields: Partial<ExternalReference> = {}): ExternalReference => ({
    source: 'exa',
    source_id: id,
    url: `https://example.org/${id}`,
    title: 'A page',
    details: { kind: 'webpage', site: 'example.org', site_name: 'Example Org' },
    library_items: [],
    ...fields,
});

const cited = (externalId: string, numericCitation: string | null = null): CitedSource => ({
    citation_id: externalId,
    citation_type: 'external_reference',
    resolved_ref: { kind: 'external', external_id: externalId },
    numericCitation,
});

describe('web page citations in the sources list', () => {
    it('lists a paper cited by its work id and as a web page once, as the work', () => {
        const references = {
            W1: { source: 'openalex', source_id: 'W1', identifiers: { doi: '10.1/X' }, library_items: [] },
            'web-AAAAAAAAAA': page('web-AAAAAAAAAA', { identifiers: { doi: '10.1/x' } }),
            'web-BBBBBBBBBB': page('web-BBBBBBBBBB', { identifiers: { doi: '10.2/y' } }),
            'web-CCCCCCCCCC': page('web-CCCCCCCCCC', { identifiers: { doi: '10.2/Y' } }),
            'web-DDDDDDDDDD': page('web-DDDDDDDDDD'),
        };
        const merged = mergeWebPagesByDoi(
            [cited('web-AAAAAAAAAA', '1'), cited('W1', '2'), cited('web-BBBBBBBBBB', '3'), cited('web-CCCCCCCCCC', '4'), cited('web-DDDDDDDDDD', '5')],
            references,
        );
        expect(merged.map((citation) => [citation.citation_id, citation.numericCitation])).toEqual([
            ['W1', '1, 2'],
            ['web-BBBBBBBBBB', '3, 4'],
            ['web-DDDDDDDDDD', '5'],
        ]);
    });
});

describe('web page that is an arXiv or PubMed paper', () => {
    it('merges an arXiv page into the work by the arXiv DOI, and a PubMed page by its PMID', () => {
        const references = {
            W2: { source: 'openalex', source_id: 'W2', identifiers: { doi: '10.48550/arXiv.2307.09288' }, library_items: [] },
            'web-EEEEEEEEEE': page('web-EEEEEEEEEE', { identifiers: { arXivID: '2307.09288v2' } }),
            'pmid:123': { source: 'pubmed', source_id: 'pmid:123', identifiers: { pmid: '123' }, library_items: [] },
            'web-FFFFFFFFFF': page('web-FFFFFFFFFF', { identifiers: { pmid: '0123' } }),
        };
        const merged = mergeWebPagesByDoi(
            [cited('W2', '1'), cited('web-EEEEEEEEEE', '2'), cited('pmid:123', '3'), cited('web-FFFFFFFFFF', '4')],
            references,
        );
        expect(merged.map((citation) => [citation.citation_id, citation.numericCitation])).toEqual([['W2', '1, 2'], ['pmid:123', '3, 4']]);
    });
});

describe('web pages in exports and rows', () => {
    it('formats a page as a webpage with its site and access date, and names it by its URL', () => {
        const ref = page('web-AAAAAAAAAA', { item_type: 'webpage', retrieved_at: '2026-11-22T10:00:00Z', publication_date: '2026-03-01' });
        expect(externalReferenceToCsl(ref, 'x')).toMatchObject({
            type: 'webpage',
            title: 'A page',
            'container-title': 'Example Org',
            URL: 'https://example.org/web-AAAAAAAAAA',
            accessed: { 'date-parts': [[2026, 11, 22]] },
            issued: { 'date-parts': [[2026, 3, 1]] },
        });
        expect(externalReferenceUri('web-AAAAAAAAAA', ref)).toBe('https://example.org/web-AAAAAAAAAA');
    });

    it('presents web pages with their own row', () => {
        expect(externalRecordPresentation('exa', page('web-AAAAAAAAAA'))).toBe('webpage');
        // A web read's view has no search source; the record decides.
        expect(externalRecordPresentation(undefined, page('web-AAAAAAAAAA'))).toBe('webpage');
        expect(externalRecordPresentation('openalex', { source: 'openalex', library_items: [] })).toBe('generic');
    });
});


describe('a web page in the sources list', () => {
    it('is listed by its title and its site and date, beside a library item listed as before', () => {
        const icon = 'data:image/webp;base64,UklGRhwAAABXRUJQ';
        const webPage: CitedSource = {
            ...cited('web-AAAAAAAAAA', '1'),
            display_name: 'nyc.gov 2024',
            formatted_citation: 'nyc.gov. 2024. "Crime and Enforcement Activity." Accessed 2026-11-26.',
            web_page: { url: 'https://www.nyc.gov/report.pdf', title: 'Crime and Enforcement Activity', site: 'nyc.gov', published: '2024-01', icon },
        };
        const paper = {
            citation_id: 'c-paper',
            citation_type: 'item',
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ABCD2345' },
            display_name: 'Figures & Legewie 2019',
            formatted_citation: 'Figures, Kalisha Dessources, and Joscha Legewie (2019). Visualizing Police Exposure.',
            numericCitation: '2',
        } as unknown as CitedSource;

        const html = renderToStaticMarkup(
            React.createElement(Provider, { store: createStore() }, React.createElement(CitedSourcesList, { citations: [webPage, paper] })),
        );

        expect(html).toContain('Crime and Enforcement Activity');
        expect(html).toContain('nyc.gov · Jan 2024');
        expect(html).toContain(`src="${icon}"`);
        expect(html).not.toContain('nyc.gov 2024');
        expect(html).toContain('Figures &amp; Legewie 2019');
        expect(html).toContain('Figures, Kalisha Dessources, and Joscha Legewie (2019)');
    });
});


describe('site icons beside a run\'s citations', () => {
    const icon = 'data:image/webp;base64,UklGRhwAAABXRUJQ';
    const webCitation = (id: string, url: string, iconHost?: string): Citation => ({
        citation_id: id,
        citation_type: 'external_reference',
        resolved_ref: { kind: 'external', external_id: id },
        web_page: { url, title: 'A page', ...(iconHost ? { icon_host: iconHost } : {}) },
    } as unknown as Citation);

    it('fill each web page citation\'s icon from the map by its host', () => {
        const citations = [
            webCitation('web-AAAAAAAAAA', 'https://www.who.int/a', 'www.who.int'),
            webCitation('web-BBBBBBBBBB', 'https://www.who.int/b', 'www.who.int'),
            webCitation('web-CCCCCCCCCC', 'https://www.cdc.gov/c'),
            cited('W1') as unknown as Citation,
        ];
        const filled = runCitations('run-1', citations, { 'www.who.int': icon });

        expect(filled.map((citation) => [citation.run_id, citation.web_page?.icon])).toEqual([
            ['run-1', icon], ['run-1', icon], ['run-1', undefined], ['run-1', undefined],
        ]);
        expect(citations[0].web_page?.icon).toBeUndefined();
        expect(runCitations('run-1', citations, null).map((citation) => citation.web_page?.icon)).toEqual([
            undefined, undefined, undefined, undefined,
        ]);
    });

    it('are filled in for each run of a loaded thread from its metadata', async () => {
        const run = (id: string, citations: Citation[], siteIcons?: Record<string, string>) => ({
            id,
            status: 'completed',
            user_prompt: { attachments: [] },
            model_messages: [],
            metadata: { citations, ...(siteIcons ? { site_icons: siteIcons } : {}) },
        });
        const history = {
            runs: [
                run('run-1', [webCitation('web-AAAAAAAAAA', 'https://www.who.int/a', 'www.who.int')], { 'www.who.int': icon }),
                // Another run's map does not apply: each run keeps its own.
                run('run-2', [webCitation('web-BBBBBBBBBB', 'https://www.who.int/b', 'www.who.int')]),
            ],
            agent_actions: null,
            tail_run_id: 'run-2',
            activity: { state: 'idle', run_id: null },
        };

        const loaded = await loadThreadRuns('thread-1', { history } as any);

        expect(loaded.citations.map((citation) => [citation.run_id, citation.web_page?.icon])).toEqual([
            ['run-1', icon],
            ['run-2', undefined],
        ]);
    });
});
