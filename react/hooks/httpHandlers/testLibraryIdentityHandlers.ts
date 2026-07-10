/**
 * Dev-only HTTP handler exposing the device-portable library-identity helpers
 * (`src/utils/libraryIdentity.ts`) so live tests can assert their behavior
 * against real personal + group libraries without driving the UI.
 *
 * Every branch is a thin wrapper that calls the real production function — the
 * endpoint adds no logic of its own, it only makes the pure resolvers reachable
 * over HTTP. Dispatched by an `op` discriminator:
 *
 *   { op: 'ref_for_id',   library_id }                       -> { library_ref }
 *   { op: 'parse',        library_ref }                      -> { parsed, matches_pattern }
 *   { op: 'resolve_ref',  library_ref?, library_id }         -> { resolved_library_id }
 *   { op: 'resolve_item', library_ref?, library_id, zotero_key } -> { status, ... }
 */

import {
    libraryRefForLibraryID,
    parseLibraryRef,
    resolveLibraryRef,
    resolveItemReference,
    LIBRARY_REF_PATTERN,
} from '../../../src/utils/libraryIdentity';

export async function handleTestLibraryIdentityHttpRequest(request: any) {
    const op = request?.op;
    switch (op) {
        case 'ref_for_id': {
            const libraryId = request?.library_id;
            if (typeof libraryId !== 'number') {
                return { error: 'library_id (number) is required for op "ref_for_id"' };
            }
            return { library_ref: libraryRefForLibraryID(libraryId) };
        }
        case 'parse': {
            const ref = String(request?.library_ref ?? '');
            return {
                parsed: parseLibraryRef(ref),
                matches_pattern: LIBRARY_REF_PATTERN.test(ref),
            };
        }
        case 'resolve_ref': {
            return {
                resolved_library_id: resolveLibraryRef({
                    library_ref: request?.library_ref,
                    library_id: request?.library_id,
                }),
            };
        }
        case 'resolve_item': {
            const result = await resolveItemReference({
                library_ref: request?.library_ref,
                library_id: request?.library_id,
                zotero_key: request?.zotero_key,
            });
            if (result.status === 'found') {
                // Never leak the whole Zotero.Item; surface just enough to assert on.
                return {
                    status: 'found',
                    resolved_library_id: result.item.libraryID,
                    item_id: `${result.item.libraryID}-${result.item.key}`,
                    item_type: result.item.itemType,
                };
            }
            return { status: result.status };
        }
        default:
            return { error: `Unknown op: ${JSON.stringify(op)}` };
    }
}
