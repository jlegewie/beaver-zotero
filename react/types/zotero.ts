/**
 * ZoteroLibrary is a reference to a Zotero library.
 */
export interface ZoteroLibrary {
    library_id: number;
    group_id: number | null;
    name: string;
    is_group: boolean;
    type: string;
    type_id: number;
    read_only: boolean | null;
}

/**
 * ZoteroItemReference is a reference to a Zotero item.
 */
export interface ZoteroItemReference {
    zotero_key: string;
    library_id: number;
}

export interface FileHashReference {
    file_hash: string;
    library_id: number;
    zotero_key: string;
}

export interface FailedItemReference extends ZoteroItemReference {
    errorCode?: string;
    buttonText?: string;
    buttonAction?: () => void;
    buttonIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}

export interface SkippedItem extends ZoteroItemReference {
    reason: string;
}

export interface FailedFileReference extends FileHashReference {
    errorCode?: string;
    buttonText?: string;
    buttonAction?: () => void;
    buttonIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}

export function createZoteroItemReference(id: string): ZoteroItemReference | null {
    const [libraryId, zoteroKey] = id.split('-');
    if (!libraryId || !zoteroKey) {
        return null;
    }
    return {
        zotero_key: zoteroKey,
        library_id: parseInt(libraryId)
    };
}

/**
 * ZoteroItemBase is a base interface for a Zotero item.
 */
export interface ZoteroItemBase extends ZoteroItemReference {
    date_added: string;
    date_modified: string;
}

export interface ZoteroCreator {
    first_name: string | null;
    last_name: string | null;
    field_mode: number;
    creator_type_id: number;
    creator_type: string;
    is_primary: boolean;
}

export interface ZoteroCollection extends ZoteroItemReference {
    name: string;
    zotero_version: number;
    date_modified: string;
    parent_collection: string | null;
    relations: Record<string, any> | null;
}

export interface ZoteroTag {
    id: number;
    tag: string;
    libraryId: number;
    type: number;
    color: string; // Hex color string (e.g., '#990000') if the tag has a color assigned
}

export interface BibliographicIdentifier {
    doi?: string;
    isbn?: string;
    issn?: string;
    pmid?: string;
    pmcid?: string;
    arXivID?: string;
    archiveID?: string;
}

export interface DeleteData extends ZoteroItemReference {
    zotero_version: number | null;
    zotero_synced: boolean | null;
    date_modified: string | null;
}

export interface ItemData extends ZoteroItemBase {
    // Core fields that most items have
    item_type: string;
    title?: string | null;
    creators?: ZoteroCreator[] | null;
    date?: string | null;
    year?: number | null;
    publication_title?: string | null;
    abstract?: string | null;
    url?: string | null;
    identifiers?: BibliographicIdentifier | null;
    
    // full item data
    item_json?: Record<string, any> | null;
    
    // Metadata
    language?: string | null;
    formatted_citation?: string | null;
    deleted: boolean;
    tags?: any[] | null;
    collections?: string[] | null;
    citation_key?: string | null;

    // Item metadata hash and zotero version
    item_metadata_hash: string;
    zotero_version: number;
    zotero_synced: boolean;
}

export type ItemDataHashedFields = Pick<ItemData,
    //  Item reference fields
    | 'zotero_key' | 'library_id'
    // Core bibliographic fields
    | 'item_type' | 'title' | 'creators' | 'date' | 'year' | 'publication_title' | 'abstract' | 'url' | 'identifiers'
    // Metadata
    | 'language' | 'formatted_citation' | 'deleted' | 'tags' | 'collections' | 'citation_key'
>;

export interface ItemModel extends ItemData {
    id: string;  // UUID as string in TypeScript
    user_id: string;
}


/**
 * AttachmentData is a base interface for a Zotero attachment.
 */
export interface AttachmentData extends ZoteroItemBase {
    // zotero fields
    parent_key?: string | null;
    deleted: boolean;
    title?: string | null;
    attachment_url?: string | null;
    link_mode?: number | null;
    tags?: any[] | null;
    collections?: string[] | null;

    // file metadata
    filename: string;
    file_hash: string;

    // additional fields
    attachment_metadata_hash: string;
    zotero_version: number;
    zotero_synced: boolean;
}

export interface AttachmentDataWithMimeType extends AttachmentData {
    mime_type: string;
}

export type AttachmentDataHashedFields = Pick<AttachmentData,
    | 'zotero_key' | 'library_id' | 'parent_key' | 'attachment_url'
    | 'link_mode' | 'deleted' | 'title' | 'filename' | 'tags' | 'collections'
>;

export interface AttachmentModel extends AttachmentData {
    id: string;  // UUID as string in TypeScript
    user_id: string;

    // additional fields
    current_file_hash?: string | null;
    is_primary?: boolean | null;
    user_override_primary: boolean;
}