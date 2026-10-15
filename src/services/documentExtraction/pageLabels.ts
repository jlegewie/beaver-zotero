/**
 * The page-label namespaces of a PDF attachment.
 *
 * - **Printed** labels are the page numbers printed on the pages
 *   (`resolvePrintedPageLabels`). Everything Beaver shows a person or sends the
 *   model as a page number uses them: chat citations, file exports, the
 *   `page_label` fields of backend responses.
 * - **Zotero locator** labels are what Beaver writes into Zotero as
 *   note-citation locators (`resolveZoteroLocatorPageLabels`): the printed
 *   label, else the label the PDF declares. Pages with neither take their
 *   physical number at the caller. Annotation labels follow the same rule but
 *   are proposed by the backend, which has the structured document even when
 *   this computer never extracted it, and stored as proposed.
 * - **Declared** labels are the PDF's own `/PageLabels`. Native note citations
 *   without Beaver's metadata are read back in them, model page references
 *   fall back to them, and the page suffix of a link citation that cannot
 *   carry its page is written in them (`linkCitationPageLabelNamespace`).
 *
 * This module is the only reader of the cache record's label fields outside
 * the document cache. Every consumer picks a namespace here, so a policy change
 * is made in one place.
 *
 * Maps are keyed by 0-based page index. `null` means the attachment has no
 * labels in that namespace (or they are not known yet).
 *
 * React-free and safe in both bundles (reads `Zotero.Beaver`, never `addon`).
 */

import {
    resolvePrintedPageLabels,
    resolveZoteroLocatorPageLabels,
} from '@beaver/agent-core/extract/pageLabels/printedPageLabels';
import type { DocumentCacheMetadata, PageLabels } from '../documentCache';
import type { StoredLocatorPageLabels } from '../../utils/pageLabelTranslation';

export type PageLabelNamespace = 'printed' | 'locator' | 'declared';

function nonEmpty(labels: PageLabels | null | undefined): PageLabels | null {
    if (!labels) return null;
    const out: PageLabels = {};
    for (const [index, label] of Object.entries(labels)) {
        if (typeof label === 'string' && label.trim() !== '') out[index] = label;
    }
    return Object.keys(out).length > 0 ? out : null;
}

function stringKeys(labels: Record<number, string>): PageLabels | null {
    return nonEmpty(Object.fromEntries(
        Object.entries(labels).map(([index, label]) => [String(index), label]),
    ));
}

/** Printed labels from a cache record. */
export function printedPageLabelsFromMetadata(
    record: DocumentCacheMetadata | null | undefined,
): PageLabels | null {
    if (!record) return null;
    return stringKeys(resolvePrintedPageLabels({
        pageCount: record.pageCount,
        derived: record.derivedPageLabels,
        embedded: record.pageLabels,
    }));
}

/**
 * Zotero locator labels from a cache record. A record that does not know its
 * printed labels yet (`derivedPageLabels` undefined) yields only the declared
 * ones; `loadPageLabelsForMetadata` recovers the printed labels first.
 */
export function zoteroLocatorPageLabelsFromMetadata(
    record: DocumentCacheMetadata | null | undefined,
): PageLabels | null {
    if (!record) return null;
    return stringKeys(resolveZoteroLocatorPageLabels({
        pageCount: record.pageCount,
        derived: record.derivedPageLabels,
        embedded: record.pageLabels,
    }));
}

/** Labels the PDF declares (its `/PageLabels`) from a cache record. */
export function declaredPageLabelsFromMetadata(
    record: DocumentCacheMetadata | null | undefined,
): PageLabels | null {
    return nonEmpty(record?.pageLabels);
}

/** Labels of one namespace from a cache record. */
export function pageLabelsFromMetadata(
    record: DocumentCacheMetadata | null | undefined,
    namespace: PageLabelNamespace,
): PageLabels | null {
    if (namespace === 'printed') return printedPageLabelsFromMetadata(record);
    if (namespace === 'declared') return declaredPageLabelsFromMetadata(record);
    return zoteroLocatorPageLabelsFromMetadata(record);
}

/**
 * A cache record with its printed labels known where the cache can tell.
 * Records written before derived labels were cached, or by a path that only
 * analyzed the PDF, do not know them; they are recovered from the cached
 * structured payload, which also backfills the record. Without a payload the
 * record is returned as is. Cache only; never extracts.
 */
async function withDerivedPageLabels(
    record: DocumentCacheMetadata,
    filePath: string,
): Promise<DocumentCacheMetadata> {
    if (record.derivedPageLabels !== undefined || record.contentKind !== 'pdf') return record;
    const serialized = await Zotero.Beaver?.documentCache?.getSerializedResult(
        { libraryId: record.libraryId, zoteroKey: record.zoteroKey },
        'structured',
        filePath,
    ).catch(() => null);
    const derivedPageLabels = serialized?.metadata.derivedPageLabels;
    return derivedPageLabels === undefined ? record : { ...record, derivedPageLabels };
}

/**
 * Labels of one namespace for a cache record, read from `filePath`, with
 * printed labels recovered from the cached payload when the record lacks them
 * (`withDerivedPageLabels`). Cache only; never extracts.
 */
export async function loadPageLabelsForMetadata(
    record: DocumentCacheMetadata | null | undefined,
    namespace: PageLabelNamespace,
    filePath: string,
): Promise<PageLabels | null> {
    if (!record) return null;
    if (namespace === 'declared') return declaredPageLabelsFromMetadata(record);
    return pageLabelsFromMetadata(await withDerivedPageLabels(record, filePath), namespace);
}

/**
 * Label maps stored note-citation locators are read back through
 * (`StoredLocatorPageLabels`): the declared labels and the Zotero locator
 * labels, or one map when they agree; null when there are none. Cache only;
 * never extracts.
 */
export async function loadStoredLocatorPageLabels(
    record: DocumentCacheMetadata | null | undefined,
    filePath: string,
): Promise<StoredLocatorPageLabels | null> {
    if (!record) return null;
    const resolved = await withDerivedPageLabels(record, filePath);
    const declared = declaredPageLabelsFromMetadata(resolved);
    const locator = zoteroLocatorPageLabelsFromMetadata(resolved);
    if (!declared && !locator) return null;
    return sameLabels(declared, locator) ? declared : { declared, locator };
}

function sameLabels(a: PageLabels | null, b: PageLabels | null): boolean {
    if (!a || !b) return a === b;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
