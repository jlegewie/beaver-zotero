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
 *     {"uris":["…"],"locator":"3","label":"page","beaver":{"v":1,"loc":"s56-s59"}}
 *
 * This is safe because Zotero treats the citation object opaquely: the note
 * editor's ProseMirror schema round-trips `data-citation` as parsed JSON
 * without pruning unknown keys, so the meta survives editing and syncing.
 *
 * Degradation rule: an absent or malformed key simply means "no Beaver locator
 * recorded". Every reader must fall back to its other sources rather than
 * error — citations written by Zotero itself, by other plugins, or by older
 * Beaver versions will never carry it.
 */

/** Property name of the private meta object on a CSL citation item. */
export const BEAVER_CITATION_META_KEY = 'beaver';

/** Version of the meta payload written by this build. */
export const BEAVER_CITATION_META_VERSION = 1;

/** Beaver's private per-citation-item metadata. */
export interface BeaverCitationMeta {
    /** Payload version, so future readers can detect shape changes. */
    v: number;
    /** Beaver locator token exactly as the agent wrote it (e.g. `s56-s59`). */
    loc?: string;
}

/**
 * Read the Beaver locator token from a CSL citation item.
 *
 * Returns undefined for any input that is not an object carrying a well-formed
 * meta with a non-empty string `loc`. Never throws.
 */
export function readBeaverLoc(citationItem: unknown): string | undefined {
    if (!citationItem || typeof citationItem !== 'object') return undefined;

    const meta = (citationItem as Record<string, unknown>)[BEAVER_CITATION_META_KEY];
    if (!meta || typeof meta !== 'object') return undefined;

    const loc = (meta as Record<string, unknown>).loc;
    if (typeof loc !== 'string' || loc.length === 0) return undefined;

    return loc;
}

/** Build the meta object to store on a citation item for a locator token. */
export function buildBeaverCitationMeta(loc: string): BeaverCitationMeta {
    return { v: BEAVER_CITATION_META_VERSION, loc };
}
