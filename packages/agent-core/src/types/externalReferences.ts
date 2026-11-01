import { BibliographicIdentifier, ZoteroItemReference } from "./zotero";
import type { PdfCandidate } from "./agentActions/items";
import type { ZoteroCreatorJson } from "./itemImport";


export enum NormalizedPublicationType {
    JOURNAL_ARTICLE = "journal_article",
    CONFERENCE_PAPER = "conference_paper",
    BOOK = "book",
    BOOK_CHAPTER = "book_chapter",
    REVIEW = "review",
    META_ANALYSIS = "meta_analysis",
    EDITORIAL = "editorial",
    CASE_REPORT = "case_report",
    CLINICAL_TRIAL = "clinical_trial",
    DISSERTATION = "dissertation",
    PREPRINT = "preprint",
    DATASET = "dataset",
    REPORT = "report",
    NEWS = "news",
    OTHER = "other",
}

export interface Journal {
    name?: string;
    volume?: string;
    issue?: string;
    pages?: string;
}

export interface FulltextStatus {
    available: boolean;
    status: "available" | "processing" | "unavailable";
    reason?: string;
}

export interface LibraryItem extends ZoteroItemReference {
    /**
     * Library item information
     */
    item_id: string; // Item ID (UUID) if already in user's library
    fulltext_status?: FulltextStatus; // Fulltext status of primary attachment
}

/** One labelled section of a structured abstract. */
export interface AbstractSection {
    label?: string | null;
    text?: string | null;
}

/** A MeSH heading; `major` marks a major topic. */
export interface MeshTerm {
    descriptor?: string | null;
    major?: boolean | null;
    qualifiers?: string[];
}

/** Native fields of a bibliographic work (e.g. a PubMed record). */
export interface WorkDetails {
    kind: "work";
    abstract_sections?: AbstractSection[] | null;
    mesh?: MeshTerm[] | null;
    /** PMC release date (YYYY-MM-DD): the article is free in PMC from this day on. */
    pmc_free_after?: string | null;
}

export interface TrialIntervention {
    name?: string | null;
    type?: string | null;
}

/** A document the registry lists for a trial (protocol, SAP, consent form). */
export interface TrialDocument {
    type_abbrev?: string | null;
    label?: string | null;
    date?: string | null;
    url?: string | null;
    size?: number | null;
}

/** Native fields of a trial registration. Lists are complete. */
export interface TrialDetails {
    kind: "trial";
    brief_title?: string | null;
    acronym?: string | null;
    /** Registry OverallStatus value, e.g. RECRUITING. */
    status?: string | null;
    why_stopped?: string | null;
    phases?: string[];
    study_type?: string | null;
    enrollment_count?: number | null;
    /** ACTUAL | ESTIMATED */
    enrollment_type?: string | null;
    conditions?: string[];
    interventions?: TrialIntervention[];
    lead_sponsor?: string | null;
    start_date?: string | null;
    primary_completion_date?: string | null;
    first_submitted?: string | null;
    first_posted?: string | null;
    last_update_submitted?: string | null;
    last_update_posted?: string | null;
    has_results?: boolean | null;
    documents?: TrialDocument[];
    /** Registry data timestamp, in the registry's terms. */
    data_as_of?: string | null;
}

/** Details of a kind this client does not know; kept verbatim and never rendered. */
export interface UnknownDetails {
    kind?: string | null;
    [field: string]: unknown;
}

export type ExternalReferenceDetails = WorkDetails | TrialDetails | UnknownDetails;

/** `details` as work details, or null for any other (or unknown) kind. */
export function workDetails(ref: Pick<ExternalReference, "details"> | null | undefined): WorkDetails | null {
    const details = ref?.details;
    return details && typeof details === "object" && details.kind === "work" ? details as WorkDetails : null;
}

