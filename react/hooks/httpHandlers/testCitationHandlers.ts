/**
 * Dev-only HTTP handlers for the client-agnostic citation host. Wired to their
 * paths in `useHttpEndpoints.ts`.
 *
 * `/beaver/test/resolve-item-display` invokes the Zotero `itemData` host's
 * `resolveItemDisplay` directly — the same call `CitedSourcesList` makes to back
 * a cited-source row's icon (item type) and "open" button (readable-attachment
 * availability). It exercises the real host code path, not a reimplementation.
 */

import { zoteroItemData } from '../../host/zotero/itemData';
import type { ZoteroItemReference } from '../../types/zotero';

export async function handleTestResolveItemDisplayHttpRequest(request: any): Promise<any> {
    const { library_id, zotero_key } = request || {};
    if (library_id == null || !zotero_key) {
        return { ok: false, error: 'Provide library_id + zotero_key' };
    }
    const ref: ZoteroItemReference = { library_id, zotero_key };
    // `resolveItemDisplay` returns null for missing/unresolvable refs.
    const display = await zoteroItemData.resolveItemDisplay(ref);
    return { ok: true, display };
}
