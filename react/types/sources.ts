import { TextSelection } from "./attachments/apiTypes";

export interface InputSource {
    id: string;               // Unique identifier
    type: "regularItem" | "attachment" | "note" | "annotation" | "reader"; // Type of source
    messageId?: string;       // Message ID for tracking
    libraryID: number;        // Zotero library ID
    itemKey: string;          // Zotero item key
    pinned: boolean;          // If true, the source persists across selections
    parentKey: string | null; // Key of the parent item
    childItemKeys: string[];  // Keys of child items
    timestamp: number;        // Creation timestamp
    textSelection?: TextSelection;
}

export type ReaderSource = InputSource & { type: "reader" };

// export type ThreadSource = Omit<InputSource, "type"> & {
//   type: "attachment" | "note" | "annotation" | "reader";
// };
