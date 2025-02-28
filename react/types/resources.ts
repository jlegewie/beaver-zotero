
// Base resource interface
export interface BaseResource {
    id: string;               // Unique identifier for tracking
    type: string;             // Type discriminator
    name: string;             // Name for the resource
    icon: string;             // Icon for the resource
    pinned: boolean;          // If true, the resource persists across selections
    timestamp: number;        // Creation timestamp
}

// Zotero item resource
export interface ZoteroResource extends BaseResource {
    type: 'zotero_item';
    libraryID: number;        // Zotero library ID
    itemKey: string;          // Zotero item key
    childItemKeys: string[];  // Keys of child items that are part of this resource
}

// File resource from local file system
export interface FileResource extends BaseResource {
    type: 'file';
    filePath: string;
    fileName: string;
    fileType: string;
}

// Remote file resource from URL
export interface RemoteFileResource extends BaseResource {
    type: 'remote_file';
    url: string;
    name: string;
}

// Union type for all resource types
export type Resource = ZoteroResource | FileResource | RemoteFileResource;


// Source type
export type Source = Resource & {
    reference: string;       // Reference for the resource
    citation: string;        // Citation for the resource
    numericCitation: string; // Numeric citation for the resource
}