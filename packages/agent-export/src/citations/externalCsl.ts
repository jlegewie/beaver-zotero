/**
 * Map an external reference (search-result metadata from the backend) to
 * CSL-JSON, so a citation processor can format it like a library item.
 */

import { NormalizedPublicationType, type ExternalReference } from '@beaver/agent-core/types/externalReferences';
import type { ZoteroCreatorJson } from '@beaver/agent-core/types/itemImport';
import { nctFromExternalId, pmidFromExternalId } from '@beaver/agent-core/citations/externalRecords';
import { pubmedUrl, trialRegistryUrl } from '@beaver/agent-core/citations/externalRecordDisplay';

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

/** Zotero item types as CSL types, as Zotero's own CSL export maps them. */
const ITEM_TYPE_CSL: Record<string, string> = {
    journalArticle: 'article-journal',
    magazineArticle: 'article-magazine',
    newspaperArticle: 'article-newspaper',
    conferencePaper: 'paper-conference',
    book: 'book',
    bookSection: 'chapter',
    thesis: 'thesis',
    report: 'report',
    preprint: 'article',
    dataset: 'dataset',
    webpage: 'webpage',
    blogPost: 'post-weblog',
    forumPost: 'post',
    encyclopediaArticle: 'entry-encyclopedia',
    dictionaryEntry: 'entry-dictionary',
    manuscript: 'manuscript',
    patent: 'patent',
    presentation: 'speech',
    document: 'document',
};

/** Zotero creator roles as CSL name variables; other roles are not cited. */
const CREATOR_ROLE_CSL: Record<string, string> = {
    author: 'author',
    contributor: 'contributor',
    editor: 'editor',
    bookAuthor: 'container-author',
    seriesEditor: 'collection-editor',
    translator: 'translator',
};

/** A Zotero creator as a CSL name: a person by name parts, an organization as a literal. */
function creatorName(creator: ZoteroCreatorJson): CslName | null {
    const family = creator.lastName?.trim();
    if (family) {
        const given = creator.firstName?.trim();
        return given ? { family, given } : { family };
    }
    const literal = creator.name?.trim();
    return literal ? { literal } : null;
}

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
    const fromItemType = ref.item_type ? ITEM_TYPE_CSL[ref.item_type] : undefined;
    if (fromItemType) return fromItemType;
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
    if (Array.isArray(ref.creators)) {
        // Creators carry roles and name parts; organizations stay whole.
        for (const creator of ref.creators) {
            const variable = CREATOR_ROLE_CSL[creator.creatorType || 'author'];
            const name = variable ? creatorName(creator) : null;
            if (!variable || !name) continue;
            csl[variable] = [...((csl[variable] as CslName[] | undefined) ?? []), name];
        }
    } else {
        const authors = (ref.authors ?? []).map(parseAuthorName).filter((name): name is CslName => !!name);
        if (authors.length > 0) csl.author = authors;
    }
    const issued = issuedDate(ref);
    if (issued) csl.issued = issued;
    const fields = ref.zotero_fields ?? {};
    const isReport = ref.item_type === 'report';
    const container = ref.journal?.name || ref.venue;
    // A report's venue is its institution (the publisher), not a container.
    if (container && !isReport) csl['container-title'] = container;
    if (fields.reportNumber) csl.number = fields.reportNumber;
    if (fields.reportType) csl.genre = fields.reportType;
    if (fields.institution) csl.publisher = fields.institution;
    if (fields.shortTitle) csl['title-short'] = fields.shortTitle;
    if (fields.journalAbbreviation) csl['container-title-short'] = fields.journalAbbreviation;
    if (ref.journal?.volume) csl.volume = ref.journal.volume;
    if (ref.journal?.issue) csl.issue = ref.journal.issue;
    if (ref.journal?.pages) csl.page = ref.journal.pages;
    const ids = ref.identifiers ?? {};
    if (ids.doi) csl.DOI = ids.doi;
    if (ids.isbn) csl.ISBN = ids.isbn;
    if (ids.issn) csl.ISSN = ids.issn;
    if (ids.pmid) csl.PMID = ids.pmid;
    if (ids.pmcid) csl.PMCID = ids.pmcid;
    const url = isReport ? ref.url || ref.publication_url : ref.publication_url || ref.url;
    if (url && (!ids.doi || isReport)) csl.URL = url;
    return csl;
}

/**
 * A stable URI for an external work. Zotero keys embedded items by URI on
 * refresh; with no URI every citation of the work becomes a separate item
 * (disambiguated as 2018a/2018b, numbered twice). The URI never resolves to a
 * library item, so Zotero keeps using the embedded `itemData`.
 */
export function externalReferenceUri(externalId: string, reference: ExternalReference): string {
    const doi = reference.identifiers?.doi;
    if (doi) return `https://doi.org/${doi}`;
    const nct = nctFromExternalId(externalId);
    if (nct) return trialRegistryUrl(nct);
    const pmid = pmidFromExternalId(externalId);
    if (pmid) return pubmedUrl(pmid);
    if (reference.source === 'openalex' || /^W\d+$/.test(externalId)) return `https://openalex.org/${encodeURIComponent(externalId)}`;
    if (reference.source === 'semantic_scholar') return `https://www.semanticscholar.org/paper/${encodeURIComponent(externalId)}`;
    return `urn:beaver:external:${encodeURIComponent(externalId)}`;
}
