/**
 * Beaver's private metadata on Zotero note citations.
 *
 * A note citation (`<span class="citation" data-citation="…">`) stores CSL
 * citation items: `uris`, a `locator` that is a printed page label, and
 * optional `label` / `prefix` / `suffix`. That cannot say what Beaver cited: a
 * sentence (`s5.6-s5.9`) rather than its page, an attachment or annotation
 * rather than the parent item, or a work found by search that is not in the
 * library. Beaver records those facts under a private `beaver` key on the
 * citation item:
 *
 *     {"uris":["…"],"locator":"12","beaver":{"v":1,"loc":"s5.6-s5.9","att":"ABCD2345"}}
 *
 * Zotero keeps unknown keys on a citation item when it parses, edits and syncs
 * a note. Its citation dialog rebuilds the item from a whitelist, so editing
 * the citation there drops the key — the right outcome, since the user's
 * citation then no longer says what Beaver cited.
 *
 * Only identity belongs here: what the citation was written as. Values derived
 * from it (page labels, previews, positions) have fresher sources and would go
 * stale in a synced note. The one exception is the CSL data of an embedded
 * work (`csl`): a work that is not in the library has no other source, and the
 * note's `data-citation-items` cache, where Zotero reads it from, is rebuilt
 * from the citations whenever Beaver edits the note.
 *
 * Readers must treat an absent or malformed key as "no Beaver metadata":
 * citations written by Zotero, other plugins or older Beaver versions never
 * carry one.
 */

import type { Locator } from '@beaver/agent-core/citations/citationGrammar';

/** Property name of the private metadata object on a CSL citation item. */
export const BEAVER_CITATION_META_KEY = 'beaver';

/**
 * Version of the metadata written by this build. It versions the meaning of
 * the fields, so adding a field must not bump it: older builds ignore fields
 * they do not know. A build ignores metadata of any other version.
 */
export const BEAVER_CITATION_META_VERSION = 1;

/** Beaver's private metadata on one CSL citation item. */
export interface BeaverCitationMeta {
    v: number;
    /** Locator token as Beaver wrote it (`page5`, `s5.6-s5.9`, `p12`). */
    loc?: string;
    /** Key of the cited attachment, when the citation names its parent item. */
    att?: string;
    /** Key of the cited annotation, when the citation names its parent item. */
    ann?: string;
    /** External reference id of an embedded work that is not in the library. */
    ext?: string;
    /** Source of `ext` (`openalex`, `semantic_scholar`). */
    src?: string;
    /** CSL-JSON of the embedded work named by `ext`. */
    csl?: Record<string, unknown>;
}

/** Whether a value has the shape of a Zotero item key. */
export function isItemKey(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9]+$/.test(value);
}

/**
 * The token to record for a locator: as written, except that a page locator
 * from the legacy `page="12"` attribute is spelled `page12`, the form it is
 * read back in.
 */
export function locatorToken(loc: Locator | undefined): string | undefined {
    if (!loc) return undefined;
    if (loc.kind === 'page' && !loc.raw.startsWith('page')) return `page${loc.value}`;
    return loc.raw || undefined;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read Beaver's metadata off a CSL citation item. Returns undefined for
 * anything that is not well-formed metadata of the current version. Never
 * throws.
 */
export function readBeaverCitationMeta(citationItem: unknown): BeaverCitationMeta | undefined {
    if (!citationItem || typeof citationItem !== 'object') return undefined;
    const raw = (citationItem as Record<string, unknown>)[BEAVER_CITATION_META_KEY];
    if (!raw || typeof raw !== 'object') return undefined;
    const meta = raw as Record<string, unknown>;
    if (meta.v !== BEAVER_CITATION_META_VERSION) return undefined;
    return buildBeaverCitationMeta({
        loc: nonEmptyString(meta.loc),
        att: nonEmptyString(meta.att),
        ann: nonEmptyString(meta.ann),
        ext: nonEmptyString(meta.ext),
        src: nonEmptyString(meta.src),
        csl: meta.csl && typeof meta.csl === 'object' && !Array.isArray(meta.csl)
            ? meta.csl as Record<string, unknown>
            : undefined,
    });
}

/**
 * Build the metadata to store on a citation item, or undefined when there is
 * nothing to record. Malformed item keys are dropped.
 */
export function buildBeaverCitationMeta(fields: Omit<BeaverCitationMeta, 'v'>): BeaverCitationMeta | undefined {
    const att = isItemKey(fields.att) ? fields.att : undefined;
    const ann = isItemKey(fields.ann) ? fields.ann : undefined;
    const ext = fields.ext || undefined;
    const meta: BeaverCitationMeta = {
        v: BEAVER_CITATION_META_VERSION,
        ...(fields.loc ? { loc: fields.loc } : {}),
        ...(att ? { att } : {}),
        ...(ann ? { ann } : {}),
        ...(ext ? { ext } : {}),
        ...(ext && fields.src ? { src: fields.src } : {}),
        ...(ext && fields.csl ? { csl: fields.csl } : {}),
    };
    return Object.keys(meta).length > 1 ? meta : undefined;
}

/** How a citation with Beaver metadata reads back; see {@link citationReadback}. */
export interface CitationReadback {
    /** The cited annotation or attachment, when the citation names its parent. */
    childKey?: string;
    /**
     * Locator token the citation reads back with (empty for none), or null when
     * it reads back with the page it stores, as a citation without metadata.
     */
    loc: string | null;
}

/** Key of the annotation or attachment Beaver's metadata says was cited. */
export function citedChildKey(meta: BeaverCitationMeta | undefined): string | undefined {
    return meta?.ann ?? meta?.att;
}

/**
 * How a single native citation item reads back from Beaver's metadata, or null
 * when it reads back as a citation of the parent item: it has no metadata, or
 * the annotation or attachment it records no longer exists (`childExists`).
 * In the second case the simplifier still takes the physical page the
 * metadata records, since the stored locator may be a printed label.
 *
 * An annotation citation reads back without a locator (its page is the
 * annotation's), and others with the locator Beaver recorded. A citation whose
 * metadata records only the attachment reads back with the page it stores.
 */
export function citationReadback(
    citationItem: unknown,
    childExists: (key: string) => boolean,
): CitationReadback | null {
    const meta = readBeaverCitationMeta(citationItem);
    if (!meta) return null;
    const childKey = citedChildKey(meta);
    if (childKey && !childExists(childKey)) return null;
    if (meta.ann) return { childKey, loc: '' };
    const locator = (citationItem as { locator?: unknown }).locator;
    const storesPage = locator != null && locator !== '';
    if (meta.loc || !storesPage) return { childKey, loc: meta.loc ?? '' };
    return { childKey, loc: null };
}
