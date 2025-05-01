/**
 * UIAttachment represents a message attachment on the UI
 */

export interface UIAttachment {
    id: string;
    type: string;
    libraryId: number;
    zoteroKey: string;
    parentKey?: string;
    messageId?: string;  // Only set for thread attachments
    pinned: boolean;
    timestamp: number;
    childKeys?: string[];
}