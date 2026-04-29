/**
 * Plugin-side types for the library-suggestions endpoint.
 * Mirrors the backend Pydantic models in app/models/library_suggestions.py.
 */
import { ZoteroItemReference } from './zotero';
import { MessageAttachment } from './attachments/apiTypes';


// --- Request models ---

export interface SignalItem {
    library_id: number;
    zotero_key: string;
    item_type: string;
    title?: string | null;
    creators?: string[] | null;   // primary-creator last names only, in author order
    year?: number | null;
    abstract?: string | null;     // truncated to ~500 chars
}

export type ActiveItemKind = "annotated" | "read" | "noted";

export interface ActiveItem extends SignalItem {
    kinds: ActiveItemKind[];
    last_engaged_at: string;      // ISO datetime
}

export interface RecentItem extends SignalItem {
    date_added: string;           // ISO datetime
}

export interface CollectionSignal {
    library_id: number;
    zotero_key: string;
    name: string;
    parent_key?: string | null;
    item_count: number;
    date_added?: string | null;
    is_current_view?: boolean;
    item_refs?: ZoteroItemReference[] | null;
    sample_items?: SignalItem[] | null;
}

export type UiViewType =
    | "library" | "collection" | "search"
    | "unfiled" | "duplicates" | "trash"
    | "publications" | "retracted" | "feed";

export interface LibrarySuggestionsRequest {
    active_items: ActiveItem[];
    top_collections: CollectionSignal[];
    recent_items: RecentItem[];
    collections: CollectionSignal[];
    total_tag_count: number;
    unfiled_item_count: number;
    library_size: number;
    reader_item?: SignalItem | null;
    selected_item?: SignalItem | null;
    ui_view_type?: UiViewType | null;
    ui_filter_tags: string[];
    purpose?: string | null;
}


// --- Response models ---

export type TopicSource = "collection" | "active_items" | "recent_items" | "ui_state";
export type TopicConfidence = "high" | "medium" | "low";

export interface SuggestionTopic {
    label: string;
    source: TopicSource;
    confidence: TopicConfidence;
    item_count: number;
    item_refs: ZoteroItemReference[];
    collection_ref?: ZoteroItemReference | null;
    collection_name?: string | null;
}

export interface LibraryFacts {
    unfiled_item_count: number;
    total_tag_count: number;
    user_collection_count: number;
    library_size: number;
}

export type CardKind =
    | "reading_assistant"
    | "literature_review"
    | "discover_research"
    | "organize_library"
    | "organize_tags";

export interface SuggestionCard {
    kind: CardKind;
    slot_index: number;
    is_emphasized: boolean;
    title: string;
    description: string;
    prompt: string;
    attachments?: MessageAttachment[] | null;
}

export interface LibrarySuggestionsResponse {
    cards: SuggestionCard[];
    topics: SuggestionTopic[];
    facts: LibraryFacts;
    generated_at: string;     // ISO datetime
}
