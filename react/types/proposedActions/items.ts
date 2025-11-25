import type { ProposedAction } from "./base";
import type { ExternalReference } from "../externalReferences";

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

