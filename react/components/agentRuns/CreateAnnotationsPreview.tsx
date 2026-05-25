import React, { useCallback } from 'react';
import Tooltip from '../ui/Tooltip';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { navigateToAnnotation, navigateToPage } from '../../utils/readerUtils';
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
    gray: '#d3d3d3',
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
    ) => {
        try {
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
            await navigateToPage((pdfItem as Zotero.Item).id, page);
        } catch (error) {
            logger(`CreateAnnotationsPreview: navigation failed: ${error}`, 1);
        }
    }, [kind, resolvedRef?.library_id, resolvedRef?.zotero_key]);

    return (
        <div className={`create-annotations-preview overflow-hidden ${status === 'rejected' || status === 'undone' ? 'opacity-60' : ''}`}>
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
                        const failureMessage = failures
                            .map((failure) => failure.error_code ? `${failure.error_code}: ${failure.error}` : failure.error)
                            .join('\n');
                        const pageIndex = pageIndexForItem(kind, item);
                        const pageNumber = typeof pageIndex === 'number' ? pageIndex + 1 : null;

                        const row = (
                            <div
                                key={`${clientItemId}-${rawItem.index}`}
                                className="create-annotations-preview-row display-flex flex-row items-start gap-2 py-15 cursor-pointer"
                                onClick={() => handleItemClick(item, createdEntries)}
                            >
                                <ZoteroIcon
                                    icon={kind === 'highlight' ? ZOTERO_ICONS.ANNOTATE_HIGHLIGHT : ZOTERO_ICONS.ANNOTATE_NOTE}
                                    size={14}
                                    color={COLOR_VALUES[color] ?? COLOR_VALUES.yellow}
                                    style={{ marginTop: 2 }}
                                />

                                <div className="display-flex flex-row min-w-0 flex-1 justify-between gap-3">
                                    <div className="truncate">
                                        {rawItem.title || text || `${noun} annotation`}
                                    </div>
                                    {pageNumber !== null && (
                                        <div className="font-color-tertiary whitespace-nowrap">
                                            {`Page ${pageNumber}`}
                                        </div>
                                    )}
                                </div>

                            </div>
                        );

                        if (isFailed && failureMessage) {
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
