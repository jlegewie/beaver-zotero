import { BibliographicIdentifier, ZoteroItemReference } from "./zotero";


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

export interface ExternalReference {
    /**
     * External reference from a semantic scholar or open alex search.
     */

    // identifiers
    id?: string; // Unique identifier for the item (UUID)
    source: "semantic_scholar" | "openalex"; // Source of the item data
    source_id?: string; // Source ID

    // Core bibliographic fields
    title?: string; // Title of the item
    authors?: string[]; // List of author names
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