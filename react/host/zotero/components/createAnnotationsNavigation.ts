import { openReader } from '../../../runtime/navigation';
import { getReadableContentKind } from '../../../../src/services/documentExtraction/attachmentResolution';
import { navigateToAnnotation, navigateToPage } from '../../../utils/readerUtils';
import { flashHighlightBoundingBoxes } from '../../../utils/citationNavigation';
import { resolveEpubAnnotationTarget } from '../../../../src/services/annotations/epub/epubAnnotationResolver';
import { BeaverTemporaryAnnotations } from '../../../utils/annotationUtils';
import { logger } from '@beaver/agent-core/platform/logger';
import { resolveLibraryRef } from '../../../../src/utils/libraryIdentity';
import { notifyReferenceUnavailable } from '../sourceActions';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type {
    CreatedAnnotationResult,
    HighlightAnnotationItem,
    NoteAnnotationItem,
} from '@beaver/agent-core/types/agentActions/createAnnotations';

export type CreateAnnotationKind = 'highlight' | 'note';
export type CreateAnnotationItem = HighlightAnnotationItem | NoteAnnotationItem;

/** Where opening a proposed annotation ended up. */
export type OpenAnnotationOutcome = 'opened' | 'library_unavailable' | 'missing';

/** 0-based PDF page of a proposed annotation, or null when it carries none. */
export function pageIndexForItem(kind: CreateAnnotationKind, item: CreateAnnotationItem): number | null {
    const raw = item as any;
    if (kind === 'highlight') {
        const firstLoc = raw.page_locations?.[0] ?? raw.pageLocations?.[0] ?? raw.locations?.[0];
        const idx = firstLoc?.page_idx ?? firstLoc?.pageIndex ?? firstLoc?.page_index;
        return typeof idx === 'number' ? idx : null;
    }
    const notePosition = raw.note_position ?? raw.notePosition;
    const idx = notePosition?.page_index ?? notePosition?.pageIndex;
    return typeof idx === 'number' ? idx : null;
}

export function getHighlightLocations(item: CreateAnnotationItem): any[] {
    const raw = item as any;
    const locations = raw.page_locations ?? raw.pageLocations ?? raw.locations;
    return Array.isArray(locations) ? locations : [];
}

/**
 * Open one proposed annotation in the reader: the saved annotation when it
 * still exists, otherwise the attachment at the annotation's location. A
 * highlight that was never saved flashes its cited extent on the page.
 */
export async function openCreateAnnotationTarget(
    kind: CreateAnnotationKind,
    resolvedRef: Partial<ZoteroItemReference> | undefined,
    item: CreateAnnotationItem,
    createdEntries: CreatedAnnotationResult[],
): Promise<OpenAnnotationOutcome> {
    try {
        await BeaverTemporaryAnnotations.cleanupAll();

        const firstCreated = createdEntries[0];
        const createdLibraryId = firstCreated
            ? resolveLibraryRef({
                library_ref: firstCreated.library_ref,
                library_id: firstCreated.library_id,
            })
            : null;
        if (firstCreated && createdLibraryId) {
            const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
                createdLibraryId,
                firstCreated.zotero_key,
            );
            if (annotationItem) {
                await navigateToAnnotation(annotationItem as Zotero.Item);
                return 'opened';
            }
        }

        // A group attachment's device-local library_id is UNRESOLVED_LIBRARY_ID
        // (0); its identity is the portable library_ref. Navigation from
        // persisted actions is not gated on library exclusion.
        const resolvedLibraryId = resolveLibraryRef({
            library_ref: resolvedRef?.library_ref,
            library_id: resolvedRef?.library_id,
        });
        if (!resolvedRef?.zotero_key) return 'missing';
        if (!resolvedLibraryId) return 'library_unavailable';

        const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
            resolvedLibraryId,
            resolvedRef.zotero_key,
        );
        if (!attachment) return 'missing';
        const attachmentKind = getReadableContentKind(attachment as Zotero.Item);

        // EPUB: compute the epubcfi headlessly and open the reader WITH that
        // location, so Zotero navigates atomically once the view is ready.
        if (attachmentKind === 'epub') {
            const rawItem = item as any;
            const attachmentId = (attachment as Zotero.Item).id;
            const sectionHref = rawItem.section_href ?? rawItem.sectionHref ?? undefined;
            const anchorId = rawItem.anchor_id ?? rawItem.anchorId ?? undefined;
            const text = rawItem.text || undefined;
            const explicitSectionOrdinal = rawItem.section_ordinal ?? rawItem.sectionOrdinal;
            const rawPageLabel = rawItem.page_label ?? rawItem.pageLabel;
            const sectionOrdinal = typeof explicitSectionOrdinal === 'number'
                ? explicitSectionOrdinal
                : typeof rawPageLabel === 'string' && /^\d+$/.test(rawPageLabel)
                ? Number(rawPageLabel)
                : undefined;

            const filePath = await (attachment as Zotero.Item).getFilePathAsync();
            if (filePath && text) {
                const resolved = await resolveEpubAnnotationTarget(
                    filePath,
                    { sectionHref, sectionOrdinal, anchorId, text, anchorToBlock: kind === 'note' },
                );
                if (!('error' in resolved)) {
                    const location = kind === 'highlight'
                        ? { position: resolved.position }
                        : { pageNumber: resolved.position.value };
                    await openReader(attachmentId, location as any);
                    return 'opened';
                }
            }
            // Fall back to the section start when the passage can't be resolved.
            await openReader(attachmentId, sectionHref ? { href: sectionHref } as any : undefined);
            return 'opened';
        }

        // PDF: scroll to the page, then flash the cited boxes for highlights.
        const pageIndex = pageIndexForItem(kind, item);
        const page = typeof pageIndex === 'number' ? pageIndex + 1 : 1;
        const reader = await navigateToPage((attachment as Zotero.Item).id, page) as any;
        if (reader && kind === 'highlight') {
            const locations = getHighlightLocations(item)
                .map((loc: any) => {
                    const rawPageIndex = loc.page_idx ?? loc.pageIndex ?? loc.page_index;
                    const locPageIndex = rawPageIndex !== undefined && rawPageIndex !== null
                        ? Number(rawPageIndex)
                        : Number(loc.page ?? 1) - 1;
                    return {
                        pageIndex: locPageIndex,
                        boxes: loc.boxes ?? loc.boundingBoxes ?? loc.bboxes ?? loc.rects ?? [],
                    };
                })
                .filter((loc: any) => loc.pageIndex >= 0 && loc.boxes.length > 0);
            if (locations.length > 0) {
                await flashHighlightBoundingBoxes(reader, locations);
            }
        }
        return 'opened';
    } catch (error) {
        logger(`openCreateAnnotationTarget: navigation failed: ${error}`, 1);
        return 'missing';
    }
}

