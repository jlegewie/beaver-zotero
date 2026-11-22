/**
 * Library signals the "Where should we start?" launcher reads, and the
 * suggestion card kinds run origins carry.
 */

export interface SignalItem {
    library_id: number;
    zotero_key: string;
    /** Device-portable library identity ("u" | "g<groupID>"). */
    library_ref?: string;
    item_type: string;
    title?: string | null;
    creators?: string[] | null;   // primary-creator last names only, in author order
    year?: number | null;
    abstract?: string | null;     // truncated to ~500 chars
    /**
     * True iff the item has at least one child attachment Beaver can process
     */
    has_supported_attachment: boolean;
}

export type ActiveItemKind = "annotated" | "read" | "noted";

export interface ActiveItem extends SignalItem {
    kinds: ActiveItemKind[];
    last_engaged_at: string;      // ISO datetime
}

export interface RecentItem extends SignalItem {
    date_added: string;           // ISO datetime
}

/**
 * Kinds of the first-run suggestion cards. Runs a card started carry one on
 * their `first_run_card` origin, and launcher follow-ups name a
 * representative one on their `first_run_followup` origin.
 */
export type CardKind =
    | "reading_assistant"
    | "skim_paper"
    | "literature_review"
    | "discover_research"
    | "organize_library"
    | "organize_tags";
