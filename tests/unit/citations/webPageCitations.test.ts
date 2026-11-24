import { describe, expect, it } from 'vitest';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import type { CitedSource } from '@beaver/agent-core/types/citations';
import { mergeWebPagesByDoi } from '@beaver/agent-ui/chat/CitedSourcesList';
import { externalReferenceToCsl, externalReferenceUri } from '@beaver/agent-export/citations/externalCsl';
import { externalRecordPresentation } from '@beaver/agent-core/citations/externalRecordDisplay';

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
