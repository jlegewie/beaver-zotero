import { isLibrarySearchable } from '../../../src/services/agentDataProvider/utils';
import { resolveLibraryRef } from '../../../src/utils/libraryIdentity';

/** Resolve a portable-or-legacy reference to an allowed local library. */
export function resolveSearchableLibraryId(
    ref: { library_id?: number | null; library_ref?: string | null },
    searchableLibraryIds?: readonly number[],
): number | null {
    const libraryId = resolveLibraryRef(ref);
    if (!libraryId) return null;
    const isSearchable = searchableLibraryIds
        ? searchableLibraryIds.includes(libraryId)
        : isLibrarySearchable(libraryId);
    return isSearchable ? libraryId : null;
}
