/**
 * Dev-only HTTP handlers for the library-exclusion feature.
 *
 * The exclusion boundary is driven by `searchableLibraryIdsAtom`, derived from
 * the profile's `excluded_libraries`. Live tests need to (a) toggle which
 * libraries are excluded at runtime and (b) reach the handlers that enforce
 * exclusion but have no production HTTP route. These handlers provide both:
 *
 * - `/beaver/test/excluded-libraries` — read and set the in-memory excluded
 *   set (no backend write; purely mutates `profileWithPlanAtom`).
 * - `/beaver/test/get-annotations` — invoke `handleGetAnnotationsRequest`.
 * - `/beaver/test/view-images` — invoke `handleZoteroViewImagesRequest` for a
 *   Zotero attachment reference (the production test endpoint only covers the
 *   external-file branch).
 * - `/beaver/test/attachment-image` — invoke `handleZoteroAttachmentImageRequest`.
 *
 * Handler exports are wired to paths in `useHttpEndpoints.ts` →
 * `registerEndpoints()`.
 */

import { store } from '../../store';
import {
    excludedLibrariesAtom,
    localZoteroLibrariesAtom,
    profileWithPlanAtom,
    searchableLibraryIdsAtom,
} from '../../atoms/profile';
import type { ExcludedLibrary } from '../../types/profile';
import type { ZoteroLibrary } from '../../types/zotero';

/** Snapshot of the derived exclusion state for assertions/restore. */
function currentExclusionState() {
    return {
        excluded_libraries: store.get(excludedLibrariesAtom),
        searchable_library_ids: store.get(searchableLibraryIdsAtom),
        local_library_ids: store.get(localZoteroLibrariesAtom).map((lib: ZoteroLibrary) => lib.library_id),
    };
}

/** Map a numeric library id to its exclusion entry (`user` or `group:<id>`). */
function libraryIdToExcludedEntry(libraryId: number): ExcludedLibrary | null {
    const library = Zotero.Libraries?.get?.(libraryId);
    if (!library) return null;
    if (library.isGroup) return { type: 'group', group_id: (library as any).groupID };
    return { type: 'user' };
}

/**
 * Dev-only: read or set the in-memory excluded-libraries set.
 *
 * `{ action: 'get' }` returns the current excluded entries plus the resulting
 * searchable/local library ids. `{ action: 'set', exclude_library_ids: [...] }`
 * (or `{ excluded_libraries: [...] }` for verbatim restore) overwrites the
 * profile's `excluded_libraries` in the store only — it never calls the account
 * service, so nothing is persisted to the backend. Tests capture the original
 * via `get` and restore it in teardown.
 */
export async function handleTestExcludedLibrariesHttpRequest(request: any) {
    const action = request?.action ?? 'get';
    const profile = store.get(profileWithPlanAtom);

    if (action === 'get') {
        return { ok: true, has_profile: !!profile, ...currentExclusionState() };
    }

    if (action === 'set') {
        if (!profile) {
            return {
                ok: false,
                has_profile: false,
                error: 'No profile loaded; cannot set excluded libraries',
            };
        }

        let entries: ExcludedLibrary[];
        if (Array.isArray(request.excluded_libraries)) {
            entries = request.excluded_libraries as ExcludedLibrary[];
        } else if (Array.isArray(request.exclude_library_ids)) {
            entries = (request.exclude_library_ids as number[])
                .map(libraryIdToExcludedEntry)
                .filter((entry): entry is ExcludedLibrary => entry !== null);
        } else {
            return { ok: false, error: 'Provide exclude_library_ids or excluded_libraries' };
        }

        store.set(profileWithPlanAtom, { ...profile, excluded_libraries: entries });
        return { ok: true, has_profile: true, ...currentExclusionState() };
    }

    return { ok: false, error: `Unknown action: ${action}` };
}

/**
 * Dev-only: invoke `handleGetAnnotationsRequest` (no production HTTP route) so
 * the exclusion gate on annotation listing is live-testable.
 */
export async function handleTestGetAnnotationsHttpRequest(request: any) {
    const { attachment_id, limit, offset } = request || {};
    if (!attachment_id) return { error: 'Provide attachment_id' };

    const { handleGetAnnotationsRequest } = await import(
        '../../../src/services/agentDataProvider/handleGetAnnotationsRequest'
    );
    return handleGetAnnotationsRequest({
        event: 'get_annotations_request',
        request_id: `test-annos-${attachment_id}`,
        attachment_id,
        limit: limit ?? 50,
        offset: offset ?? 0,
    });
}

/**
 * Dev-only: invoke `handleZoteroViewImagesRequest` for a Zotero attachment
 * reference so the unified view-images exclusion gate is live-testable.
 */
export async function handleTestViewImagesHttpRequest(request: any) {
    const {
        attachment,
        start_page,
        end_page,
        dpi,
        max_width,
        max_height,
        format,
        jpeg_quality,
        timeout_seconds,
    } = request || {};
    if (!attachment) return { error: 'Provide attachment' };

    const { handleZoteroViewImagesRequest } = await import(
        '../../../src/services/agentDataProvider/handleZoteroViewImagesRequest'
    );
    return handleZoteroViewImagesRequest({
        event: 'zotero_view_images_request',
        request_id: `test-view-${attachment.library_id}-${attachment.zotero_key}`,
        attachment,
        start_page: start_page ?? undefined,
        end_page: end_page ?? undefined,
        dpi: dpi ?? undefined,
        max_width: max_width ?? undefined,
        max_height: max_height ?? undefined,
        format: format ?? undefined,
        jpeg_quality: jpeg_quality ?? undefined,
        timeout_seconds: timeout_seconds ?? undefined,
    });
}

/**
 * Dev-only: invoke `handleZoteroAttachmentImageRequest` for a Zotero attachment
 * reference so its own exclusion gate (defense-in-depth behind view-images) is
 * independently live-testable.
 */
export async function handleTestAttachmentImageHttpRequest(request: any) {
    const { attachment, max_width, max_height, format, jpeg_quality, timeout_seconds } = request || {};
    if (!attachment) return { error: 'Provide attachment' };

    const { handleZoteroAttachmentImageRequest } = await import(
        '../../../src/services/agentDataProvider/handleZoteroAttachmentImageRequest'
    );
    return handleZoteroAttachmentImageRequest({
        event: 'zotero_attachment_image_request',
        request_id: `test-img-${attachment.library_id}-${attachment.zotero_key}`,
        attachment,
        max_width: max_width ?? undefined,
        max_height: max_height ?? undefined,
        format: format ?? undefined,
        jpeg_quality: jpeg_quality ?? undefined,
        timeout_seconds: timeout_seconds ?? undefined,
    });
}
