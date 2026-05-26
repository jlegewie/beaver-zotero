import React, { useCallback, useRef } from 'react';
import Tooltip from '../ui/Tooltip';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { AlertIcon, Icon } from '../icons/icons';
import { navigateToAnnotation, navigateToPage } from '../../utils/readerUtils';
import { BeaverTemporaryAnnotations, createBoundingBoxHighlights } from '../../utils/annotationUtils';
import { logger } from '../../../src/utils/logger';
import type {
    CreateHighlightAnnotationsProposedData,
    CreateHighlightAnnotationsResultData,
    CreateNoteAnnotationsProposedData,
    CreateNoteAnnotationsResultData,
    CreatedAnnotation,
    FailedAnnotation,
    HighlightAnnotationItem,
    NoteAnnotationItem,
} from '../../types/agentActions/createAnnotations';

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

const COLOR_VALUES: Record<string, string> = {
    red: '#ff6666',
    orange: '#ff9f43',
    yellow: '#ffd400',
    green: '#90ee90',
    blue: '#5ac8fa',
    purple: '#d4a5ff',
    gray: '#838383',
    pink: '#ff66c4',
    brown: '#e6a86e',
    cyan: '#7fdbff',
    lime: '#b4ff69',
    mint: '#b2f7d3',
    coral: '#ff9999',
    navy: '#6495ed',
    olive: '#e6e68a',
    teal: '#7fffd4',
};

let cleanupPreviewClickListeners: Array<() => void> = [];

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

function statusForItem(
    item: HighlightAnnotationItem | NoteAnnotationItem,
    createdByClient: Map<string, CreatedAnnotation[]>,
    failedByClient: Map<string, FailedAnnotation[]>,
): 'created' | 'failed' | 'partial' | 'pending' {
    const clientItemId = (item as any).client_item_id ?? (item as any).clientItemId ?? '';
    const createdCount = createdByClient.get(clientItemId)?.length ?? 0;
    const failedCount = failedByClient.get(clientItemId)?.length ?? 0;
    if (createdCount > 0 && failedCount > 0) return 'partial';
    if (createdCount > 0) return 'created';
    if (failedCount > 0) return 'failed';
    return 'pending';
}

function getHighlightLocations(item: HighlightAnnotationItem | NoteAnnotationItem): any[] {
    const raw = item as any;
    const locations = raw.page_locations ?? raw.pageLocations ?? raw.locations;
    return Array.isArray(locations) ? locations : [];
}

