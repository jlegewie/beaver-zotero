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

export type ThreadSource = Omit<InputSource, "type"> & {
  type: "attachment" | "note" | "annotation" | "reader";
};

export interface SourceCitation extends InputSource {
    icon: string | null;
    name: string;             // Display name for the source
    citation: string;         // In-text citation for the source used in assistant messages
    formatted_citation: string;        // Bibliographic reference for the source
    url: string;              // URL for the source
    numericCitation: string;  // Numeric citation for the source used in assistant messages
};