/** `details` as trial details, or null for any other (or unknown) kind. */
export function trialDetails(ref: Pick<ExternalReference, "details"> | null | undefined): TrialDetails | null {
    const details = ref?.details;
    return details && typeof details === "object" && details.kind === "trial" ? details as TrialDetails : null;
}

export interface ExternalReference {
    /**
     * A work or record outside the user's library, as returned by an external
     * source, or combined from several sources' snapshots of the same id.
     */

    // identifiers
    id?: string; // Unique identifier for the item (UUID)
    /**
     * Who supplied the data: "openalex", "pubmed", "clinicaltrials",
     * "openlibrary", "crossref", ... An open string: unknown values are valid.
     */
    source: string;
    /** Global external id: W…, pmid:N, NCT…, openlibrary:…, isbn:…, doi:…. */
    source_id?: string;
    /** When `source` returned this data (ISO timestamp); absent on older records. */
    retrieved_at?: string | null;

    // Core bibliographic fields
    title?: string; // Title of the item
    authors?: string[]; // Display names of the author-role creators
    year?: number; // Publication year
    publication_date?: string; // Full publication date (YYYY-MM-DD or YYYY)
    journal?: Journal; // Journal metadata
    venue?: string; // Publication venue (simple string)
    publication_url?: string; // URL to the publication page
    abstract?: string; // Abstract text
    url?: string; // URL to the paper
    identifiers?: BibliographicIdentifier; // DOI, arXiv, ISBN, etc.

    // User library identifiers
    library_items: LibraryItem[]; // List of existing items in user's library
    /** When the library check behind `library_items` ran; absent = never checked. */
    library_checked_at?: string | null;

    // Publication metadata
    raw_publication_types?: string[]; // Raw publication types from source API
    /** Normalized publication types; a value this client does not know reads as "other". */
    publication_types?: NormalizedPublicationType[];
    fields_of_study?: string[]; // Fields of study (e.g., Semantic Scholar)
    is_retracted?: boolean | null;

    // Open access information
    is_open_access?: boolean; // Whether the item is open access
    open_access_url?: string; // URL of open access PDF
    /** Every place the PDF might be fetched from, best first. */
    oa_candidates?: PdfCandidate[];

    // Citation metrics
    citation_count?: number; // Number of citations
    influential_citation_count?: number; // Number of influential citations
    reference_count?: number; // Number of references

    // Zotero shape
    /** Zotero itemType; absent = derived from publication_types. */
    item_type?: string | null;
    /** Creators with Zotero roles; authoritative over `authors`. */
    creators?: ZoteroCreatorJson[] | null;
    /** Type-specific Zotero fields: reportType, reportNumber, institution, extra, ... */
    zotero_fields?: Record<string, string>;

    /** Source-specific fields only the UI renders. */
    details?: ExternalReferenceDetails | null;
}


export function extractAuthorLastName(author: string): string | undefined {
    // Extract the last name of an author.
    if (author.includes(",")) {
        const lastName = author.split(",")[0].trim();
        return lastName;
    } else {
        const lastName = author.split(" ").pop()?.trim();
        return lastName;
    }
}


/**
 * Author-role creators of a record, or null when it carries no `creators`
 * (the caller then falls back to parsing `authors`). A creator without a role
 * counts as an author.
 */
export function authorCreators(ref: Pick<ExternalReference, "creators">): ZoteroCreatorJson[] | null {
    if (!Array.isArray(ref.creators)) return null;
    return ref.creators.filter((creator) =>
        (creator?.creatorType || "author") === "author" && !!(creator.lastName || creator.name));
}

/** Last names of a record's authors; organizations by their whole name. */
export function authorLastNames(ref: Pick<ExternalReference, "creators" | "authors">): string[] {
    const creators = authorCreators(ref);
    if (creators) {
        return creators
            .map((creator) => (creator.lastName || creator.name || "").trim())
            .filter((name) => !!name);
    }
    return (ref.authors ?? [])
        .map((author) => extractAuthorLastName(author))
        .filter((name): name is string => !!name);
}
