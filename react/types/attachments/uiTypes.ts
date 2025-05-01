/**
 * UIAttachment represents a message attachment on the UI
 */

export interface UIAttachment {
    id: string;
    type: "regularItem" | "attachment" | "note" | "annotation" | "reader";
    messageId?: string;
    libraryID: number;
    itemKey: string;
    pinned: boolean;
    parentKey: string | null;
    childItemKeys: string[];
    timestamp: number;
}