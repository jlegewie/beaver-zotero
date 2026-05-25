import React from 'react';
import { Icon, TickIcon, CancelIcon, FileDiffIcon } from '../icons/icons';
import Tooltip from '../ui/Tooltip';
import { truncateText } from '../../utils/stringUtils';
import type {
    CreateHighlightAnnotationsProposedData,
    CreateHighlightAnnotationsResultData,
    CreateNoteAnnotationsProposedData,
    CreateNoteAnnotationsResultData,
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

function pageLabelForItem(kind: 'highlight' | 'note', item: HighlightAnnotationItem | NoteAnnotationItem): string {
    const raw = item as any;
    if (raw.page_label ?? raw.pageLabel) return raw.page_label ?? raw.pageLabel;
    if (kind === 'highlight') {
        const firstLoc = raw.page_locations?.[0] ?? raw.pageLocations?.[0] ?? raw.locations?.[0];
        const first = firstLoc?.page_idx ?? firstLoc?.pageIndex ?? firstLoc?.page_index;
        return typeof first === 'number' ? String(first + 1) : '';
    }
    const notePosition = raw.note_position ?? raw.notePosition;
    const pageIndex = notePosition?.page_index ?? notePosition?.pageIndex;
    return typeof pageIndex === 'number' ? String(pageIndex + 1) : '';
}

function statusForItem(
    item: HighlightAnnotationItem | NoteAnnotationItem,
    createdByClient: Map<string, number>,
    failedByClient: Map<string, FailedAnnotation[]>,
): 'created' | 'failed' | 'partial' | 'pending' {
    const clientItemId = (item as any).client_item_id ?? (item as any).clientItemId ?? '';
    const created = createdByClient.get(clientItemId) ?? 0;
    const failed = failedByClient.get(clientItemId)?.length ?? 0;
    if (created > 0 && failed > 0) return 'partial';
    if (created > 0) return 'created';
    if (failed > 0) return 'failed';
    return 'pending';
}

function StatusIcon({
    state,
    failures,
}: {
    state: 'created' | 'failed' | 'partial' | 'pending';
    failures: FailedAnnotation[];
}) {
    if (state === 'pending') return <span className="display-flex" style={{ width: 16 }} />;
    if (state === 'created') {
        return <Icon icon={TickIcon} className="font-color-green scale-11" />;
    }
    const message = failures
        .map((failure) => failure.error_code ? `${failure.error_code}: ${failure.error}` : failure.error)
        .join('\n');
    return (
        <Tooltip content={message || 'Failed'} showArrow>
            <span className="display-flex">
                <Icon icon={state === 'partial' ? FileDiffIcon : CancelIcon} className="font-color-red scale-11" />
            </span>
        </Tooltip>
    );
}

/**
 * Preview for bulk PDF highlight and note annotation actions.
 */
export const CreateAnnotationsPreview: React.FC<CreateAnnotationsPreviewProps> = ({
    kind,
    actionData,
    currentValue,
    resultData,
    status,
    isStreaming,
}) => {
    const items = Array.isArray(actionData.items)
        ? actionData.items as Array<HighlightAnnotationItem | NoteAnnotationItem>
        : [];
    const created = Array.isArray(resultData?.created) ? resultData.created : [];
    const failed = Array.isArray(resultData?.failed) ? resultData.failed as FailedAnnotation[] : [];
    const createdByClient = new Map<string, number>();
    const failedByClient = new Map<string, FailedAnnotation[]>();

    for (const entry of created) {
        createdByClient.set(entry.client_item_id, (createdByClient.get(entry.client_item_id) ?? 0) + 1);
    }
    for (const entry of failed) {
        const list = failedByClient.get(entry.client_item_id) ?? [];
        list.push(entry);
        failedByClient.set(entry.client_item_id, list);
    }

    const requestedRef = actionData.requested_ref;
    const resolvedRef = actionData.resolved_ref;
    const resolutionDiffers = Boolean(
        currentValue?.resolution_differs ||
        (requestedRef?.zotero_key && resolvedRef?.zotero_key && requestedRef.zotero_key !== resolvedRef.zotero_key),
    );
    const noun = kind === 'highlight' ? 'highlight' : 'note';

    return (
        <div className={`create-annotations-preview overflow-hidden ${status === 'rejected' || status === 'undone' ? 'opacity-60' : ''}`}>
            <div className="display-flex flex-col px-3 py-2 gap-2">

                <div className="display-flex flex-col gap-1">
                    {isStreaming && items.length === 0 && (
                        <>
                            <div className="shimmer-text text-sm font-color-secondary">Preparing annotations...</div>
                            <div className="shimmer-text text-sm font-color-secondary">Reading locations...</div>
                        </>
                    )}
                    {items.map((item) => {
                        const rawItem = item as any;
                        const clientItemId = rawItem.client_item_id ?? rawItem.clientItemId ?? '';
                        const itemStatus = statusForItem(item, createdByClient, failedByClient);
                        const failures = failedByClient.get(clientItemId) ?? [];
                        const text = kind === 'highlight'
                            ? truncateText(rawItem.text ?? '', 90)
                            : truncateText(rawItem.comment ?? '', 90);
                        const color = kind === 'highlight' ? rawItem.color : 'yellow';

                        return (
                            <div
                                key={`${clientItemId}-${rawItem.index}`}
                                className="display-flex flex-row items-start gap-2 py-1 border-bottom-quinary"
                            >
                                <div className="display-flex mt-010">
                                    <StatusIcon state={itemStatus} failures={failures} />
                                </div>
                                {kind === 'highlight' && (
                                    <span
                                        className="mt-025"
                                        style={{
                                            width: 10,
                                            height: 10,
                                            borderRadius: 2,
                                            background: COLOR_VALUES[color] ?? COLOR_VALUES.yellow,
                                            border: '1px solid var(--color-border-quinary)',
                                            flex: '0 0 auto',
                                        }}
                                    />
                                )}
                                <div className="display-flex flex-col min-w-0 flex-1 gap-025">
                                    <div className="text-sm font-color-primary truncate">
                                        {text || rawItem.title || `${noun} annotation`}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default CreateAnnotationsPreview;
