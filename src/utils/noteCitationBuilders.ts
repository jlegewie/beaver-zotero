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
import { normalizePageRange } from './pageLabelTranslation';
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
    let pageIndex: unknown;
    try {
        pageIndex = JSON.parse(annotation.annotationPosition)?.pageIndex;
    } catch {
        pageIndex = undefined;
    }
    // The annotation's physical page is recorded too: the locator is its label,
    // which may be printed, and the page is needed if the annotation is deleted.
    const loc = typeof pageIndex === 'number' && Number.isInteger(pageIndex) && pageIndex >= 0
        ? `page${pageIndex + 1}`
        : undefined;
    return buildNoteCitation(parent, pageLabel, options, buildBeaverCitationMeta({ ann: annotation.key, loc }));
}

/** An external work, as an embedded citation names and describes it. */
interface EmbeddedWork {
    uri: string;
    csl: Record<string, unknown>;
    ext: string;
    src?: string;
}

/** Native citation of an embedded work, at a locator. */
function embeddedWorkCitation(
    work: EmbeddedWork,
    loc: Locator | undefined,
    options?: NoteCitationItemOptions,
): BuiltNoteCitation {
    const page = loc?.kind === 'page' ? normalizePageRange(loc.value) || undefined : undefined;
    const meta = buildBeaverCitationMeta({ loc: locatorToken(loc), ext: work.ext, src: work.src, csl: work.csl });
    return buildEmbeddedNoteCitation(work.uri, work.csl, page, options, meta);
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
    const work = { uri, csl: externalReferenceToCsl(reference, uri), ext: externalId, src: reference.source };
    return embeddedWorkCitation(work, loc, options);
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
    return embeddedWorkCitation({ uri, csl: meta.csl, ext: meta.ext, src: meta.src }, loc, options);
}
