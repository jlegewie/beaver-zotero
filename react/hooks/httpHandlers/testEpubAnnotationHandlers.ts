/**
 * Dev-only HTTP handler for EPUB annotation CFI/sortIndex parity verification.
 * Wired to `/beaver/test/epub-annotation-parity` in `useHttpEndpoints.ts`.
 *
 * For each requested target, it computes the annotation position two ways and
 * compares them:
 *   - Reader: resolve the live DOM range via `resolveEpubCitationRange` and call
 *     the reader's own `getAnnotationFromRange` (the exact path used when a user
 *     highlights text), yielding the reader's `{position.value, sortIndex}`.
 *   - Headless: `resolveEpubAnnotationTarget` parses the EPUB without the reader.
 *
 * String equality of both fields is the gate for the headless EPUB annotation
 * feature: the headless CFI must resolve identically to what the reader stores.
 */

import { resolveEpubAnnotationTarget } from '../../../src/services/annotations/epub/epubAnnotationResolver';
import { resolveEpubCitationRange } from '../../utils/epubVisualizer/epubRangeResolver';
import {
    annotationFromRange,
    getSectionCount,
    type EpubPrimaryView,
} from '../../utils/epubVisualizer/epubReaderView';
import {
    getCurrentReaderAndWaitForView,
    waitForReaderForItem,
} from '../../utils/readerUtils';

async function openReaderForAttachment(item: Zotero.Item): Promise<any | undefined> {
    const current = await getCurrentReaderAndWaitForView(undefined, false);
    if (current?.itemID === item.id) return current;
    const opened = await Zotero.Reader.open(item.id);
    return waitForReaderForItem(item.id, opened);
}

async function waitForSectionRenderers(
    primaryView: EpubPrimaryView,
    timeoutMs = 2000,
): Promise<void> {
    const start = Date.now();
    while (getSectionCount(primaryView) === 0 && Date.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

interface ParityTargetInput {
    section_href?: string;
    section_ordinal?: number;
    anchor_id?: string;
    text?: string;
}

export async function handleTestEpubAnnotationParityHttpRequest(request: any): Promise<any> {
    const { library_id, zotero_key, items } = request || {};
    if (library_id == null || zotero_key == null || !Array.isArray(items)) {
        return { ok: false, error: 'Provide library_id, zotero_key, items[]' };
    }

    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { ok: false, error: 'not_found' };
    const filePath = await item.getFilePathAsync();
    if (!filePath) return { ok: false, error: 'no_file' };

    const reader = await openReaderForAttachment(item);
    if (!reader) return { ok: false, error: 'no_reader' };
    if (reader.type !== 'epub') return { ok: false, error: 'not_an_epub_reader' };
    const primaryView = reader._internalReader?._primaryView as EpubPrimaryView | undefined;
    if (!primaryView) return { ok: false, error: 'no_primary_view' };
    await waitForSectionRenderers(primaryView);

    const results: any[] = [];
    for (const raw of items as ParityTargetInput[]) {
        const target = {
            sectionHref: typeof raw.section_href === 'string' ? raw.section_href : undefined,
            sectionOrdinal: typeof raw.section_ordinal === 'number' ? raw.section_ordinal : undefined,
            anchorId: typeof raw.anchor_id === 'string' ? raw.anchor_id : undefined,
            text: typeof raw.text === 'string' ? raw.text : undefined,
        };

        // Reader side: live range -> reader's own getAnnotationFromRange.
        let readerCfi: string | null = null;
        let readerSortIndex: string | null = null;
        let readerText: string | null = null;
        const resolved = resolveEpubCitationRange(primaryView, target);
        if (resolved?.range) {
            readerText = resolved.range.toString();
            const annotation = annotationFromRange(primaryView, resolved.range, 'highlight', '#ffd400');
            if (annotation) {
                const position = annotation.position as any;
                readerCfi = position?.value ?? JSON.stringify(position);
                readerSortIndex = annotation.sortIndex ?? null;
            }
        }

        // Headless side.
        const headless = await resolveEpubAnnotationTarget(filePath, target);
        const headlessOk = !('error' in headless);

        // The reader stores '' for the page label unless the EPUB has confident
        // physical paging (epub-view.ts: isPhysical && getPageLabel || '').
        let readerPageLabel: string | null = null;
        if (resolved?.range) {
            const annotation = annotationFromRange(primaryView, resolved.range, 'highlight', '#ffd400');
            readerPageLabel = (annotation as any)?.pageLabel ?? '';
        }

        results.push({
            target: raw,
            reader: { cfi: readerCfi, sort_index: readerSortIndex, text: readerText, page_label: readerPageLabel },
            headless: headlessOk
                ? { cfi: headless.position.value, sort_index: headless.sortIndex, text: headless.text, page_label: headless.pageLabel }
                : { error: headless.error, message: (headless as any).message },
            cfi_match: readerCfi != null && headlessOk ? readerCfi === headless.position.value : null,
            sort_index_match: readerSortIndex != null && headlessOk ? readerSortIndex === headless.sortIndex : null,
            page_label_match: readerPageLabel != null && headlessOk ? readerPageLabel === headless.pageLabel : null,
        });
    }

    return { ok: true, results };
}
