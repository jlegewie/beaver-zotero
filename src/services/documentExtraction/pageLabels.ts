/**
 * The two page-label namespaces of a PDF attachment.
 *
 * - **Printed** labels are the page numbers printed on the pages
 *   (`resolvePrintedPageLabels`). Everything Beaver shows a person or sends the
 *   model as a page number uses them: chat citations, file exports, the
 *   `page_label` fields of backend responses.
 * - **Zotero locator** labels are what Beaver writes into Zotero: note-citation
 *   locators and annotation page labels. Zotero navigates a note citation by
 *   exact label match against its reader's labels, so this namespace follows
 *   the labels the PDF declares (its `/PageLabels`).
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

import { resolvePrintedPageLabels } from '@beaver/agent-core/extract/pageLabels/printedPageLabels';
import type { DocumentCacheMetadata, PageLabels } from '../documentCache';
import { makeRemoteFilePath } from '../documentFileIdentity';

export type PageLabelNamespace = 'printed' | 'locator';

function nonEmpty(labels: PageLabels | null | undefined): PageLabels | null {
    if (!labels) return null;
    const out: PageLabels = {};
    for (const [index, label] of Object.entries(labels)) {
        if (typeof label === 'string' && label.trim() !== '') out[index] = label;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/** Printed labels from a cache record. */
export function printedPageLabelsFromMetadata(
    record: DocumentCacheMetadata | null | undefined,
): PageLabels | null {
    if (!record) return null;
    const resolved = resolvePrintedPageLabels({
        pageCount: record.pageCount,
        derived: record.derivedPageLabels,
        embedded: record.pageLabels,
    });
    return nonEmpty(Object.fromEntries(
        Object.entries(resolved).map(([index, label]) => [String(index), label]),
    ));
}

/** Zotero locator labels from a cache record: the labels the PDF declares. */
export function zoteroLocatorPageLabelsFromMetadata(
    record: DocumentCacheMetadata | null | undefined,
): PageLabels | null {
    return nonEmpty(record?.pageLabels);
}

/** Labels of one namespace from a cache record. */
export function pageLabelsFromMetadata(
    record: DocumentCacheMetadata | null | undefined,
    namespace: PageLabelNamespace,
): PageLabels | null {
    return namespace === 'printed'
        ? printedPageLabelsFromMetadata(record)
        : zoteroLocatorPageLabelsFromMetadata(record);
}

/**
 * Labels of one namespace for a cache record, read from `filePath`. Records
 * written before derived labels were cached do not know their printed labels;
 * they are recovered from the cached structured payload, which also backfills
 * the record. Cache only; never extracts.
 */
export async function loadPageLabelsForMetadata(
    record: DocumentCacheMetadata | null | undefined,
    namespace: PageLabelNamespace,
    filePath: string,
): Promise<PageLabels | null> {
    if (!record || namespace === 'locator' || record.derivedPageLabels !== undefined) {
        return pageLabelsFromMetadata(record, namespace);
    }
    if (record.contentKind !== 'pdf') return null;
    const serialized = await Zotero.Beaver?.documentCache?.getSerializedResult(
        { libraryId: record.libraryId, zoteroKey: record.zoteroKey },
        'structured',
        filePath,
    ).catch(() => null);
    const derivedPageLabels = serialized?.metadata.derivedPageLabels;
    return printedPageLabelsFromMetadata(
        derivedPageLabels === undefined ? record : { ...record, derivedPageLabels },
    );
}

/**
 * Cached metadata of a PDF attachment: its local file, or the remote key of
 * a sync-backed attachment without a local copy. Cache only; never extracts.
 */
async function cachedMetadataForAttachment(
    attachment: Zotero.Item,
    filePath?: string | null,
): Promise<DocumentCacheMetadata | null> {
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return null;
    const path = filePath || (await attachment.getFilePathAsync()) || makeRemoteFilePath(attachment);
    return cache.getMetadata({ libraryId: attachment.libraryID, zoteroKey: attachment.key }, path)
        .catch(() => null);
}

/** Printed labels of an attachment, from the document cache. */
export async function getPrintedPageLabels(
    attachment: Zotero.Item,
    filePath?: string | null,
): Promise<PageLabels | null> {
    const path = filePath || (await attachment.getFilePathAsync()) || makeRemoteFilePath(attachment);
    return loadPageLabelsForMetadata(await cachedMetadataForAttachment(attachment, path), 'printed', path);
}

/** Zotero locator labels of an attachment, from the document cache. */
export async function getZoteroLocatorPageLabels(
    attachment: Zotero.Item,
    filePath?: string | null,
): Promise<PageLabels | null> {
    return zoteroLocatorPageLabelsFromMetadata(await cachedMetadataForAttachment(attachment, filePath));
}
