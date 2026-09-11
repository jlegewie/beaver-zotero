import type { ZoteroInstanceRef } from "@beaver/agent-core/transport/threadService";

/**
 * Identifies a specific Zotero install for a Beaver user. `localUserKey` is always
 * present and unique per install — the stable discriminator when one Beaver account
 * has several installs running at once (e.g. work + home). The remaining fields are
 * best-effort context/labels: `userID`/`accountName` are null when Zotero sync is
 * off; `deviceName` provides a user-recognizable "work vs home" label. All extra
 * fields are resolved defensively so a failure never blocks auth.
 */
export interface ZoteroInstanceIdentity {
    /** Zotero account user ID; undefined if sync is off. Groups installs by account. */
    userID: string | undefined;
    /** Per-install key; always present. The unique discriminator between installs. */
    localUserKey: string;
    /** Zotero account login name; undefined if sync is off. */
    accountName: string | undefined;
    /** OS hostname (e.g. "XX-MacBook-Pro") — the recognizable "work vs home" label. */
    deviceName: string | undefined;
}

export function getZoteroUserIdentifier(): ZoteroInstanceIdentity {
    // First try to get the Zotero account user ID (only exists if user has Zotero sync enabled)
    const userID = Zotero.Users.getCurrentUserID();

    // Get local user key - this always exists
    const localUserKey = Zotero.Users.getLocalUserKey();

    // Account login name — only meaningful when synced; treat any failure as absent.
    let accountName: string | undefined;
    try {
        accountName = userID
            ? Zotero.Users.getCurrentUsername() || undefined
            : undefined;
    } catch (e) {
        accountName = undefined;
    }

    // OS hostname via the DNS service. NB: Services.sysinfo host/hostname props throw,
    // so the DNS service is the reliable source.
    let deviceName: string | undefined;
    try {
        const dns = Cc["@mozilla.org/network/dns-service;1"].getService(
            Ci.nsIDNSService,
        );
        deviceName = dns.myHostName || undefined;
    } catch (e) {
        deviceName = undefined;
    }

    return {
        userID: userID ? `${userID}` : undefined,
        localUserKey: `${localUserKey}`,
        accountName,
        deviceName,
    };
}

/**
 * The current install's identity as a `ZoteroInstanceRef` — the single mapping
 * point from Zotero's `{userID, localUserKey}` to the client-agnostic shape
 * used for thread scoping and mismatch checks. Returns `null` when the Zotero
 * user API is unavailable (callers then skip scoping entirely).
 */
export function currentZoteroInstanceRef(): ZoteroInstanceRef | null {
    try {
        const { userID, localUserKey } = getZoteroUserIdentifier();
        return { zoteroUserId: userID ?? null, zoteroLocalId: localUserKey };
    } catch {
        return null;
    }
}

/**
 * Search-index scope ref — the compact spelling of Zotero's object-URI scheme
 * the backend search index keys rows on:
 *
 *   group    → `g${groupID}`      (global, server-assigned group id)
 *   personal → `l${localUserKey}` (always — even when Zotero sync is on)
 *
 * This is NOT an agent-facing / model-facing identifier — it is a wire value
 * scoped to the search index alone.
 *
 * NOT the same as the agent-facing `library_ref` (`"u"` | `"g<groupID>"`, see
 * `libraryIdentity.ts`): index rows live in a namespace where two physically
 * distinct personal libraries must not collide, so the personal ref is scoped by
 * account/device. Output of this function will NOT satisfy `LIBRARY_REF_PATTERN`
 * and must never be passed to `parseLibraryRef` / `resolveLibraryRef`.
 *
 * Returns null for feed libraries (never indexed) or an unknown libraryID. The
 * local `libraryID` (sequential per Zotero DB) is deliberately NEVER used on the
 * wire — it is not portable across installs.
 */
export function getIndexScopeRef(libraryID: number): string | null {
    const library = Zotero.Libraries.get(libraryID);
    if (!library) return null;
    if (library.libraryType === "group") {
        const groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
        return groupID ? `g${groupID}` : null;
    }
    if (library.libraryType === "user") {
        const { localUserKey } = getZoteroUserIdentifier();
        return `l${localUserKey}`;
    }
    // Feed (or any other) library type — not part of the indexable scope.
    return null;
}

/**
 * Searchable index scope of the running Zotero install: the personal library's
 * index scope ref plus one `g<groupID>` per group library that is not excluded
 * in Beaver Preferences. Sent in the auth handshake so the backend can scope
 * search-index queries over the shared per-user namespace to exactly the
 * libraries this install may search. Feed libraries are excluded, the list is
 * de-duplicated, and any failure is swallowed (returns []) so scope computation
 * never blocks auth.
 */
export function getInstanceIndexScopeRefs(
    searchableLibraryIds: number[],
): string[] {
    try {
        const refs = new Set<string>();
        for (const libraryID of searchableLibraryIds) {
            const library = Zotero.Libraries.get(libraryID);
            if (!library) {
                continue;
            }
            if (
                library.libraryType !== "user" &&
                library.libraryType !== "group"
            ) {
                continue;
            }
            const ref = getIndexScopeRef(libraryID);
            if (ref) refs.add(ref);
        }
        return Array.from(refs);
    } catch (e) {
        Zotero.logError(e as Error);
        return [];
    }
}
