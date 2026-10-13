/**
 * Native note citations for the citation targets that are not plain library
 * items: annotations, external works, and items whose attachment has no
 * printed pages. Shared by note writes (`noteCitationExpand.ts`) and by saving
 * a chat response as a note, so both store a citation the same way.
 */

import type { Locator } from '@beaver/agent-core/citations/citationGrammar';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { externalReferenceToCsl, externalReferenceUri } from '@beaver/agent-export/citations/externalCsl';
import { isPdfDocument } from './attachmentFiles';
import { buildBeaverCitationMeta, locatorToken, readBeaverCitationMeta } from './noteCitationMeta';
import { normalizePageLocator } from './pageLabelTranslation';
import { getBestPDFAttachment } from './zoteroItemHelpers';
import {
    buildEmbeddedNoteCitation,
    buildNoteCitation,
    type NoteCitationData,
    type NoteCitationItemOptions,
} from './zoteroUtils';

export type BuiltNoteCitation = { citation: NoteCitationData; formatted: string };

/**
 * Whether a page locator on `item` names a printed page. Pages are counted in
 * the item itself when it is an attachment, otherwise in its best attachment.
 * Only PDFs have printed pages: an EPUB "page" is a section number, and other
 * documents have none. An item without attachments cites the printed work.
 */
export function citesPrintedPages(item: Zotero.Item): boolean {
    const attachment = item.isAttachment() ? item : getBestPDFAttachment(item);
    return !attachment || isPdfDocument(attachment);
}

/**
 * Cite an annotation as Zotero does when an annotation is added to a note: a
 * native citation of the item the annotated file belongs to, at the
 * annotation's page. The annotation's key is kept in the private metadata so
 * the citation reads back as a citation of the annotation. Returns null for an
 * annotation in a file without a parent item, which is cited by a link.
 */
export function buildAnnotationNoteCitation(
    annotation: Zotero.Item,
    options?: NoteCitationItemOptions,
): BuiltNoteCitation | null {
    const attachment = annotation.parentID ? Zotero.Items.get(annotation.parentID) : null;
    const parent = attachment?.parentID ? Zotero.Items.get(attachment.parentID) : null;
    if (!parent || !parent.isRegularItem()) return null;
    let pageLabel: string | undefined;
    try {
        pageLabel = annotation.annotationPageLabel || undefined;
    } catch {
        pageLabel = undefined;
    }
    return buildNoteCitation(parent, pageLabel, options, buildBeaverCitationMeta({ ann: annotation.key }));
}

/**
 * Cite an external work (found by search, not in the library) as a native
 * citation of an embedded item: a stable URI that never resolves to a library
 * item, with the work's CSL data stored in the note's citation cache. Zotero
 * formats it like any other citation. The private metadata keeps the external
 * id, so it reads back as `<citation external_id="…"/>`, and the CSL data, so
 * the cache entry can be rebuilt from the citation itself (after an undo, or
 * on another computer).
 */
export function buildExternalNoteCitation(
    externalId: string,
    reference: ExternalReference,
    loc: Locator | undefined,
    options?: NoteCitationItemOptions,
): BuiltNoteCitation {
    const uri = externalReferenceUri(externalId, reference);
    const itemData = externalReferenceToCsl(reference, uri);
    const page = loc?.kind === 'page' ? normalizePageLocator(loc.value) : undefined;
    const meta = buildBeaverCitationMeta({
        loc: locatorToken(loc),
        ext: externalId,
        src: reference.source,
        csl: itemData,
    });
    return buildEmbeddedNoteCitation(uri, itemData, page, options, meta);
}

/**
 * Rebuild a stored citation of an embedded work with a new locator, from the
 * data the citation carries itself. Lets a note be edited from any chat, not
 * only the one whose search found the work. Returns null when the citation
 * carries no embedded work.
 */
export function rebuildEmbeddedNoteCitation(
    citationItem: unknown,
    loc: Locator | undefined,
    options?: NoteCitationItemOptions,
): BuiltNoteCitation | null {
    const meta = readBeaverCitationMeta(citationItem);
    const uri = (citationItem as { uris?: unknown[] } | null)?.uris?.[0];
    if (!meta?.ext || !meta.csl || typeof uri !== 'string' || !uri) return null;
    const page = loc?.kind === 'page' ? normalizePageLocator(loc.value) : undefined;
    const rebuiltMeta = buildBeaverCitationMeta({
        loc: locatorToken(loc),
        ext: meta.ext,
        src: meta.src,
        csl: meta.csl,
    });
    return buildEmbeddedNoteCitation(uri, meta.csl, page, options, rebuiltMeta);
}
