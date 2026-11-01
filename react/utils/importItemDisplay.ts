/**
 * Display helpers for `import_item` actions (create_items v2): the source
 * badge, the enrichment note, and an `ExternalReference`-shaped view for the
 * citation "Import" card, which predates Zotero item JSON.
 */

import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import {
    importItemDisplayJson,
    itemJsonDisplay,
    type ImportItemProposedData,
    type ZoteroItemJson,
} from '@beaver/agent-core/types/itemImport';

export interface SourceBadge {
    label: string;
    /** Metadata nothing checked against a database: shown as a caution. */
    caution: boolean;
    tooltip?: string;
}

const IDENTIFIER_LABEL: Record<string, string> = {
    doi: 'DOI',
    isbn: 'ISBN',
    arxiv: 'arXiv',
    pmid: 'PubMed',
    pmcid: 'PubMed Central',
};

const PROVIDER_LABEL: Record<string, string> = {
    openalex: 'OpenAlex',
    openlibrary: 'Open Library',
    exa: 'Exa',
};

const ENRICHMENT_PROVIDER_LABEL: Record<string, string> = {
    openalex: 'OpenAlex',
    search_result: 'the search result',
    zotero_recognizer: "Zotero's recognizer",
};

const FIELD_LABEL: Record<string, string> = {
    abstractNote: 'Abstract',
    language: 'Language',
};

/** Where an item's metadata came from, as a short badge. Model-written metadata has none. */
export function importSourceBadge(data: ImportItemProposedData | undefined): SourceBadge | null {
    if (!data) return null;
    const method = data.resolution?.method;
    const translator = data.resolution?.translator;
    const translatorTip = translator ? `Translator: ${translator}` : undefined;
    if (method === 'model_metadata') return null;
    if (method === 'fallback_metadata') {
        return { label: 'Partial metadata', caution: true, tooltip: 'Lookup failed; from the search result' };
    }
    if (method === 'recognizer') {
        return { label: 'Identified from file', caution: false, tooltip: translatorTip };
    }
    if (method === 'web_translator') {
        return { label: 'From web page', caution: false, tooltip: translatorTip };
    }
    const source = data.source;
    if (source?.kind === 'external' && source.provider) {
        return { label: `via ${PROVIDER_LABEL[source.provider] ?? source.provider}`, caution: false, tooltip: translatorTip };
    }
    const identifierType = source?.identifier?.type ?? data.pending_resolution?.identifier?.type;
    if (identifierType) {
        return { label: `via ${IDENTIFIER_LABEL[identifierType] ?? identifierType}`, caution: false, tooltip: translatorTip };
    }
    if (source?.kind === 'url') return { label: 'From web page', caution: false, tooltip: translatorTip };
    return null;
}

/**
 * What the item was looked up from, for the details view: "DOI 10.1038/…",
 * a URL, or the search result. Null for model-written metadata.
 */
export function importSourceDetail(data: ImportItemProposedData | undefined): string | null {
    if (!data || data.resolution?.method === 'model_metadata') return null;
    const source = data.source;
    const identifier = source?.identifier ?? data.pending_resolution?.identifier;
    if (identifier) return `${IDENTIFIER_LABEL[identifier.type] ?? identifier.type} ${identifier.value}`;
    if (source?.kind === 'url' && (source.url || data.pending_resolution?.url)) return source.url ?? data.pending_resolution!.url!;
    if (source?.kind === 'external' && source.provider) {
        const provider = PROVIDER_LABEL[source.provider] ?? source.provider;
        return source.external_id ? `${provider} search result ${source.external_id}` : `${provider} search result`;
    }
    if (data.resolution?.method === 'recognizer') return 'Identified from the attached file';
    return null;
}

/** "Abstract from OpenAlex" for fields enrichment filled in. */
export function enrichmentNote(data: ImportItemProposedData | undefined): string | null {
    const entries = Object.entries(data?.enrichment ?? {});
    if (!entries.length) return null;
    return entries
        .map(([field, provider]) => `${FIELD_LABEL[field] ?? field} from ${ENRICHMENT_PROVIDER_LABEL[provider] ?? provider}`)
        .join('; ');
}

function creatorNames(json: ZoteroItemJson | undefined): string[] {
    return (json?.creators ?? [])
        .map((creator) => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(' '))
        .filter((name): name is string => !!name && !!name.trim());
}

/**
 * The reference a citation-derived `import_item` action stands for, for the
 * citation card. Prefers the search result already in the citation mapping
 * (it carries citation counts and open-access links); otherwise derives one
 * from the action's fallback metadata.
 */
export function importActionReference(
    data: ImportItemProposedData,
    mapping: Record<string, ExternalReference>,
): ExternalReference {
    const externalId = data.source?.external_id;
    const known = externalId ? mapping[externalId] : undefined;
    if (known) return known;
    const json = importItemDisplayJson(data);
    const display = json ? itemJsonDisplay(json) : undefined;
    const doi = display?.doi;
    return {
        source: 'openalex',
        source_id: externalId ?? data.source?.input ?? '',
        title: display?.title,
        authors: creatorNames(json),
        year: display?.year ? Number(display.year) : undefined,
        venue: display?.venue,
        abstract: display?.abstract,
        url: display?.url ?? (doi ? `https://doi.org/${doi}` : undefined),
        identifiers: {
            ...(doi ? { doi } : {}),
            ...(display?.isbn ? { isbn: display.isbn } : {}),
        },
        library_items: [],
    };
}
