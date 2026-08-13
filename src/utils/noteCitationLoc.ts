/**
 * Beaver's private locator key inside Zotero note citations.
 *
 * A Zotero note citation is a `<span class="citation" data-citation="…">` whose
 * attribute holds a URL-encoded CSL citation object. Its `citationItems[i]`
 * entries carry Zotero's own fields (`uris`, `itemData`, `locator`, `label`),
 * where `locator` is a *printed page label* such as `"xiv"`.
 *
 * Beaver's agent-facing locators are richer tokens (`s56-s59`, `page5`, `l50`,
 * `p3`) that a page label cannot represent. We therefore record the token
 * verbatim under a private `beaver` key on the citation item, next to Zotero's
 * locator:
 *
 *     {"uris":["…"],"locator":"3","label":"page","beaver":{"v":1,"loc":"s56-s59","att":"G7TTJKFH"}}
 *
 * This is safe because Zotero treats the citation object opaquely: the note
 * editor's ProseMirror schema round-trips `data-citation` as parsed JSON
 * without pruning unknown keys, so the meta survives editing and syncing.
 * Verified against the shipped note-editor bundle, which is byte-identical
 * across Zotero 7 through 10. (Zotero does NOT extend the same courtesy to
 * `data-annotation`, which it rebuilds from a whitelist.)
 *
 * WHAT BELONGS HERE. Only facts that are (a) unrecoverable from anywhere else
 * and (b) still true later. The agent's locator token qualifies: nothing else
 * records it. Derived state does NOT — page labels, previews, formatted
 * citations and resolved page numbers all have a fresher source, and a copy
 * frozen into a synced note is a stale cache that outlives its truth. Run-scoped
 * ids do not either: they dangle the moment a thread is deleted.
 *
 * Degradation rule: an absent or malformed key simply means "no Beaver locator
 * recorded". Every reader must fall back to its other sources rather than
 * error — citations written by Zotero itself, by other plugins, or by older
 * Beaver versions will never carry it.
 */

/** Property name of the private meta object on a CSL citation item. */
export const BEAVER_CITATION_META_KEY = 'beaver';

/**
 * Version of the meta payload written by this build.
 *
 * `v` VERSIONS THE GRAMMAR OF `loc`, AND NOTHING ELSE. Adding a sibling field
 * must NOT bump it: unknown fields are ignored by design, so an older build
 * keeps reading `loc` out of a payload a newer one extended. Bump only if `loc`
 * itself would mean something different — a new locator grammar, or a change to
 * the numbering it counts in.
 *
 * That restraint is load-bearing, because the cost of a needless bump is not
 * merely a missed read. An older build that cannot read `loc` projects the
 * citation as note-space; if the model then CHANGES that citation's locator,
 * the rebuild stores it as a printed label and drops the key — so a round trip
 * through the older build ERASES the token rather than just ignoring it. (An
 * edit that leaves the citation alone is safe: unchanged citations keep their
 * stored raw HTML verbatim.)
 */
export const BEAVER_CITATION_META_VERSION = 1;

/** Beaver's private per-citation-item metadata. */
export interface BeaverCitationMeta {
    /** Grammar version of {@link BeaverCitationMeta.loc}; see {@link BEAVER_CITATION_META_VERSION}. */
    v: number;
    /** Beaver locator token exactly as the agent wrote it (e.g. `s56-s59`). */
    loc?: string;
    /**
     * Attachment `loc` addresses. Without this, readers re-resolve "best PDF"
     * and a new or reordered file silently re-points the token.
     */
    att?: string;
}

/**
 * Read and validate Beaver's meta object off a CSL citation item.
 *
 * Returns undefined for anything that is not a well-formed payload of a version
 * this build understands. Never throws. Unknown sibling fields are preserved by
 * the caller's data and simply not returned here.
 */
export function readBeaverMeta(citationItem: unknown): BeaverCitationMeta | undefined {
    if (!citationItem || typeof citationItem !== 'object') return undefined;

    const meta = (citationItem as Record<string, unknown>)[BEAVER_CITATION_META_KEY];
    if (!meta || typeof meta !== 'object') return undefined;

    // A payload written under a version this build does not know may mean
    // something else by `loc`, so it is not read at all. The citation still has
    // its CSL locator, which is what the caller falls back to.
    if ((meta as Record<string, unknown>).v !== BEAVER_CITATION_META_VERSION) return undefined;

    const raw = meta as Record<string, unknown>;
    const loc = typeof raw.loc === 'string' && raw.loc.length > 0 ? raw.loc : undefined;
    const att = typeof raw.att === 'string' && raw.att.length > 0 ? raw.att : undefined;
    if (!loc && !att) return undefined;

    return { v: BEAVER_CITATION_META_VERSION, ...(loc ? { loc } : {}), ...(att ? { att } : {}) };
}

/**
 * Read the Beaver locator token from a CSL citation item.
 *
 * Returns undefined for any input that is not an object carrying a well-formed
 * meta with a non-empty string `loc`. Never throws.
 */
export function readBeaverLoc(citationItem: unknown): string | undefined {
    return readBeaverMeta(citationItem)?.loc;
}

/** Pinned attachment key, or undefined if the citation was never pinned. */
export function readBeaverAtt(citationItem: unknown): string | undefined {
    return readBeaverMeta(citationItem)?.att;
}

/** Build the meta object to store on a citation item. `att` is optional. */
export function buildBeaverCitationMeta(loc: string, att?: string): BeaverCitationMeta {
    return { v: BEAVER_CITATION_META_VERSION, loc, ...(att ? { att } : {}) };
}
