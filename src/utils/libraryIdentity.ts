/**
 * Device-portable Zotero library identity.
 *
 * Zotero's `libraryID` is a device-local SQLite rowid. `library_ref` is the
 * stable library identifiers that are the same on every device:
 *   - `"u"` for the personal library. Currently, one-Zotero-account-per-Beaver-account
 *     is enforced. In the future, we enforce it on the thread level.
 *     With a different Zotero account it degrades to "not found",
 *     never a wrong write.
 *   - `"g<groupID>"` for a group library, where `groupID` is Zotero's
 *     server-assigned group id.
 *
 * This module is esbuild-safe (no `react/*` imports, no Jotai, no
 * supabase) so it can be used from both the esbuild and webpack bundles.
 */

/** Sentinel library id used for user-attached external files (mirrors `EXTERNAL_LIBRARY_ID` in `src/services/externalFiles.ts`). Never a real Zotero library. */
const EXTERNAL_FILE_LIBRARY_SENTINEL = -1;

/** Grammar for `library_ref`: `"u"` (personal library) or `"g<groupID>"` (group library, groupID >= 1). */
export const LIBRARY_REF_PATTERN = /^(u|g[1-9][0-9]*)$/;

/**
 * Computes the portable `library_ref` for a device-local `libraryID`.
 *
 * Returns `null` when there is no portable identity to compute: the
 * external-file sentinel, a feed library, an unrecognized library, or a
 * group lookup that fails (Zotero's `getGroupIDFromLibraryID` throws when
 * the group isn't registered or the cache isn't initialized).
 */
export function libraryRefForLibraryID(libraryID: number): string | null {
    if (libraryID === EXTERNAL_FILE_LIBRARY_SENTINEL) return null;

    // The whole body is best-effort
    try {
        if (libraryID === Zotero.Libraries.userLibraryID) return 'u';

        const groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
        // Real group ids are positive; guard the false/undefined a non-group
        // library could return despite the declared non-nullable return type.
        if (!groupID) return null;

        // Only ever emit a grammar-conforming ref
        const ref = `g${groupID}`;
        return LIBRARY_REF_PATTERN.test(ref) ? ref : null;
    } catch {
        // Not a group library (e.g. a feed) or the Groups cache isn't ready.
        return null;
    }
}

/** A `library_ref` parsed into its structured form. */
export type ParsedLibraryRef = { type: 'user' } | { type: 'group'; groupID: number };

/** Parses a `library_ref` string. Returns `null` when it doesn't match the grammar. */
export function parseLibraryRef(ref: string): ParsedLibraryRef | null {
    if (!LIBRARY_REF_PATTERN.test(ref)) return null;
    if (ref === 'u') return { type: 'user' };
    return { type: 'group', groupID: parseInt(ref.slice(1), 10) };
}

/**
 * Resolves a `{ library_ref?, library_id }` pair to a local `libraryID`.
 *
 * - `library_ref === "u"` resolves to this device's personal library.
 * - `library_ref === "g<id>"` resolves via the local group registry; `null`
 *   when this device has no such group (do not treat this as "not found" —
 *   the library itself isn't available here, the item may well still exist).
 * - `library_ref` absent or unparseable falls back to `library_id` verbatim
 *   (today's legacy behavior — covers every reference written before this
 *   field existed).
 * - When both are present and disagree, `library_ref` wins: it is the
 *   portable identity, `library_id` is only a same-device cache of it.
 */
export function resolveLibraryRef(ref: { library_ref?: string | null; library_id: number }): number | null {
    const parsed = ref.library_ref ? parseLibraryRef(ref.library_ref) : null;
    if (!parsed) {
        // Absent or unparseable: fall back to legacy behavior.
        return ref.library_id;
    }

    // Best-effort, like `libraryRefForLibraryID`: never throw even if
    // `Zotero.Libraries`/`Zotero.Groups` are unavailable.
    try {
        if (parsed.type === 'user') return Zotero.Libraries.userLibraryID;
        const libraryID = Zotero.Groups.getLibraryIDFromGroupID(parsed.groupID);
        return libraryID || null;
    } catch {
        return null;
    }
}

/** Outcome of resolving an item reference on this device. */
export type ResolvedItemReference =
    | { status: 'found'; item: Zotero.Item }
    | { status: 'library_unavailable' }
    | { status: 'not_found' };

/**
 * Resolves a `(library_ref, library_id, zotero_key)` reference to a Zotero
 * item on this device, distinguishing "this device doesn't have that
 * library" (`library_unavailable`) from "the library resolved but the key
 * doesn't exist there" (`not_found` — genuinely gone, merged, or moved).
 */
export async function resolveItemReference(
    ref: { library_ref?: string | null; library_id: number; zotero_key: string }
): Promise<ResolvedItemReference> {
    const libraryID = resolveLibraryRef(ref);
    // `resolveLibraryRef` returns null when a group isn't on this device, and can
    // fall back to a bare `library_id`
    if (!libraryID) {
        return { status: 'library_unavailable' };
    }

    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, ref.zotero_key);
    if (!item) {
        return { status: 'not_found' };
    }
    return { status: 'found', item };
}