/** The data a create-annotations card or row opens from. */
export interface CreateAnnotationsOpenSource {
    kind: CreateAnnotationKind;
    resolvedRef?: Partial<ZoteroItemReference>;
    items: CreateAnnotationItem[];
    created: CreatedAnnotationResult[];
}

/**
 * The open target for a whole create-annotations action, or null when it has
 * nothing to open: the first annotation that was saved, else the first
 * proposed one.
 */
export function getCreateAnnotationsOpenSource(
    kind: CreateAnnotationKind,
    proposedData: Record<string, any> | undefined,
    resultData: Record<string, any> | undefined,
): CreateAnnotationsOpenSource | null {
    const items: CreateAnnotationItem[] = Array.isArray(proposedData?.items) ? proposedData!.items : [];
    const created: CreatedAnnotationResult[] = Array.isArray(resultData?.created) ? resultData!.created : [];
    const resolvedRef = (resultData?.resolved_ref ?? proposedData?.resolved_ref) as Partial<ZoteroItemReference> | undefined;
    if (items.length === 0 && created.length === 0) return null;
    if (!resolvedRef?.zotero_key && created.length === 0) return null;
    return { kind, resolvedRef, items, created };
}

/** Open the target chosen by `getCreateAnnotationsOpenSource`. */
export async function openCreateAnnotationsSource(source: CreateAnnotationsOpenSource): Promise<OpenAnnotationOutcome> {
    const { kind, resolvedRef, items, created } = source;
    const createdFor = (item: CreateAnnotationItem) =>
        created.filter((entry) => entry.client_item_id === item.client_item_id);
    const item = items.find((candidate) => createdFor(candidate).length > 0) ?? items[0];
    if (!item) {
        // A result without its proposal still names the saved annotations.
        return openCreateAnnotationTarget(kind, resolvedRef, {} as CreateAnnotationItem, created.slice(0, 1));
    }
    return openCreateAnnotationTarget(kind, resolvedRef, item, createdFor(item));
}

/**
 * The open link (↗) of a create-annotations card or review row, or null when
 * it has nothing to open. Saved annotations open in the reader; before they
 * exist, or once undone, the link opens the attachment where they appear.
 */
export function getCreateAnnotationsOpenLink(
    kind: CreateAnnotationKind,
    proposedData: Record<string, any> | undefined,
    resultData: Record<string, any> | undefined,
    isApplied: boolean,
): { tooltip: string; onClick: () => Promise<void> } | null {
    const source = getCreateAnnotationsOpenSource(kind, proposedData, resultData);
    if (!source) return null;
    const opensAnnotation = isApplied && source.created.length > 0;
    return {
        tooltip: opensAnnotation ? 'Open annotation' : 'Open in reader',
        onClick: async () => {
            const outcome = await openCreateAnnotationsSource(source);
            if (outcome !== 'opened') notifyReferenceUnavailable(opensAnnotation ? 'annotation' : 'item', outcome);
        },
    };
}
