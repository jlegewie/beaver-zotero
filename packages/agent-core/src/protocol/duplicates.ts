/** Portable, self-contained duplicate review and merge contracts. */
export interface DuplicateMember {
    item_id: string;
    library_ref: string;
    zotero_key: string;
    title: string;
    item_type: string;
    creators: string;
    date: string;
    doi: string;
    isbn: string;
    date_added: string;
    attachment_count: number;
    note_count: number;
    fields: Record<string, unknown>;
    children?: {
        item_id: string;
        title: string;
        item_type: string;
        annotation_count: number;
    }[];
}
export interface DuplicateGroup {
    group_id: string;
    members: DuplicateMember[];
    differing_fields: string[];
    warnings: string[];
    mergeable: boolean;
    recommended_master_item_id: string;
}
export interface DuplicatesResultView {
    view_type: "duplicates";
    mode: "find" | "inspect";
    groups: DuplicateGroup[];
    total_count: number;
    has_more: boolean;
    next_offset: number | null;
    snapshot_id: string;
}
export interface DuplicatesRequest {
    event: "duplicates_request";
    request_id: string;
    mode: "find";
    library?: string | null;
    collection?: string | null;
    limit?: number;
    offset?: number;
    snapshot_id?: string | null;
}
export interface DuplicatesResponse extends DuplicatesResultView {
    type: "duplicates";
    request_id: string;
    error?: string;
    error_code?: string;
}
export interface MergeItemsChoices {
    master_item_id: string;
    field_sources?: Record<string, string>;
    creators_source_item_id?: string | null;
}
export interface MergeItemsProposedData extends MergeItemsChoices {
    other_item_ids: string[];
    preview?: DuplicateGroup;
    snapshot?: Record<string, Record<string, unknown>>;
}
export interface MergeItemSnapshot {
    /** Proven by creation within the native merge transaction, never by a missing snapshot. */
    created_by_merge?: boolean;
    item_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
}
export interface MergeItemsResultData {
    applied_choices?: MergeItemsChoices;
    master_item_id: string;
    merged_item_ids: string[];
    preview: DuplicateGroup;
    changes: MergeItemSnapshot[];
}
