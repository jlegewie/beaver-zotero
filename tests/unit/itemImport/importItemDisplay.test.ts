import { describe, expect, it } from 'vitest';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import type { ImportItemProposedData } from '@beaver/agent-core/types/itemImport';
import {
    enrichmentNote,
    importActionReference,
    importSourceBadge,
} from '../../../react/utils/importItemDisplay';

const data = (overrides: Partial<ImportItemProposedData> = {}): ImportItemProposedData => ({
    source: { kind: 'identifier', input: 'doi:10.1/x' },
    ...overrides,
});

describe('importSourceBadge', () => {
    it('returns null without data or any recognizable source', () => {
        expect(importSourceBadge(undefined)).toBeNull();
        expect(importSourceBadge(data({ source: { kind: 'file', input: 'a.pdf' } }))).toBeNull();
    });

    it('flags model-written metadata as a caution', () => {
        expect(importSourceBadge(data({ resolution: { method: 'model_metadata' } })))
            .toMatchObject({ label: 'Metadata written by Beaver', caution: true });
    });

    it('flags fallback metadata as partial', () => {
        expect(importSourceBadge(data({ resolution: { method: 'fallback_metadata' } })))
            .toMatchObject({ label: 'Partial metadata', caution: true });
    });

    it('labels recognizer results as identified from file, without caution', () => {
        for (const method of ['recognizer', 'recognizer_deferred']) {
            expect(importSourceBadge(data({ resolution: { method } })))
                .toMatchObject({ label: 'Identified from file', caution: false });
        }
    });

    it('labels web translation and mentions the translator in the tooltip', () => {
        const badge = importSourceBadge(data({ resolution: { method: 'web_translator', translator: 'Embedded Metadata' } }));
        expect(badge).toMatchObject({ label: 'From web page', caution: false });
        expect(badge?.tooltip).toContain('Embedded Metadata');
    });

    it('names the search provider for external sources', () => {
        expect(importSourceBadge(data({
            source: { kind: 'external', input: 'W1', provider: 'openalex' },
            resolution: { method: 'translator', translator: 'CrossRef' },
        }))).toMatchObject({ label: 'via OpenAlex', caution: false, tooltip: expect.stringContaining('CrossRef') });
        expect(importSourceBadge(data({ source: { kind: 'external', input: 'x', provider: 'openlibrary' } })))
            .toMatchObject({ label: 'via Open Library' });
        expect(importSourceBadge(data({ source: { kind: 'external', input: 'x', provider: 'exa' } })))
            .toMatchObject({ label: 'via Exa' });
    });

    it.each([
        ['doi', 'via DOI'], ['isbn', 'via ISBN'], ['arxiv', 'via arXiv'], ['pmid', 'via PubMed'], ['pmcid', 'via PubMed Central'],
    ] as const)('names the %s identifier', (type, label) => {
        expect(importSourceBadge(data({
            source: { kind: 'identifier', input: 'x', identifier: { type, value: 'v' } },
        }))?.label).toBe(label);
    });

    it('reads the identifier of a pending (citation-derived) action', () => {
        expect(importSourceBadge(data({
            source: { kind: 'external', input: 'W1' },
            pending_resolution: { identifier: { type: 'doi', value: '10.1/x' } },
        }))?.label).toBe('via DOI');
    });

    it('labels a url source as from web page', () => {
        expect(importSourceBadge(data({ source: { kind: 'url', input: 'https://x.org', url: 'https://x.org' } })))
            .toMatchObject({ label: 'From web page' });
    });

    it('lets the resolution method take precedence over the source', () => {
        expect(importSourceBadge(data({
            source: { kind: 'external', input: 'W1', provider: 'openalex' },
            resolution: { method: 'model_metadata' },
        }))?.label).toBe('Metadata written by Beaver');
    });
});

describe('enrichmentNote', () => {
    it('is null when nothing was enriched', () => {
        expect(enrichmentNote(undefined)).toBeNull();
        expect(enrichmentNote(data())).toBeNull();
        expect(enrichmentNote(data({ enrichment: {} }))).toBeNull();
    });

    it('describes the filled field and its provider', () => {
        expect(enrichmentNote(data({ enrichment: { abstractNote: 'openalex' } }))).toBe('Abstract from OpenAlex');
    });

    it('joins several fields and falls back to raw names for unknown ones', () => {
        expect(enrichmentNote(data({
            enrichment: { abstractNote: 'search_result', language: 'zotero_recognizer', pages: 'crossref' },
        }))).toBe("Abstract from the search result; Language from Zotero's recognizer; pages from crossref");
    });
});

describe('importActionReference', () => {
    const known: ExternalReference = {
        source: 'openalex',
        source_id: 'W123',
        title: 'Known paper',
        library_items: [],
        cited_by_count: 42,
    } as ExternalReference;

    it('prefers the search result already in the citation mapping', () => {
        const reference = importActionReference(
            data({ source: { kind: 'external', input: 'W123', external_id: 'W123' } }),
            { W123: known },
        );
        expect(reference).toBe(known);
    });

    it('derives a reference from the resolved item when the mapping has no entry', () => {
        const reference = importActionReference(
            data({
                source: { kind: 'external', input: 'W999', external_id: 'W999' },
                item: {
                    itemType: 'journalArticle',
                    title: 'Derived',
                    creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }, { creatorType: 'author', name: 'Org' }],
                    date: '2015-05-28',
                    publicationTitle: 'Nature',
                    abstractNote: 'Abstract',
                    DOI: '10.1038/x',
                },
            }),
            {},
        );
        expect(reference).toMatchObject({
            source: 'openalex',
            source_id: 'W999',
            title: 'Derived',
            authors: ['Ada Lovelace', 'Org'],
            year: 2015,
            venue: 'Nature',
            abstract: 'Abstract',
            url: 'https://doi.org/10.1038/x',
            identifiers: { doi: '10.1038/x' },
            library_items: [],
        });
    });

    it('derives from the pending fallback metadata and prefers an explicit url over the DOI link', () => {
        const reference = importActionReference(
            data({
                source: { kind: 'identifier', input: 'doi:10.1/x' },
                pending_resolution: {
                    fallback_item: { itemType: 'book', title: 'Book', ISBN: '9780262035613', url: 'https://x.org/book' },
                },
            }),
            {},
        );
        expect(reference).toMatchObject({
            source_id: 'doi:10.1/x',
            title: 'Book',
            url: 'https://x.org/book',
            identifiers: { isbn: '9780262035613' },
        });
        expect(reference.year).toBeUndefined();
    });

    it('handles an action without any item metadata', () => {
        const reference = importActionReference(data(), {});
        expect(reference).toMatchObject({ source_id: 'doi:10.1/x', authors: [], identifiers: {}, library_items: [] });
        expect(reference.title).toBeUndefined();
    });
});