function colorWithPreviewAlpha(colorName: string | undefined): string {
    const hex = COLOR_VALUES[colorName || 'yellow'] ?? COLOR_VALUES.yellow;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0.45)`;
}

function clearPreviewClickListeners(): void {
    for (const cleanup of cleanupPreviewClickListeners) {
        cleanup();
    }
    cleanupPreviewClickListeners = [];
}

function installPreviewDismissOnNextClick(reader: any, ownerDocument?: Document, ignoredClickRoot?: Element | null): void {
    clearPreviewClickListeners();

    const documents = [
        ownerDocument,
        Zotero.getMainWindow()?.document,
        reader?._iframeWindow?.document,
        reader?._internalReader?._primaryView?._iframeWindow?.document,
    ].filter(Boolean) as Document[];
    const seenDocuments = new Set<Document>();

    setTimeout(() => {
        for (const doc of documents) {
            if (seenDocuments.has(doc)) continue;
            seenDocuments.add(doc);

            const dismiss = (event: PointerEvent) => {
                const target = event.target;
                const targetNode = target && typeof (target as Node).nodeType === 'number'
                    ? target as Node
                    : null;
                if (ignoredClickRoot && targetNode && ignoredClickRoot.contains(targetNode)) {
                    return;
                }
                clearPreviewClickListeners();
                BeaverTemporaryAnnotations.cleanupAll(reader).catch(error => {
                    logger(`CreateAnnotationsPreview: failed to clean up preview annotation: ${error}`, 1);
                });
            };
            doc.addEventListener('pointerdown', dismiss, { capture: true });
            cleanupPreviewClickListeners.push(() => {
                doc.removeEventListener('pointerdown', dismiss, true);
            });
        }
    }, 0);
}

/**
 * Preview for bulk PDF highlight and note annotation actions.
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
    const created = Array.isArray(resultData?.created) ? resultData.created : [];
    const failed = Array.isArray(resultData?.failed) ? resultData.failed as FailedAnnotation[] : [];
    const createdByClient = new Map<string, CreatedAnnotation[]>();
    const failedByClient = new Map<string, FailedAnnotation[]>();

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

    const handleItemClick = useCallback(async (
        item: HighlightAnnotationItem | NoteAnnotationItem,
        createdEntries: CreatedAnnotation[],
        ownerDocument?: Document,
    ) => {
        try {
            await BeaverTemporaryAnnotations.cleanupAll();
            clearPreviewClickListeners();

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
            const pageIndex = pageIndexForItem(kind, item);
            const pdfItem = await Zotero.Items.getByLibraryAndKeyAsync(
                resolvedRef.library_id,
                resolvedRef.zotero_key,
            );
            if (!pdfItem) return;
            const page = typeof pageIndex === 'number' ? pageIndex + 1 : 1;
            const reader = await navigateToPage((pdfItem as Zotero.Item).id, page) as any;

            const canCreatePreview = status === 'pending'
                || status === 'awaiting'
                || status === 'rejected'
                || status === 'undone';
            if (kind === 'highlight' && canCreatePreview) {
                const rawItem = item as any;
                const locations = getHighlightLocations(item)
                    .map((loc: any) => {
                        const rawPageIndex = loc.page_idx ?? loc.pageIndex ?? loc.page_index;
                        const pageIndex = rawPageIndex !== undefined && rawPageIndex !== null
                            ? Number(rawPageIndex)
                            : Number(loc.page ?? 1) - 1;
                        return {
                            pageIndex,
                            boxes: loc.boxes ?? loc.boundingBoxes ?? loc.bboxes ?? loc.rects ?? [],
                        };
                    })
                    .filter((loc: any) => loc.pageIndex >= 0 && loc.boxes.length > 0);

                const annotationReferences = await createBoundingBoxHighlights(
                    locations,
                    rawItem.text ?? rawItem.title ?? '',
                    rawItem.title ?? rawItem.text ?? 'Beaver annotation preview',
                    { color: colorWithPreviewAlpha(rawItem.color) },
                );

                if (annotationReferences.length > 0) {
                    BeaverTemporaryAnnotations.addToTracking(annotationReferences);
                    installPreviewDismissOnNextClick(reader, ownerDocument, previewRootRef.current);
                    setTimeout(() => {
                        reader?.navigate?.({ annotationID: annotationReferences[0].zotero_key });
                    }, 100);
                }
            }
        } catch (error) {
            logger(`CreateAnnotationsPreview: navigation failed: ${error}`, 1);
        }
    }, [kind, resolvedRef?.library_id, resolvedRef?.zotero_key, status]);

    return (
        <div ref={previewRootRef} className={`create-annotations-preview overflow-hidden ${status === 'rejected' || status === 'undone' ? 'opacity-60' : ''}`}>
            <div className="display-flex flex-col px-3 py-2 gap-2">

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
                        const color = kind === 'highlight' ? rawItem.color : 'yellow';
                        const isFailed = itemStatus === 'failed';
                        const isPartial = itemStatus === 'partial';
                        const failureMessage = failures
                            .map((failure) => failure.error_code ? `${failure.error_code}: ${failure.error}` : failure.error)
                            .join('\n');
                        const pageIndex = pageIndexForItem(kind, item);
                        const pageNumber = typeof pageIndex === 'number' ? pageIndex + 1 : null;

                        const row = (
                            <div
                                key={`${clientItemId}-${rawItem.index}`}
                                className="create-annotations-preview-row display-flex flex-row items-start gap-2 py-15 cursor-pointer"
                                onClick={(event) => handleItemClick(item, createdEntries, event.currentTarget.ownerDocument)}
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
                                    {(isFailed || isPartial || pageNumber !== null) && (
                                        <div className='font-color-tertiary whitespace-nowrap'>
                                            {`Page ${pageNumber}`}
                                        </div>
                                    )}
                                </div>

                            </div>
                        );

                        if ((isFailed || isPartial) && failureMessage) {
                            return (
                                <Tooltip key={`${clientItemId}-${rawItem.index}`} content={failureMessage} showArrow>
                                    {row}
                                </Tooltip>
                            );
                        }
                        return row;
                    })}
                </div>
            </div>
        </div>
    );
};

export default CreateAnnotationsPreview;
