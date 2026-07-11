import { resolveLibraryRef } from '../../../src/utils/libraryIdentity';

/** Resolve a portable-or-legacy history reference to a locally available library. */
export function resolveLocalLibraryId(
    ref: { library_id?: number | null; library_ref?: string | null },
): number | null {
    const libraryId = resolveLibraryRef(ref);
    return libraryId || null;
}
