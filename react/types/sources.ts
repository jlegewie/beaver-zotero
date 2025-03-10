
export interface InputSource {
    id: string;               // Unique identifier
    messageId?: string;       // Message ID for tracking
    libraryID: number;        // Zotero library ID
    itemKey: string;          // Zotero item key
    pinned: boolean;          // If true, the source persists across selections
    timestamp: number;        // Creation timestamp
    isRegularItem: boolean;   // Whether the item is a regular item or an attachment, note etc
    isNote: boolean;          // Whether the item is a note
    parentKey: string | null; // Key of the parent item
    childItemKeys: string[];  // Keys of child items
}

export interface SourceCitation extends InputSource {
    icon: string | null;
    name: string;             // Display name for the source
    citation: string;         // In-text citation for the source used in assistant messages
    reference: string;        // Bibliographic reference for the source
    url: string;              // URL for the source
    numericCitation: string;  // Numeric citation for the source used in assistant messages
};


export interface BaseSource {
    id: string;               // Unique identifier for tracking
    messageId?: string;       // Message ID for tracking
    libraryID: number;        // Zotero library ID
    itemKey: string;          // Zotero item key
    pinned: boolean;          // If true, the source persists across selections
    timestamp: number;        // Creation timestamp
}

export interface RegularItemSource extends BaseSource {
    type: "regularItem";
    childItemKeys: string[];  // Keys of child items
}

export interface AttachmentSource extends BaseSource {
    type: "attachment";
    parentKey: string | null; // Key of the parent item
}

export interface NoteSource extends BaseSource {
    type: "note";
    parentKey: string | null; // Key of the parent item
}
 
// export type InputSource = RegularItemSource | AttachmentSource | NoteSource;
// export type ThreadSource = AttachmentSource | NoteSource;
