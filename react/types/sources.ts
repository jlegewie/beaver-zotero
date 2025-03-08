
// Base source interface
export interface BaseSource {
    id: string;               // Unique identifier for tracking
    identifier: string;       // Identifier for the source
    messageId?: string;       // Message ID for tracking
    type: string;             // Type discriminator
    name: string;             // Name for the source
    icon: string;             // Icon for the source
    pinned: boolean;          // If true, the source persists across selections
    timestamp: number;        // Creation timestamp
    citation: string;         // In-text citation for the source used in assistant messages
    reference: string;        // Bibliographic reference for the source
    url: string;              // URL for the source
    numericCitation?: string; // Numeric citation for the source used in assistant messages
}

// Zotero item source
export interface ZoteroSource extends BaseSource {
    type: 'zotero_item';
    libraryID: number;        // Zotero library ID
    itemKey: string;          // Zotero item key
    parentKey: string | null; // Key of the parent item
    itemType: string;         // Type of the item
    isRegularItem: boolean;   // Whether the item is a regular item or an attachment, note etc
    isNote: boolean;          // Whether the item is a note
    childItemKeys: string[];  // Keys of child items that are part of this source
}

// File source from local file system
export interface FileSource extends BaseSource {
    type: 'file';
    filePath: string;
    fileName: string;
    fileType: string;
}

// Remote file source from URL
export interface RemoteFileSource extends BaseSource {
    type: 'remote_file';
    url: string;
    name: string;
}

// Union type for all source types
export type Source = ZoteroSource | FileSource | RemoteFileSource;
