/** Top-level context object sent to the library analysis agent */
export interface LibraryAnalysisContext {
    generated_at: string;
    libraries: LibrarySummary[];
    recent_activity: RecentActivity;
    open_tabs: OpenTab[];
    metadata_quality: MetadataQualityReport;
}

/** Per-library overview with counts and collection tree */
export interface LibrarySummary {
    library_id: number;
    name: string;
    is_group: boolean;
    read_only: boolean;

    // Counts
    item_count: number;
    collection_count: number;
    tag_count: number;

    // Health indicators
    unfiled_item_count: number;
    has_publications: boolean;
    publications_count: number;

    // Collection tree (capped)
    collections: CollectionNode[];
    collection_tree_truncated: boolean;

    // Top tags (sorted by item count)
    top_tags: TagSummary[];
}

/** Flat representation of a collection, using key-based references */
export interface CollectionNode {
    collection_key: string;
    name: string;
    parent_collection_key: string | null;
    item_count: number;
}

export interface TagSummary {
    name: string;
    item_count: number;
    color: string | null;
}

/** Cross-library activity within configurable time windows */
export interface RecentActivity {
    recently_added_items: RecentItem[];
    recently_annotated_items: RecentAnnotationSummary[];
    recent_notes: RecentNote[];
    lookback_days: number;
}

/** Lightweight item representation with quality flags */
export interface RecentItem {
    library_id: number;
    zotero_key: string;
    item_type: string;
    title: string;
    creators_summary: string | null;
    date: string | null;
    year: number | null;
    date_added: string;

    // Quality flags
    has_abstract: boolean;
    /** Only set for item types where DOI is expected (journal articles, conference papers, preprints, etc.) */
    has_doi?: boolean;
    has_date: boolean;
    has_creators: boolean;
    has_attachment: boolean;

    // Context: which collections and tags this item belongs to
    collections: string[];       // Collection names
    tags: string[];              // Tag names
}

/** Aggregated annotation activity per parent attachment */
export interface RecentAnnotationSummary {
    attachment_library_id: number;
    attachment_zotero_key: string;

    parent_library_id: number | null;
    parent_zotero_key: string | null;
    parent_title: string | null;
    parent_creators_summary: string | null;

    highlight_count: number;
    note_count: number;
    total_annotation_count: number;

    last_annotation_date: string;
}

export interface RecentNote {
    library_id: number;
    zotero_key: string;
    title: string;
    parent_key: string | null;
    parent_title: string | null;
    date_modified: string;
    snippet: string;
}

export interface OpenTab {
    type: 'library' | 'reader';
    title: string;
    is_selected: boolean;
    /** Only for reader tabs */
    attachment_library_id?: number;
    attachment_zotero_key?: string;
    parent_library_id?: number;
    parent_zotero_key?: string;
    parent_title?: string;
    parent_item_type?: string;
    parent_creators_summary?: string;
    parent_year?: number;
}

/** Aggregated metadata quality across all non-read-only libraries */
export interface MetadataQualityReport {
    total_items: number;

    missing_abstract: number;
    missing_doi: number;
    missing_date: number;
    missing_creators: number;
    missing_title: number;
    no_attachment: number;

    worst_items: RecentItem[];
}

export interface LibraryAnalysisOptions {
    /** Days to look back for recent activity (default: 30) */
    lookbackDays?: number;
    /** Include read-only libraries in summary (default: false) */
    includeReadOnly?: boolean;
    /** Include recent notes in activity (default: false) */
    includeNotes?: boolean;
    /** Max collections per library before truncation (default: 200) */
    maxCollectionsPerLibrary?: number;
    /** Max tags per library (default: 30) */
    maxTagsPerLibrary?: number;
    /** Max recent items (default: 30) */
    maxRecentItems?: number;
    /** Max recent annotations (default: 15) */
    maxRecentAnnotations?: number;
    /** Max recent notes (default: 10) */
    maxRecentNotes?: number;
    /** Max worst quality items (default: 10) */
    maxWorstItems?: number;
}
