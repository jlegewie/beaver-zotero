import type { ProposedAction } from "./base";
import type { ExternalReference } from "../externalReferences";

export interface CreateItemProposedData {
    // Target library (undefined = user's main library)
    library_id?: number;
    library_name?: string;  // Resolve library by name if library_id not provided

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

export interface CreateItemResultData {
    // From ZoteroItemReference
    library_id: number;
    zotero_key: string;  // The Zotero key assigned to the new item
    
    // Additional fields specific to create_item
    attachment_keys?: string;  // Keys of any attachments (PDFs) added
    file_hash?: string;  // Hash of the attached file
    storage_path?: string;  // Final storage path
}

export type CreateItemProposedAction = ProposedAction & {
    action_type: 'create_item';
    proposed_data: CreateItemProposedData;
    result_data?: CreateItemResultData;
};
