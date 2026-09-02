/**
 * Zotero object links in chat markdown.
 *
 * The model can link prose to something it has seen in the library —
 * `[Smith 2004](u-ANVV522N)` — using the same object id every tool result
 * reports: `u-KEY`, `g<groupID>-KEY`, or the legacy device-local
 * `<libraryID>-KEY`. The key may name any keyed Zotero object in that library:
 * a regular item, attachment, note, annotation, or collection. Zotero's own
 * `zotero://select/...` item and collection URIs are accepted too, so a link
 * written in that grammar behaves the same way.
 *
 * Parsing is pure. Resolving a link against the libraries on this computer
 * happens at click time, through the host (`navigation.revealObject`).
 */
import { parseItemReference, resolveLibraryRefForLibraryID } from '@beaver/agent-core/identity/libraryRef';

/**
 * Shape of a Zotero object key. Zotero generates eight characters from an
 * uppercase alphanumeric alphabet; this is what keeps an ordinary relative link
 * such as `u-turn` from being mistaken for an object id.
 */
const OBJECT_KEY_PATTERN = /^[A-Z0-9]{8}$/;

/** `zotero://select/library/items/KEY`, `.../groups/<id>/collections/KEY`, ... */
const SELECT_URI_PATTERN = /^zotero:\/\/select\/(library|groups\/([1-9][0-9]*))\/(items|collections)\/([^/?#]+)$/;

/** A markdown href recognized as a link to a Zotero object. */
export type ItemLinkTarget = {
    /** Model-facing object id: `u-KEY`, `g<groupID>-KEY`, or `<libraryID>-KEY`. */
    objectId: string;
    /**
     * What the key names. A bare object id does not say, so it is an `object`
     * (item or collection, decided when the link is followed); only a
     * `zotero://select/.../collections/KEY` URI is a known `collection`.
     */
    kind: 'object' | 'collection';
};

/**
 * Recognize an href as a link to a Zotero object. Returns `null` for every
 * other href (web links, fragments, `zotero://beaver/...` thread links, ...),
 * which then keep their ordinary link behavior.
 */
export function parseItemLinkHref(href: string | null | undefined): ItemLinkTarget | null {
    if (!href) return null;

    const select = SELECT_URI_PATTERN.exec(href);
    if (select) {
        const [, scope, groupID, type, key] = select;
        if (!OBJECT_KEY_PATTERN.test(key)) return null;
        const libraryRef = scope === 'library' ? 'u' : `g${groupID}`;
        return { objectId: `${libraryRef}-${key}`, kind: type === 'collections' ? 'collection' : 'object' };
    }

    if (href.includes('/') || href.includes(':')) return null;
    const parsed = parseItemReference(href);
    if (!parsed || !OBJECT_KEY_PATTERN.test(parsed.zotero_key)) return null;
    return { objectId: href, kind: 'object' };
}

/**
 * The `zotero://select` URI an item link should carry when the rendered
 * markdown is saved into a Zotero note, where a bare object id is not a
 * working link. Returns `null` when the href is not an item link, or when a
 * legacy numeric id names a library with no portable identity on this device.
 *
 * A bare object id is written as an item URI: it cannot say whether it names a
 * collection, and items are what prose links point at in practice.
 */
export function itemLinkExportHref(href: string): string | null {
    const target = parseItemLinkHref(href);
    if (!target) return null;
    const parsed = parseItemReference(target.objectId);
    if (!parsed) return null;
    const libraryRef = parsed.library_ref ?? resolveLibraryRefForLibraryID(parsed.library_id!);
    if (!libraryRef) return null;
    const scope = libraryRef === 'u' ? 'library' : `groups/${libraryRef.slice(1)}`;
    const type = target.kind === 'collection' ? 'collections' : 'items';
    return `zotero://select/${scope}/${type}/${parsed.zotero_key}`;
}
