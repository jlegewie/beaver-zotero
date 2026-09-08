import { hasLibraryIdentity } from '../../utils/libraryIdentity';

/**
 * Validate the Zotero item reference shape used by document extraction.
 */
export interface ZoteroItemReferenceInput {
    /**
     * Device-local library rowid. Optional: a portable `library_ref` is a
     * complete identity on its own, and such a request carries either no
     * `library_id` at all or the `UNRESOLVED_LIBRARY_ID` sentinel.
     */
    library_id?: number | null;
    library_ref?: string | null;
    zotero_key: string;
}

/**
 * Validate that a Zotero item reference has correctly formatted fields.
 *
 * @returns null if valid, or an error message string if invalid
 */
export function validateZoteroItemReference(ref: ZoteroItemReferenceInput): string | null {
    const { library_id, library_ref, zotero_key } = ref;

    if (!hasLibraryIdentity({ library_id, library_ref })) {
        return `Invalid library reference: library_ref '${library_ref}' / library_id '${library_id}'. `
            + `Provide a valid library_ref ("u" or "g<groupID>"), or a positive library_id.`;
    }

    if (typeof zotero_key !== 'string' || !Zotero.Utilities.isValidObjectKey(zotero_key)) {
        return `Invalid zotero_key: '${zotero_key}'. Must be exactly 8 characters from Zotero's allowed set (e.g., '3RRUYX5J').`;
    }

    return null;
}
