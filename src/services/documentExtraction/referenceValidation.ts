/**
 * Validate the Zotero item reference shape used by document extraction.
 */
export interface ZoteroItemReferenceInput {
    library_id: number;
    zotero_key: string;
}

/**
 * Validate that a Zotero item reference has correctly formatted fields.
 *
 * @returns null if valid, or an error message string if invalid
 */
export function validateZoteroItemReference(ref: ZoteroItemReferenceInput): string | null {
    const { library_id, zotero_key } = ref;

    if (typeof library_id !== 'number' || !Number.isFinite(library_id) || library_id < 1 || library_id !== Math.floor(library_id)) {
        return `Invalid library_id: '${library_id}'. Must be a positive integer.`;
    }

    if (typeof zotero_key !== 'string' || !Zotero.Utilities.isValidObjectKey(zotero_key)) {
        return `Invalid zotero_key: '${zotero_key}'. Must be exactly 8 characters from Zotero's allowed set (e.g., '3RRUYX5J').`;
    }

    return null;
}
