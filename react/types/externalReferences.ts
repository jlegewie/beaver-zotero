import { BibliographicIdentifier } from "./zotero";


enum NormalizedPublicationType {
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


export interface ExternalReference {
    /**
     * External reference from a semantic scholar or open alex search.
     */

    // Source identifiers
    semantic_scholar_id?: string; // Semantic Scholar paper ID
    openalex_id?: string; // OpenAlex work ID
    source: "semantic_scholar" | "openalex"; // Source of the item data

    // Core bibliographic fields
    title?: string; // Title of the item
    authors?: string[]; // List of author names
    year?: number; // Publication year
    publication_date?: string; // Full publication date (YYYY-MM-DD or YYYY)
    publication_title?: string; // Journal/publication name
    publication_url?: string; // URL to the publication page
    venue?: string; // Publication venue (simple string)
    abstract?: string; // Abstract text
    url?: string; // URL to the paper
    identifiers?: BibliographicIdentifier; // DOI, arXiv, ISBN, etc.

    // User library identifiers
    item_exists: boolean; // Whether the item already exists in user's library
    item_id?: string; // Item ID if already in user's library
    library_id?: number; // Library ID if already in user's library
    zotero_key?: string; // Zotero key if already in user's library

    // Publication metadata
    raw_publication_types?: string[]; // Raw publication types from source API
    publication_types?: NormalizedPublicationType[]; // Normalized publication types for consistent handling
    fields_of_study?: string[]; // Fields of study (e.g., Semantic Scholar)

    // Open access information
    is_open_access?: boolean; // Whether the item is open access
    open_access_url?: string; // URL of open access PDF

    // Citation metrics
    citation_count?: number; // Number of citations
    influential_citation_count?: number; // Number of influential citations
    reference_count?: number; // Number of references
}
