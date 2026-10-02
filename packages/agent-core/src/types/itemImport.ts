/**
 * Wire types for `create_items` v2 (the `import_item` action type).
 *
 * The canonical item representation is Zotero item JSON in the web-API form:
 * the shape translators produce and `Zotero.Item.fromJSON` accepts. The backend
 * classifies what the model passed into `ImportItemSpec`s, the plugin resolves
 * each spec to item JSON without writing (`validate_agent_action`), and execute
 * writes the approved `ImportItemProposedData` as-is.
 *
 * Mirrors `app/models/item_import.py` in the backend.
 */

import type { PdfCandidate, AttachmentStatus } from './agentActions/items';

export type IdentifierType = 'doi' | 'isbn' | 'arxiv' | 'pmid' | 'pmcid';

export interface TypedIdentifier {
    type: IdentifierType;
    value: string;
}

export interface ZoteroCreatorJson {
    creatorType?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
}

/** Zotero web-API item JSON. Field values are strings unless noted. */
export interface ZoteroItemJson {
    itemType: string;
    title?: string;
    creators?: ZoteroCreatorJson[];
    tags?: Array<{ tag: string; type?: 0 | 1 }>;
    /** Translator notes, written as child notes. */
    notes?: Array<{ note: string }>;
    /** Any Zotero field by name. */
    [field: string]: unknown;
}

/** A file to attach. Exactly one of `ext_key` / `path`. */
export interface ImportFileRef {
    /** KEY of an `ext-<KEY>` external file. */
    ext_key?: string;
    /** Absolute path inside a folder the user attached to the conversation. */
    path?: string;
    filename?: string;
    mime_type?: string;
    /** Size and mtime recorded at resolution; execute refuses a changed file. */
    size?: number;
    mtime_ms?: number;
    /** Default `import` (copy). */
    mode?: 'import' | 'link';
}

export type ImportSourceKind = 'external' | 'identifier' | 'url' | 'file' | 'metadata';

/** What the model asked for, kept for display and provenance. */
export interface ImportSourceDescriptor {
    kind: ImportSourceKind;
    /** The input key, e.g. "doi:10.1038/…", "W2064675550", "metadata[2]". */
    input: string;
    provider?: 'openalex' | 'openlibrary' | 'exa';
    /** Search-provider id (citation mapping, imported markers). */
    external_id?: string;
    identifier?: TypedIdentifier;
    url?: string;
}

/**
 * One item to resolve. Resolution order:
 * 1. `item` (model metadata) is validated and normalized, and wins;
 * 2. `identifier` is translated; `fallback_item` is used if that fails;
 * 3. `url` is web-translated;
 * 4. `fallback_item` (no identifier or URL): it is validated and normalized,
 *    and a `file` attaches to it;
 * 5. only `file`: the file is recognized.
 */
export interface ImportItemSpec {
    key: string;
    source: ImportSourceDescriptor;
    identifier?: TypedIdentifier;
    url?: string;
    item?: ZoteroItemJson;
    fallback_item?: ZoteroItemJson;
    file?: ImportFileRef;
}

/** `validate_agent_action(action_type='import_item')` request data. */
export interface ImportItemsValidateData {
    library_id?: number | null;
    library_ref?: string | null;
    library_name?: string | null;
    collections?: string[];
    tags?: string[];
    /** Overall resolution budget the plugin enforces on itself. */
    deadline_ms: number;
    /** Path authorization looks up the thread's attached folders. */
    thread_id?: string | null;
    items: ImportItemSpec[];
}

export type ResolutionMethod =
    | 'translator'
    | 'web_translator'
    | 'recognizer'
    | 'recognizer_deferred'
    | 'model_metadata'
    | 'fallback_metadata';

export interface AttachmentUrl {
    url: string;
    mime_type?: string;
    title?: string;
    snapshot?: boolean;
}

export interface ResolvedItem {
    key: string;
    status: 'resolved' | 'already_in_library' | 'failed';
    /** Normalized (fromJSON → toJSON round trip; transport keys removed). */
    item?: ZoteroItemJson;
    method?: ResolutionMethod;
    /** e.g. "DOI Content Negotiation", "Embedded Metadata". */
    translator?: string;
    attachment_urls?: AttachmentUrl[];
    /** Filled with filename / mime type / size. */
    file?: ImportFileRef;
    /** Web page captured as a snapshot at write time (web-content items from a URL). */
    snapshot_url?: string;
    recognizer_hints?: { abstract?: string; language?: string };
    existing_item?: { library_ref?: string; zotero_key: string; library_id: number };
    warnings?: string[];
    error?: { code: string; message: string };
}

export interface ImportItemsValidateResult {
    library_id: number;
    library_ref?: string;
    library_name?: string;
    resolved_collections: Array<{ key: string; name: string; collection_id: string }>;
    tags: string[];
    items: ResolvedItem[];
}

