import { parseLibraryRef, UNRESOLVED_LIBRARY_ID } from '../../utils/libraryIdentity';

/**
 * Validate the Zotero item reference shape used by document extraction.
 */
export interface ZoteroItemReferenceInput {
    /** Positive local id, or 0 when a portable library_ref must be resolved. */
    library_id: number;
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

    const hasPositiveLibraryId = typeof library_id === 'number'
        && Number.isFinite(library_id)
        && library_id >= 1
        && library_id === Math.floor(library_id);
    const hasPortableUnresolvedLibrary = library_id === UNRESOLVED_LIBRARY_ID
        && typeof library_ref === 'string'
        && parseLibraryRef(library_ref) !== null;

    if (!hasPositiveLibraryId && !hasPortableUnresolvedLibrary) {
        return `Invalid library_id: '${library_id}'. Must be a positive integer, or 0 with a valid library_ref.`;
    }

    if (typeof zotero_key !== 'string' || !Zotero.Utilities.isValidObjectKey(zotero_key)) {
        return `Invalid zotero_key: '${zotero_key}'. Must be exactly 8 characters from Zotero's allowed set (e.g., '3RRUYX5J').`;
    }

    return null;
}
