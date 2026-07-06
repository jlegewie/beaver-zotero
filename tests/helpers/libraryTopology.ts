/**
 * Runtime discovery of the connected Zotero's library topology, so the
 * library-identity live tests assert against whatever personal + group
 * libraries actually exist on this machine instead of hard-coded ids.
 *
 * Uses the production `/beaver/library/libraries` and `/beaver/library/list`
 * handlers (the same ones the change under test touches).
 */

import { post } from './zoteroHttpClient';

export interface LibraryInfo {
    library_id: number;
    library_ref?: string;
    name: string;
    is_group: boolean;
    read_only: boolean;
    item_count: number;
}

interface ListLibrariesResponse {
    libraries: LibraryInfo[];
    total_count: number;
}

interface ListItemsResponse {
    items: Array<{ item_id: string; library_ref?: string; result_type?: string }>;
    library_name?: string;
    error?: string | null;
}

export interface LibraryTopology {
    personal: LibraryInfo;
    /** First group library (may be read-only), or null when none exist. */
    group: LibraryInfo | null;
    /** First editable group library, or null. Safe target for write actions. */
    editableGroup: LibraryInfo | null;
}

/** Fetch and classify the connected instance's libraries. */
export async function getLibraryTopology(): Promise<LibraryTopology> {
    const res = await post<ListLibrariesResponse>('/beaver/library/libraries', {});
    const libraries = res.libraries ?? [];
    const personal = libraries.find((l) => !l.is_group);
    if (!personal) {
        throw new Error('No personal library reported by /beaver/library/libraries');
    }
    const groups = libraries.filter((l) => l.is_group);
    return {
        personal,
        group: groups[0] ?? null,
        editableGroup: groups.find((l) => !l.read_only) ?? null,
    };
}

/** The `zotero_key` of the first regular item in a library, or null when empty. */
export async function firstItemKey(library_id: number): Promise<string | null> {
    const res = await post<ListItemsResponse>('/beaver/library/list', {
        library_id,
        limit: 1,
    });
    const first = res.items?.[0];
    if (!first?.item_id) return null;
    const dash = first.item_id.indexOf('-');
    return dash > 0 ? first.item_id.slice(dash + 1) : null;
}

/** The full `<library_id>-<zotero_key>` id of the first regular item, or null. */
export async function firstItemId(library_id: number): Promise<string | null> {
    const res = await post<ListItemsResponse>('/beaver/library/list', {
        library_id,
        limit: 1,
    });
    return res.items?.[0]?.item_id ?? null;
}

/** Derive the numeric groupID encoded in a `"g<groupID>"` ref (null if not a group ref). */
export function groupIdFromRef(library_ref: string | undefined): number | null {
    if (!library_ref || library_ref[0] !== 'g') return null;
    const n = parseInt(library_ref.slice(1), 10);
    return Number.isFinite(n) ? n : null;
}