/** Unresolved citation-derived actions: what to resolve when the user clicks Import. */
export interface PendingResolution {
    identifier?: TypedIdentifier;
    url?: string;
    fallback_item?: ZoteroItemJson;
}

/** Proposed data of one `import_item` action (one item). */
export interface ImportItemProposedData {
    library_id?: number;
    library_ref?: string;
    library_name?: string;
    collection_keys?: string[];
    collection_ids?: string[];
    tags?: string[];

    source: ImportSourceDescriptor;
    /**
     * The item exactly as it will be written. Absent on citation-derived
     * actions (resolved at apply time) and on deferred file recognition.
     */
    item?: ZoteroItemJson;
    resolution?: { method: ResolutionMethod | string; translator?: string; resolved_at?: string };
    pending_resolution?: PendingResolution;
    /** Field → provider that filled it, e.g. `{abstractNote: 'openalex'}`. */
    enrichment?: Record<string, string>;
    file?: ImportFileRef;
    snapshot_url?: string;
    pdf_candidates?: PdfCandidate[];
    warnings?: string[];
}

/** Result data of an applied `import_item` action; same shape as `create_item`'s plus the file. */
export interface ImportItemResultData {
    library_id: number;
    library_ref?: string;
    zotero_key: string;
    collection_keys?: string[];
    collection_ids?: string[];
    attachment_status: AttachmentStatus;
    /** library_id-zotero_key of the PDF (or attached file) once available. */
    attachment_key?: string;
    attachment_resolved_at?: string;
    /** library_id-zotero_key of the attached file, when there was one. */
    file_attachment_key?: string;
}

// =============================================================================
// Display
// =============================================================================

export interface ItemJsonDisplay {
    title: string;
    itemType: string;
    /** "Smith", "Smith & Jones", "Smith et al." */
    creatorsSummary?: string;
    year?: string;
    /** Journal, book, repository, institution, website, … */
    venue?: string;
    abstract?: string;
    url?: string;
    doi?: string;
    isbn?: string;
    /** Host name for web content. */
    site?: string;
}

const VENUE_FIELDS = [
    'publicationTitle',
    'proceedingsTitle',
    'bookTitle',
    'websiteTitle',
    'blogTitle',
    'forumTitle',
    'encyclopediaTitle',
    'dictionaryTitle',
    'programTitle',
    'repository',
    'institution',
    'university',
    'publisher',
] as const;

function fieldString(json: ZoteroItemJson, name: string): string | undefined {
    const value = json[name];
    if (typeof value === 'number') return String(value);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function creatorLastName(creator: ZoteroCreatorJson): string | undefined {
    const name = creator.lastName || creator.name || creator.firstName;
    return name?.trim() || undefined;
}

function hostName(url: string | undefined): string | undefined {
    if (!url) return undefined;
    const match = /^https?:\/\/([^/?#]+)/i.exec(url);
    return match ? match[1].replace(/^www\./i, '') : undefined;
}

/** Summary fields a UI row needs, from Zotero item JSON. Pure; no Zotero access. */
export function itemJsonDisplay(json: ZoteroItemJson): ItemJsonDisplay {
    const creators = (json.creators ?? []).filter((creator) => {
        const type = creator.creatorType ?? 'author';
        return type === 'author' || type === 'editor' || type === 'contributor' || type === 'bookAuthor'
            || type === 'presenter' || type === 'programmer' || type === 'director' || type === 'inventor';
    });
    const primary = creators.length ? creators : (json.creators ?? []);
    const names = primary.map(creatorLastName).filter((name): name is string => !!name);
    let creatorsSummary: string | undefined;
    if (names.length === 1) creatorsSummary = names[0];
    else if (names.length === 2) creatorsSummary = `${names[0]} & ${names[1]}`;
    else if (names.length > 2) creatorsSummary = `${names[0]} et al.`;

    const date = fieldString(json, 'date');
    const year = date ? /\b(\d{4})\b/.exec(date)?.[1] : undefined;
    const venue = VENUE_FIELDS.map((name) => fieldString(json, name)).find(Boolean);
    const url = fieldString(json, 'url');

    return {
        title: fieldString(json, 'title') ?? fieldString(json, 'shortTitle') ?? 'Untitled',
        itemType: json.itemType,
        creatorsSummary,
        year,
        venue,
        abstract: fieldString(json, 'abstractNote'),
        url,
        doi: fieldString(json, 'DOI'),
        isbn: fieldString(json, 'ISBN'),
        site: hostName(url),
    };
}

/** The item JSON a row should show: the resolved item, else the citation fallback. */
export function importItemDisplayJson(data: ImportItemProposedData | undefined): ZoteroItemJson | undefined {
    return data?.item ?? data?.pending_resolution?.fallback_item;
}
