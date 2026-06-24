/**
 * Dev-only HTTP handlers for reader-state and EPUB citation-navigation
 * verification. Wired to their paths in `useHttpEndpoints.ts`.
 *
 * `/beaver/test/reader-state` opens (or reuses) a reader tab and reports the
 * same position fields `getReaderState` derives for `application_state`:
 * `current_page` (PDF page, or EPUB page coordinate) and `content_kind` from
 * `reader.type`.
 *
 * `/beaver/test/epub-citation-navigate` drives the EPUB citation-click path
 * against the live reader: either the full `navigateToEpubCitation` flow
 * (temporary-annotation highlight included) or a resolve-only probe that
 * reports the precise range `resolveEpubCitationRange` anchors.
 */

import {
    getCurrentPage,
    getCurrentReaderAndWaitForView,
    waitForReaderForItem,
} from '../../utils/readerUtils';
import { remapEpubSectionToPage } from '../../atoms/applicationState';
import { navigateToEpubCitation } from '../../utils/epubVisualizer/epubCitationNavigation';
import { resolveEpubCitationRange } from '../../utils/epubVisualizer/epubRangeResolver';
import {
    getSectionCount,
    type EpubPrimaryView,
} from '../../utils/epubVisualizer/epubReaderView';
import { BeaverTemporaryAnnotations } from '../../utils/annotationUtils';
import type { SymbolicLocation } from '../../types/citations';

const ELEMENT_NODE = 1;

/** Open the attachment's reader (or reuse the current tab) and wait for its view. */
async function openReaderForAttachment(item: Zotero.Item): Promise<any | undefined> {
    const current = await getCurrentReaderAndWaitForView(undefined, false);
    if (current?.itemID === item.id) return current;
    const opened = await Zotero.Reader.open(item.id);
    return waitForReaderForItem(item.id, opened);
}

/** A freshly opened EPUB reader can report a view before spine renderers exist. */
async function waitForSectionRenderers(
    primaryView: EpubPrimaryView,
    timeoutMs = 2000,
): Promise<void> {
    const start = Date.now();
    while (getSectionCount(primaryView) === 0 && Date.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

export async function handleTestReaderStateHttpRequest(request: any): Promise<any> {
    const { library_id, zotero_key } = request || {};

    let reader: any | undefined;
    if (library_id != null && zotero_key != null) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
        if (!item) return { ok: false, error: 'not_found' };
        if (!item.isAttachment()) return { ok: false, error: 'not_an_attachment' };
        reader = await openReaderForAttachment(item);
    } else {
        reader = await getCurrentReaderAndWaitForView(undefined, false);
    }
    if (!reader) return { ok: false, error: 'no_reader' };

    // Mirrors the `content_kind` derivation in `getReaderState`.
    const contentKind = reader.type === 'pdf' || reader.type === 'epub'
        ? reader.type
        : null;
    let sectionCount: number | null = null;
    let primaryView: EpubPrimaryView | undefined;
    if (reader.type === 'epub') {
        // A cold-opened EPUB reader can report its view before the spine
        // renderers exist, which would yield section_count 0 / null position.
        primaryView = reader._internalReader?._primaryView as EpubPrimaryView | undefined;
        if (primaryView) await waitForSectionRenderers(primaryView);
        sectionCount = primaryView ? getSectionCount(primaryView) : null;
    }

    // Match the EPUB page coordinate used by application state.
    let currentPage = getCurrentPage(reader) || null;
    if (reader.type === 'epub' && currentPage !== null && reader.itemID != null) {
        const attachmentItem = await Zotero.Items.getAsync(reader.itemID);
        if (attachmentItem) {
            currentPage = await remapEpubSectionToPage(attachmentItem, currentPage, primaryView);
        }
    }

    return {
        ok: true,
        reader_type: reader.type ?? null,
        current_page: currentPage,
        content_kind: contentKind,
        section_count: sectionCount,
    };
}

export async function handleTestEpubCitationNavigateHttpRequest(request: any): Promise<any> {
    const {
        library_id,
        zotero_key,
        section_href,
        section_ordinal,
        anchor_id,
        text,
        preview_text,
        mode,
        use_temporary_annotations,
        cleanup,
    } = request || {};
    if (library_id == null || zotero_key == null) {
        return { ok: false, error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { ok: false, error: 'not_found' };

    if (mode === 'navigate') {
        // Full citation-click flow, including the temporary-annotation flash.
        const symbolicLocation: SymbolicLocation | undefined =
            typeof section_href === 'string'
                ? { content_kind: 'epub', section_href, anchor_id, text }
                : undefined;
        const outcome = await navigateToEpubCitation({
            item,
            symbolicLocation,
            sectionOrdinal: typeof section_ordinal === 'number' ? section_ordinal : undefined,
            searchText: typeof text === 'string' ? text : undefined,
            previewText: typeof preview_text === 'string' ? preview_text : undefined,
            useTemporaryAnnotations: use_temporary_annotations !== false,
        });

        const reader = await getCurrentReaderAndWaitForView(undefined, false);
        const annotations: any[] =
            reader?._internalReader?._state?.annotations ?? [];
        const temporaryCount = annotations.filter((annotation) =>
            String(annotation?.id ?? '').startsWith('epub_citation'),
        ).length;

        if (cleanup !== false) {
            await BeaverTemporaryAnnotations.cleanupAll().catch(() => undefined);
        }
        return { ok: true, outcome, temporary_annotation_count: temporaryCount };
    }

    // Resolve-only probe: report the section + precise range the citation
    // locator anchors, without flashing anything.
    const reader = await openReaderForAttachment(item);
    if (!reader) return { ok: false, error: 'no_reader' };
    if (reader.type !== 'epub') return { ok: false, error: 'not_an_epub_reader' };
    const primaryView = reader._internalReader?._primaryView as EpubPrimaryView | undefined;
    if (!primaryView) return { ok: false, error: 'no_primary_view' };
    await waitForSectionRenderers(primaryView);

    const resolved = resolveEpubCitationRange(primaryView, {
        sectionHref: typeof section_href === 'string' ? section_href : undefined,
        sectionOrdinal: typeof section_ordinal === 'number' ? section_ordinal : undefined,
        anchorId: typeof anchor_id === 'string' ? anchor_id : undefined,
        text: typeof text === 'string' ? text : undefined,
    });
    if (!resolved) {
        return { ok: true, resolved: false, section_count: getSectionCount(primaryView) };
    }

    let rangeText: string | null = null;
    let rangeAnchorId: string | null = null;
    if (resolved.range) {
        rangeText = resolved.range.toString().replace(/\s+/g, ' ').trim();
        const startNode = resolved.range.startContainer;
        let element: Element | null = startNode.nodeType === ELEMENT_NODE
            ? (startNode as Element)
            : (startNode.parentElement ?? null);
        while (element && !element.getAttribute('id')) {
            element = element.parentElement;
        }
        rangeAnchorId = element?.getAttribute('id') ?? null;
    }

    return {
        ok: true,
        resolved: true,
        section_index: resolved.sectionIndex,
        has_range: Boolean(resolved.range),
        range_text: rangeText,
        range_anchor_id: rangeAnchorId,
        section_count: getSectionCount(primaryView),
    };
}
