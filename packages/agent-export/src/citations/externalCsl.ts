/**
 * Map an external reference (search-result metadata from the backend) to
 * CSL-JSON, so a citation processor can format it like a library item.
 */

import { NormalizedPublicationType, type ExternalReference } from '@beaver/agent-core/types/externalReferences';

export type CslName = { family: string; given?: string } | { literal: string };

const CSL_TYPES: Partial<Record<NormalizedPublicationType, string>> = {
    [NormalizedPublicationType.JOURNAL_ARTICLE]: 'article-journal',
    [NormalizedPublicationType.CONFERENCE_PAPER]: 'paper-conference',
    [NormalizedPublicationType.BOOK]: 'book',
    [NormalizedPublicationType.BOOK_CHAPTER]: 'chapter',
    [NormalizedPublicationType.REVIEW]: 'article-journal',
    [NormalizedPublicationType.META_ANALYSIS]: 'article-journal',
    [NormalizedPublicationType.EDITORIAL]: 'article-journal',
    [NormalizedPublicationType.CASE_REPORT]: 'article-journal',
    [NormalizedPublicationType.CLINICAL_TRIAL]: 'article-journal',
    [NormalizedPublicationType.DISSERTATION]: 'thesis',
    [NormalizedPublicationType.PREPRINT]: 'article',
    [NormalizedPublicationType.DATASET]: 'dataset',
    [NormalizedPublicationType.REPORT]: 'report',
    [NormalizedPublicationType.NEWS]: 'article-newspaper',
};

/** Split a plain author string (`Jane Q. Doe` or `Doe, Jane Q.`) into a CSL name. */
export function parseAuthorName(author: string): CslName | null {
    const name = author.trim().replace(/\s+/g, ' ');
    if (!name) return null;
    if (name.includes(',')) {
        const [family, ...rest] = name.split(',');
        const given = rest.join(',').trim();
        return given ? { family: family.trim(), given } : { family: family.trim() };
    }
    const parts = name.split(' ');
    if (parts.length === 1) return { literal: name };
    const family = parts.pop()!;
    return { family, given: parts.join(' ') };
}

function issuedDate(ref: ExternalReference): { 'date-parts': number[][] } | undefined {
    const match = ref.publication_date?.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
    if (match) {
        const parts = match.slice(1).filter(Boolean).map(Number);
        return { 'date-parts': [parts] };
    }
    if (ref.year != null && Number.isFinite(Number(ref.year))) {
        return { 'date-parts': [[Number(ref.year)]] };
    }
    return undefined;
}

function cslType(ref: ExternalReference): string {
    for (const type of ref.publication_types ?? []) {
        const mapped = CSL_TYPES[type];
        if (mapped) return mapped;
    }
    return ref.journal?.name ? 'article-journal' : 'article';
}

/** CSL-JSON for an external reference. `id` is the processor id to use. */
export function externalReferenceToCsl(ref: ExternalReference, id: string): Record<string, unknown> {
    const csl: Record<string, unknown> = { id, type: cslType(ref) };
    if (ref.title) csl.title = ref.title;
    const authors = (ref.authors ?? []).map(parseAuthorName).filter((name): name is CslName => !!name);
    if (authors.length > 0) csl.author = authors;
    const issued = issuedDate(ref);
    if (issued) csl.issued = issued;
    const container = ref.journal?.name || ref.venue;
    if (container) csl['container-title'] = container;
    if (ref.journal?.volume) csl.volume = ref.journal.volume;
    if (ref.journal?.issue) csl.issue = ref.journal.issue;
    if (ref.journal?.pages) csl.page = ref.journal.pages;
    const ids = ref.identifiers ?? {};
    if (ids.doi) csl.DOI = ids.doi;
    if (ids.isbn) csl.ISBN = ids.isbn;
    if (ids.issn) csl.ISSN = ids.issn;
    if (ids.pmid) csl.PMID = ids.pmid;
    if (ids.pmcid) csl.PMCID = ids.pmcid;
    const url = ref.publication_url || ref.url;
    if (url && !ids.doi) csl.URL = url;
    return csl;
}
