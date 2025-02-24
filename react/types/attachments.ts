// Attachment interface and types
interface BaseAttachment {
    id: string;               // Unique identifier for tracking
    type: 'zotero_item' | 'file' | 'remote_file';
    shortName: string;        // Short name shown in the UI
    fullName: string;         // Detailed name shown in tooltip
    pinned: boolean;          // If true, the attachment persists across selections
    timestamp: number;        // Timestamp of the attachment
}

export interface ZoteroAttachment extends BaseAttachment {
    type: 'zotero_item';
    item: Zotero.Item;        // The parent item
    childItemIds?: string[];  // Zotero child item IDs that are part of this attachment
}

export interface FileAttachment extends BaseAttachment {
    type: 'file';
    filePath: string;
}

export interface RemoteFileAttachment extends BaseAttachment {
    type: 'remote_file';
    url: string;
}

export type Attachment = ZoteroAttachment | FileAttachment | RemoteFileAttachment;
