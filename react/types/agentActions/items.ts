import type { ProposedAction } from "./base";
import type { ExternalReference } from "../externalReferences";

export interface CreateItemProposedData {
    // Target library (undefined = user's main library)
    library_id?: number;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
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

/**
 * Initial status of the PDF attachment for a newly-created item.
 *
 * The frontend is the sole source of truth — stamped from what
 * applyCreateItemData / createZoteroItem actually did:
 *  - "available" if a PDF was attached synchronously at creation time
 *  - "pending"   if a background PDF fetch was scheduled
 *  - "none"      if no PDF was attached and no fetch was scheduled
 *
 * Later transitions to "available" or "failed" via the attachment_resolved
 * ws event when the background fetcher finishes, or via the backend
 * safety-net lookup at the next user message (terminal "failed" applies
 * after 60-minute TTL).
 */
export type AttachmentStatus = 'none' | 'pending' | 'available' | 'failed';

export interface CreateItemResultData {
    // From ZoteroItemReference
    library_id: number;
    zotero_key: string;  // The Zotero key assigned to the new item
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;

    // Attachment lifecycle (see AttachmentStatus above)
    attachment_status: AttachmentStatus;
    attachment_key?: string;          // library_id-zotero_key of the PDF once available
    attachment_resolved_at?: string;  // ISO 8601 timestamp, populated when status becomes terminal
}

export type CreateItemProposedAction = ProposedAction & {
    action_type: 'create_item';
    proposed_data: CreateItemProposedData;
    result_data?: CreateItemResultData;
};
