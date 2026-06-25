import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getReadableContentKind } from '../../../../src/services/documentExtraction/attachmentResolution';
import { ZoteroIcon, ZOTERO_ICONS } from '../../../components/icons/ZoteroIcon';
import { AlertIcon, Icon } from '../../../components/icons/icons';
import { navigateToAnnotation, navigateToPage } from '../../../utils/readerUtils';
import { flashHighlightBoundingBoxes } from '../../../utils/citationNavigation';
import { formatLocationChip } from '../../../utils/locationDisplay';
import { resolveEpubAnnotationTarget } from '../../../../src/services/annotations/epub/epubAnnotationResolver';
import { BeaverTemporaryAnnotations } from '../../../utils/annotationUtils';
import { logger } from '../../../../src/utils/logger';
import { BEAVER_ANNOTATION_COLORS } from '../../../../src/constants/annotations';
import { TagPill } from '../../../components/agentRuns/TagPill';
import { AnnotationTooltip, getAnnotationTooltipIcon } from '../../../components/agentRuns/AnnotationTooltip';
import type {
    CreateHighlightAnnotationsProposedData,
    CreateHighlightAnnotationsResultData,
    CreateNoteAnnotationsProposedData,
    CreateNoteAnnotationsResultData,
    CreatedAnnotationResult,
    FailedAnnotationResult,
    HighlightAnnotationItem,
    NoteAnnotationItem,
} from '../../../types/agentActions/createAnnotations';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface CreateAnnotationsPreviewProps {
    kind: 'highlight' | 'note';
    actionData: Partial<CreateHighlightAnnotationsProposedData & CreateNoteAnnotationsProposedData>;
    currentValue?: {
        attachment_title?: string;
        library_name?: string;
        resolution_differs?: boolean;
        needs_extraction?: boolean;
    };
    resultData?: Partial<CreateHighlightAnnotationsResultData & CreateNoteAnnotationsResultData>;
    status: ActionStatus;
    isStreaming?: boolean;
}

const COLOR_VALUES = BEAVER_ANNOTATION_COLORS;

