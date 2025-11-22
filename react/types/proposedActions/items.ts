import type { ProposedAction } from "./base";
import type { BibliographicIdentifier } from "../zotero";

export type NormalizedPublicationType =
    | "journal_article"
    | "conference_paper"
    | "book"
    | "book_chapter"
    | "review"
    | "meta_analysis"
    | "editorial"
    | "case_report"
    | "clinical_trial"
    | "dissertation"
    | "preprint"
    | "dataset"
    | "report"
    | "news"
    | "other";

export interface ExternalReference {
    // Source identifiers
    semantic_scholar_id?: string;
    openalex_id?: string;
    source: "semantic_scholar" | "openalex";

    // Core bibliographic fields
    title?: string;
    authors?: string[];  // List of author names
    year?: number;
    publication_date?: string;  // YYYY-MM-DD or YYYY
    publication_title?: string;  // Journal/publication name
    venue?: string;  // Publication venue
    abstract?: string;
    url?: string;  // URL to the paper

    // Identifiers (DOI, arXiv, etc.)
    identifiers?: BibliographicIdentifier;

    // User library identifiers (if item already exists in user's library)
    item_exists: boolean;
    item_id?: string;
    library_id?: number;
    zotero_key?: string;

    // Publication metadata
    raw_publication_types?: string[];  // Raw types from source API
    publication_types?: NormalizedPublicationType[];  // Normalized types
    fields_of_study?: string[];

    // Open access information
    is_open_access?: boolean;
    open_access_url?: string;  // URL of open access PDF

    // Citation metrics
    citation_count?: number;
    influential_citation_count?: number;
    reference_count?: number;
}

export interface AddItemProposedData {
    // Core item data
    item: ExternalReference;
    reason?: string;  // LLM-generated explanation of relevance
    relevance_score?: number;  // 0.0 to 1.0

    // Fulltext information
    file_available: boolean;  // Whether fulltext PDF is available
    downloaded_url?: string;  // URL from which fulltext was downloaded
    storage_path?: string;  // Storage path if file was downloaded
    text_path?: string;  // Path to extracted text file

    // Zotero organization
    collection_keys?: string[];  // Collection keys to add item to
    suggested_tags?: string[];  // Tags suggested for the item
}

export interface AddItemResultData {
    // From ZoteroItemReference
    library_id: number;
    zotero_key: string;  // The Zotero key assigned to the new item
    
    // Additional fields specific to add_item
    attachment_keys?: string;  // Keys of any attachments (PDFs) added
    file_hash?: string;  // Hash of the attached file
    storage_path?: string;  // Final storage path
}

export type AddItemProposedAction = ProposedAction & {
    action_type: 'add_item';
    proposed_data: AddItemProposedData;
    result_data?: AddItemResultData;
};

export function isAddItemAction(action: ProposedAction): action is AddItemProposedAction {
    return action.action_type === 'add_item';
}

export function isSearchExternalReferencesTool(functionName: string | undefined): boolean {
    if (!functionName) return false;
    return functionName === 'search_external_references';
}

export function isCreateZoteroItemTool(functionName: string | undefined): boolean {
    if (!functionName) return false;
    return functionName === 'create_zotero_item';
}

