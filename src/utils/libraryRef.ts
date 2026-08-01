/**
 * Pure grammar for Beaver's device-portable `library_ref` identifier.
 *
 * Zotero's `libraryID` is a device-local SQLite rowid. `library_ref` is the
 * stable library identifier that is the same on every device:
 *   - `"u"` for the personal library. Currently, one-Zotero-account-per-Beaver-account
 *     is enforced. In the future, we enforce it on the thread level.
 *     With a different Zotero account it degrades to "not found",
 *     never a wrong write.
 *   - `"g<groupID>"` for a group library, where `groupID` is Zotero's
 *     server-assigned group id.
 *
 * Distinct from the search-index scope ref (`getIndexScopeRef` in
 * `zoteroUtils.ts`), which scopes the personal library by account/device
 * (`u<userID>` / `l<localUserKey>`). The two grammars are not interchangeable.
 *
 * This module only parses and formats strings — it has no Zotero dependency.
 * Resolving a `library_ref` against this device's local libraries (and
 * everything else that touches `Zotero.*`) lives in `libraryIdentity.ts`,
 * which also re-exports everything here.
 *
 * This module is esbuild-safe (no `react/*` imports, no Jotai, no
 * supabase) so it can be used from both the esbuild and webpack bundles.
 */

/** Sentinel library id used for user-attached external files (mirrors `EXTERNAL_LIBRARY_ID` in `src/services/externalFiles.ts`). Never a real Zotero library. */
export const EXTERNAL_FILE_LIBRARY_SENTINEL = -1;

/** Grammar for `library_ref`: `"u"` (personal library) or `"g<groupID>"` (group library, groupID >= 1). */
export const LIBRARY_REF_PATTERN = /^(u|g[1-9][0-9]*)$/;

/** A `library_ref` parsed into its structured form. */
export type ParsedLibraryRef = { type: 'user' } | { type: 'group'; groupID: number };

/** Parses a `library_ref` string. Returns `null` when it doesn't match the grammar. */
export function parseLibraryRef(ref: string): ParsedLibraryRef | null {
    if (!LIBRARY_REF_PATTERN.test(ref)) return null;
    if (ref === 'u') return { type: 'user' };
    return { type: 'group', groupID: parseInt(ref.slice(1), 10) };
}

/**
 * Sentinel `library_id` for a reference whose portable `library_ref` names a
 * library this device cannot map (e.g. a group the user isn't a member of
 * here). Zotero rowids start at 1 and `-1` is the external-file sentinel, so
 * `0` is unambiguous. Resolution helpers treat such references as
 * `library_unavailable` via their `library_ref`; never look up library `0`.
 */
export const UNRESOLVED_LIBRARY_ID = 0;

/** A model-facing item id parsed into its portable-or-legacy library reference + key. */
export type ParsedItemReference = { library_ref?: string; library_id?: number; zotero_key: string };

/**
 * Parses a model-facing item id `"<prefix>-<zotero_key>"` where `<prefix>` is
 * either a portable `library_ref` (`"u"` | `"g<groupID>"`) or a legacy
 * device-local numeric `library_id`. Zotero keys contain no hyphen, so the first
 * hyphen splits prefix from key unambiguously. Returns `null` on malformed input.
 *
 * Feed directly into `resolveItemReference` / `resolveLibraryRef`: a portable
 * prefix yields `library_ref` (which wins), a numeric prefix yields the legacy
 * `library_id`.
 */
export function parseItemReference(itemId: string): ParsedItemReference | null {
    const idx = itemId.indexOf('-');
    if (idx <= 0 || idx === itemId.length - 1) return null;
    const prefix = itemId.slice(0, idx);
    const zotero_key = itemId.slice(idx + 1);
    if (LIBRARY_REF_PATTERN.test(prefix)) return { library_ref: prefix, zotero_key };
    // Strict numeric prefix: `parseInt` would silently accept "5abc" as 5, which
    // violates the malformed → null contract, so gate on a digits-only prefix first.
    if (!/^[1-9][0-9]*$/.test(prefix)) return null;
    return { library_id: parseInt(prefix, 10), zotero_key };
}

/** A fully resolved item reference: local `library_id` (or `UNRESOLVED_LIBRARY_ID`), portable `library_ref` when known, and the item key. */
export type ObjectIdReference = { library_id: number; library_ref?: string; zotero_key: string };

/**
 * Builds the model-facing object id from an already-structured reference,
 * preferring its stored `library_ref` over the device-local `library_id`.
 */
export function modelObjectIdFromReference(ref: {
    library_id: number;
    library_ref?: string | null;
    zotero_key: string;
}): string {
    return `${ref.library_ref ?? ref.library_id}-${ref.zotero_key}`;
}

export type WriteTargetLibraryResolution =
    | { ok: true; libraryID: number }
    | { ok: false; code: 'invalid_library_ref' | 'library_unavailable' | 'invalid_library_id' | 'library_not_found'; message: string };

/**
 * Maps a failed write-target resolution to the model-facing `{ error, error_code }`
 * an agent-action response carries. Collapses the resolver's four internal codes
 * to the two the wire protocol uses, so every action reports the same
 * `error_code` for the same underlying failure.
 */
export function writeTargetLibraryError(
    resolution: Extract<WriteTargetLibraryResolution, { ok: false }>
): { error: string; error_code: 'library_unavailable' | 'library_not_found' } {
    return {
        error: resolution.message,
        error_code: resolution.code === 'library_unavailable' ? 'library_unavailable' : 'library_not_found',
    };
}