function pageIndexForItem(kind: 'highlight' | 'note', item: HighlightAnnotationItem | NoteAnnotationItem): number | null {
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

/**
 * Resolve the page label to display for an item: a highlight's first page
 * location carries its own label, a note carries it at the item level. Blank
 * labels are treated as absent so the caller falls back to the page number.
 */
function pageLabelForItem(
    kind: 'highlight' | 'note',
    item: HighlightAnnotationItem | NoteAnnotationItem,
    isEpub: boolean,
): string | null {
    const raw = item as any;
    const nonBlank = (value: unknown): string | null =>
        typeof value === 'string' && value.trim() !== '' ? value : null;

    if (isEpub) {
        return nonBlank(raw.page_label ?? raw.pageLabel);
    }

    if (kind !== 'highlight') {
        return nonBlank(raw.page_label ?? raw.pageLabel);
    }

    const locations = raw.page_locations ?? raw.pageLocations ?? raw.locations;
    const firstLocLabel = nonBlank(locations?.[0]?.page_label ?? locations?.[0]?.pageLabel);
    if (firstLocLabel) return firstLocLabel;

    // Single-page highlights may carry only an item-level label; the create
    // executors use it as a fallback for single-location items, so mirror that
    // here to keep the preview chip in sync with the saved annotation label.
    if (locations?.length === 1) {
        return nonBlank(raw.page_label ?? raw.pageLabel);
    }
    return null;
}

function statusForItem(
    item: HighlightAnnotationItem | NoteAnnotationItem,
    createdByClient: Map<string, CreatedAnnotationResult[]>,
    failedByClient: Map<string, FailedAnnotationResult[]>,
): 'created' | 'failed' | 'partial' | 'pending' {
    const clientItemId = (item as any).client_item_id ?? (item as any).clientItemId ?? '';
    const createdCount = createdByClient.get(clientItemId)?.length ?? 0;
    const failedCount = failedByClient.get(clientItemId)?.length ?? 0;
    if (createdCount > 0 && failedCount > 0) return 'partial';
    if (createdCount > 0) return 'created';
    if (failedCount > 0) return 'failed';
    return 'pending';
}

function formatAnnotationFailureMessage(
    failure: FailedAnnotationResult,
    noun: 'highlight' | 'note',
): string {
    switch (failure.error_code) {
        case 'page_extraction_failed':
            return 'Could not create annotation because the PDF could not be processed.';
        case 'page_geometry_unavailable':
            return 'Could not create annotation because the target position was not found in the PDF.';
        case 'epub_section_not_found':
            return 'Could not create annotation because the cited section was not found in the EPUB.';
        case 'epub_text_not_found':
            return 'Could not create annotation because the cited passage was not found in the EPUB.';
        case 'epub_math_section_unsupported':
            return 'Could not create annotation because the passage follows a math equation, which is not yet supported.';
        case 'attachment_file_unavailable':
            return 'Could not create annotation because the attachment file is not available locally.';
        case 'apply_failed':
            return `Failed to create ${noun}.`;
        default:
            return `Failed to create ${noun}.`;
    }
}

function formatAnnotationFailureMessages(
    failures: FailedAnnotationResult[],
    noun: 'highlight' | 'note',
): string {
    return Array.from(new Set(
        failures.map((failure) => formatAnnotationFailureMessage(failure, noun)),
    )).join('\n');
}

function getHighlightLocations(item: HighlightAnnotationItem | NoteAnnotationItem): any[] {
    const raw = item as any;
    const locations = raw.page_locations ?? raw.pageLocations ?? raw.locations;
    return Array.isArray(locations) ? locations : [];
}

/**
 * Preview for bulk highlight and note annotation actions.
 */
export const CreateAnnotationsPreview: React.FC<CreateAnnotationsPreviewProps> = ({
    kind,
    actionData,
    resultData,
    status,
    isStreaming,
}) => {
    const previewRootRef = useRef<HTMLDivElement | null>(null);
    const items = Array.isArray(actionData.items)
        ? actionData.items as Array<HighlightAnnotationItem | NoteAnnotationItem>
        : [];
    // Call-level tags applied to every created annotation (shared across the batch).
    const tags = Array.isArray(actionData.tags)
        ? actionData.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
        : [];
    const created = Array.isArray(resultData?.created) ? resultData.created : [];
    const failed = Array.isArray(resultData?.failed) ? resultData.failed as FailedAnnotationResult[] : [];
    const createdByClient = new Map<string, CreatedAnnotationResult[]>();
    const failedByClient = new Map<string, FailedAnnotationResult[]>();

    for (const entry of created) {
        const list = createdByClient.get(entry.client_item_id) ?? [];
        list.push(entry);
        createdByClient.set(entry.client_item_id, list);
    }
    for (const entry of failed) {
        const list = failedByClient.get(entry.client_item_id) ?? [];
        list.push(entry);
        failedByClient.set(entry.client_item_id, list);
    }

    const resolvedRef = actionData.resolved_ref;
    const noun = kind === 'highlight' ? 'highlight' : 'note';

    // Resolve the attachment's content kind once
    const [contentKind, setContentKind] = useState<'pdf' | 'epub' | null>(null);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!resolvedRef?.zotero_key || typeof resolvedRef.library_id !== 'number') return;
            try {
                const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
                    resolvedRef.library_id,
                    resolvedRef.zotero_key,
                );
                const resolved = attachment ? getReadableContentKind(attachment as Zotero.Item) : null;
                if (!cancelled) setContentKind(resolved === 'pdf' || resolved === 'epub' ? resolved : null);
            } catch (error) {
                logger(`CreateAnnotationsPreview: content-kind resolution failed: ${error}`, 1);
            }
        })();
        return () => { cancelled = true; };
    }, [resolvedRef?.library_id, resolvedRef?.zotero_key]);
    const isEpub = contentKind === 'epub';

    const handleItemClick = useCallback(async (
        item: HighlightAnnotationItem | NoteAnnotationItem,
        createdEntries: CreatedAnnotationResult[],
    ) => {
        try {
            await BeaverTemporaryAnnotations.cleanupAll();

            const firstCreated = createdEntries[0];
            if (firstCreated) {
                const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
                    firstCreated.library_id,
                    firstCreated.zotero_key,
                );
                if (annotationItem) {
                    await navigateToAnnotation(annotationItem as Zotero.Item);
                    return;
                }
            }

            if (!resolvedRef?.zotero_key || typeof resolvedRef.library_id !== 'number') return;

            // Determine the navigation path from the attachment's actual content
            // kind.
            const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
                resolvedRef.library_id,
                resolvedRef.zotero_key,
            );
            if (!attachment) return;
            const attachmentKind = getReadableContentKind(attachment as Zotero.Item);

            // Pending preview: compute the epubcfi headlessly and open the reader
            // WITH that location, so Zotero navigates atomically once the view is
            // ready.
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

                let located = false;
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
                        await Zotero.Reader.open(attachmentId, location as any);
                        located = true;
                    }
                }
                if (!located) {
                    // Fall back to the section start when the passage can't be resolved.
                    await Zotero.Reader.open(attachmentId, sectionHref ? { href: sectionHref } as any : undefined);
                }
                return;
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
        } catch (error) {
            logger(`CreateAnnotationsPreview: navigation failed: ${error}`, 1);
        }
    }, [kind, resolvedRef?.library_id, resolvedRef?.zotero_key]);

    return (
        <div ref={previewRootRef} className="create-annotations-preview overflow-hidden">
            <div className="display-flex flex-col px-3 py-2 gap-4">

                <div className="display-flex flex-col gap-1">
                    {items.map((item) => {
                        const rawItem = item as any;
                        const clientItemId = rawItem.client_item_id ?? rawItem.clientItemId ?? '';
                        const itemStatus = statusForItem(item, createdByClient, failedByClient);
                        const failures = failedByClient.get(clientItemId) ?? [];
                        const createdEntries = createdByClient.get(clientItemId) ?? [];
                        const text = kind === 'highlight'
                            ? (rawItem.text ?? '')
                            : (rawItem.comment ?? '');
                        const color = rawItem.color;
                        const isFailed = itemStatus === 'failed';
                        const isPartial = itemStatus === 'partial';
                        const isCreated = itemStatus === 'created' || itemStatus === 'partial';
                        const failureMessage = formatAnnotationFailureMessages(failures, noun);
                        const pageIndex = pageIndexForItem(kind, item);
                        const pageNumber = typeof pageIndex === 'number' ? pageIndex + 1 : null;
                        const pageLabel = pageLabelForItem(kind, item, isEpub);
                        const fallbackLabel = isEpub
                            ? pageLabel
                            : pageLabel ?? (pageNumber !== null ? String(pageNumber) : null);
                        // Route through the shared chip formatter
                        const pageDisplay = formatLocationChip(isEpub ? 'epub' : 'pdf', fallbackLabel)
                            ? fallbackLabel
                            : null;

                        const kindLabel = kind === 'highlight' ? 'Highlight Annotation' : 'Sticky Note';
                        const tooltipContent = text || rawItem.title || '';
                        const surface = isEpub ? 'reader' : 'PDF';
                        // Only a pending highlight previews (the reader flashes its
                        // cited extent). Notes have no flashable extent and applied
                        // items navigate to the saved annotation, so both say "view".
                        let footerLabel = isFailed
                            ? failureMessage || `Failed to create ${noun}`
                            : (kind === 'highlight' && !isCreated)
                                ? `Click to preview in ${surface}`
                                : `Click to view in ${surface}`;
                        if (kind === 'note' && !isCreated) footerLabel = `Click to view page in ${surface}`
                        const footerClass = isFailed ? 'font-color-red' : 'font-color-tertiary';

                        const isDimmed = status === 'rejected' || status === 'undone';
                        const row = (
                            <div
                                className={`create-annotations-preview-row display-flex flex-row items-start gap-2 py-15 cursor-pointer ${isDimmed ? 'opacity-60' : ''}`}
                                onClick={() => handleItemClick(item, createdEntries)}
                            >
                                {isFailed ? (
                                    <Icon icon={AlertIcon} size={14} className="font-color-red" style={{ marginTop: 2 }} />
                                ) : (
                                    <ZoteroIcon
                                        icon={kind === 'highlight' ? ZOTERO_ICONS.ANNOTATE_HIGHLIGHT : ZOTERO_ICONS.ANNOTATION}
                                        size={14}
                                        color={COLOR_VALUES[color] ?? COLOR_VALUES.yellow}
                                        style={{ marginTop: 2 }}
                                    />
                                )}

                                <div className="display-flex flex-row min-w-0 flex-1 justify-between gap-3">
                                    <div className={`truncate ${isFailed ? 'font-color-red' : ''}`}>
                                        {rawItem.title || text || `${noun} annotation`}
                                    </div>
                                    {(isFailed || isPartial || pageDisplay !== null) && (
                                        <div className='font-color-tertiary whitespace-nowrap'>
                                            {pageDisplay !== null ? `Page ${pageDisplay}` : ''}
                                        </div>
                                    )}
                                </div>

                            </div>
                        );

                        return (
                            <AnnotationTooltip
                                key={`${clientItemId}-${rawItem.index}`}
                                typeLabel={kindLabel}
                                pageDisplay={pageDisplay}
                                body={tooltipContent}
                                footerLabel={footerLabel}
                                footerClassName={footerClass}
                                typeIcon={getAnnotationTooltipIcon(kind === 'highlight' ? 'highlight' : 'note')}
                                stayOpenOnAnchorClick
                            >
                                {row}
                            </AnnotationTooltip>
                        );
                    })}
                </div>

                {tags.length > 0 && (
                    <div className="display-flex flex-row items-center gap-2 flex-wrap">
                        <span className="font-color-primary shrink-0 mb-1">
                            {tags.length > 1 ? `${tags.length} Tags` : `${tags.length} Tag`}
                        </span>
                        {tags.map((tag, index) => (
                            <TagPill key={`${tag}-${index}`} name={tag} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default CreateAnnotationsPreview;
