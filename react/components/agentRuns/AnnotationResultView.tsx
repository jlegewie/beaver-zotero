import React, { useState, useCallback, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    AgentAction,
    getAgentActionsByToolcallAtom,
    isAnnotationAgentAction,
    isNoteAnnotationAgentAction,
    ackAgentActionsAtom,
    setAgentActionsToErrorAtom,
    rejectAgentActionAtom,
    undoAgentActionAtom,
} from '../../agents/agentActions';
import { AckActionLink } from '../../../src/services/agentActionsService';
import { AnnotationResultData } from '../../types/proposedActions/annotations';
import { applyAnnotation, deleteAnnotationFromReader } from '../../utils/annotationActions';
import { getCurrentReaderAndWaitForView, navigateToAnnotation, navigateToPage } from '../../utils/readerUtils';
import { currentReaderAttachmentKeyAtom } from '../../atoms/messageComposition';
import { isLibraryEditable, shortItemTitle } from '../../../src/utils/zoteroUtils';
import { ZoteroReader } from '../../utils/annotationUtils';
import { logger } from '../../../src/utils/logger';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { Icon, TickIcon, CancelIcon } from '../icons/icons';

// =============================================================================
// Types
// =============================================================================

interface AnnotationResultViewProps {
    runId: string;
    toolCallId: string;
}

type AnnotationAgentAction = AgentAction & {
    proposed_data: {
        title: string;
        comment?: string;
        color?: string;
        library_id: number;
        attachment_key: string;
        highlight_locations?: any[];
        note_position?: any;
    };
    result_data?: AnnotationResultData;
};

// =============================================================================
// AnnotationListItem Component
// =============================================================================

interface AnnotationListItemProps {
    annotation: AnnotationAgentAction;
    isBusy: boolean;
    onClick: (annotation: AnnotationAgentAction) => Promise<void>;
    onDelete: (annotation: AnnotationAgentAction) => Promise<void>;
    onReAdd: (annotation: AnnotationAgentAction) => Promise<void>;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}

const AnnotationListItem: React.FC<AnnotationListItemProps> = ({
    annotation,
    isBusy,
    onClick,
    onDelete,
    onReAdd,
    isHovered,
    onMouseEnter,
    onMouseLeave,
}) => {
    const handleClick = useCallback(() => {
        if (isBusy) return;
        onClick(annotation);
    }, [annotation, isBusy, onClick]);

    const handleDelete = useCallback((e: React.SyntheticEvent) => {
        e.stopPropagation();
        if (isBusy) return;
        onDelete(annotation);
    }, [annotation, isBusy, onDelete]);

    const handleReAdd = useCallback((e: React.SyntheticEvent) => {
        e.stopPropagation();
        if (isBusy) return;
        onReAdd(annotation);
    }, [annotation, isBusy, onReAdd]);

    const icon = isNoteAnnotationAgentAction(annotation)
        ? ZOTERO_ICONS.ANNOTATE_NOTE
        : ZOTERO_ICONS.ANNOTATE_HIGHLIGHT;

    // Determine icon color based on status and annotation color
    const getIconColor = () => {
        const isInactive = annotation.status === 'rejected' || 
                          annotation.status === 'pending' || 
                          annotation.status === 'undone';
        if (annotation.status === 'error') return 'font-color-secondary';
        if (isInactive) return 'font-color-tertiary';
        if (annotation.proposed_data.color) {
            const color = annotation.proposed_data.color;
            return `${color === 'yellow' ? 'opacity-100' : ''} font-color-${color}`;
        }
        return 'font-color-secondary';
    };

    const getTextClasses = () => {
        if (annotation.status === 'rejected' || annotation.status === 'undone') {
            return 'font-color-tertiary line-through';
        }
        if (annotation.status === 'pending') return 'font-color-tertiary';
        return 'font-color-secondary';
    };

    const isInactive = annotation.status === 'rejected' || 
                       annotation.status === 'undone' || 
                       annotation.status === 'error';

    return (
        <div
            className={`
                px-25 py-15 display-flex flex-col gap-1 cursor-pointer
                rounded-sm transition user-select-none
                ${isHovered ? 'bg-quinary' : ''}
                ${isInactive ? 'opacity-60' : ''}
            `}
            onClick={handleClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="display-flex flex-row items-start gap-3">
                <ZoteroIcon
                    icon={icon}
                    size={13}
                    className={`flex-shrink-0 mt-020 ${getIconColor()}`}
                />
                <div className="flex-1 min-w-0">
                    <div className={getTextClasses()}>
                        {annotation.proposed_data.title || 'Annotation'}
                    </div>
                </div>

                {/* Applied: show delete button on hover */}
                {annotation.status === 'applied' && (
                    <div className={`display-flex ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <button
                            onClick={handleDelete}
                            disabled={isBusy}
                            className="p-1 hover:bg-quaternary rounded"
                            title="Delete annotation"
                        >
                            <Icon icon={CancelIcon} className="font-color-tertiary" />
                        </button>
                    </div>
                )}

                {/* Rejected/Undone: show re-add button on hover */}
                {(annotation.status === 'rejected' || annotation.status === 'undone') && (
                    <div className={`display-flex ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <button
                            onClick={handleReAdd}
                            disabled={isBusy}
                            className="p-1 hover:bg-quaternary rounded scale-13"
                            title="Add annotation"
                        >
                            <Icon icon={TickIcon} className="font-color-tertiary" />
                        </button>
                    </div>
                )}

                {/* Pending: show both reject and accept buttons on hover */}
                {annotation.status === 'pending' && (
                    <div className={`display-flex gap-1 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <button
                            onClick={handleDelete}
                            disabled={isBusy}
                            className="p-1 hover:bg-quaternary rounded"
                            title="Reject annotation"
                        >
                            <Icon icon={CancelIcon} className="font-color-tertiary" />
                        </button>
                        <button
                            onClick={handleReAdd}
                            disabled={isBusy}
                            className="p-1 hover:bg-quaternary rounded scale-13"
                            title="Add annotation"
                        >
                            <Icon icon={TickIcon} className="font-color-tertiary" />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

// =============================================================================
// AnnotationResultView Component
// =============================================================================

/**
 * Renders annotation results for a tool call.
 * Displays a list of annotations that can be applied, deleted, or navigated to.
 */
export const AnnotationResultView: React.FC<AnnotationResultViewProps> = ({ runId, toolCallId }) => {
    // Get annotations from agent actions
    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const annotations = getAgentActionsByToolcall(toolCallId, isAnnotationAgentAction) as AnnotationAgentAction[];

    // Current reader state
    const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);

    // State management
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);

    // UI state
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
    const [attachmentTitle, setAttachmentTitle] = useState<string | null>(null);

    // Derived state
    const isAttachmentOpen = annotations.some(
        (action) => action.proposed_data.attachment_key === currentReaderAttachmentKey
    );
    const readOnlyLibrary = annotations.some(
        (action) => !isLibraryEditable(action.proposed_data.library_id)
    );

    // Fetch attachment title
    useEffect(() => {
        const fetchTitle = async () => {
            if (annotations.length === 0) return;
            const firstAnnotation = annotations[0];
            const item = await Zotero.Items.getByLibraryAndKeyAsync(
                firstAnnotation.proposed_data.library_id,
                firstAnnotation.proposed_data.attachment_key
            );
            if (item) {
                const title = await shortItemTitle(item);
                setAttachmentTitle(title);
            }
        };
        if (!attachmentTitle) {
            fetchTitle();
        }
    }, [annotations, attachmentTitle]);

    const setBusy = (id: string, busy: boolean) => {
        setBusyIds((prev) => {
            const next = new Set(prev);
            if (busy) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    /**
     * Apply a single annotation or all pending annotations
     */
    const handleApplyAnnotations = useCallback(async (annotationId?: string) => {
        if (annotations.length === 0) return;

        const toApply = annotationId
            ? annotations.filter((a) => a.id === annotationId && a.status !== 'applied')
            : annotations.filter((a) => a.status === 'pending' || a.status === 'error' || a.status === 'rejected' || a.status === 'undone');

        if (toApply.length === 0) return;

        // Mark all as busy
        toApply.forEach((a) => setBusy(a.id, true));

        try {
            // Open attachment if not already open
            if (!isAttachmentOpen) {
                const firstAnnotation = annotations[0];
                const attachmentItem = await Zotero.Items.getByLibraryAndKeyAsync(
                    firstAnnotation.proposed_data.library_id,
                    firstAnnotation.proposed_data.attachment_key
                );
                if (!attachmentItem) {
                    setAgentActionsToError(toApply.map((a) => a.id), 'Attachment not found');
                    toApply.forEach((a) => setBusy(a.id, false));
                    return;
                }

                // Find minimum page to navigate to
                const pageIndexes = toApply.map((a) =>
                    isNoteAnnotationAgentAction(a)
                        ? a.proposed_data.note_position?.page_index
                        : a.proposed_data.highlight_locations?.[0]?.page_idx
                ).filter((idx): idx is number => typeof idx === 'number');
                const minPageIndex = pageIndexes.length > 0 ? Math.min(...pageIndexes) : 0;

                await navigateToPage(attachmentItem.id, minPageIndex + 1);
            }

            // Get reader
            const reader = await getCurrentReaderAndWaitForView() as ZoteroReader | undefined;
            if (!reader) {
                toApply.forEach((a) => setBusy(a.id, false));
                return;
            }

            // Apply annotations in parallel
            const results: (AckActionLink | null)[] = await Promise.all(
                toApply.map(async (annotation) => {
                    try {
                        // Cast to AnnotationProposedAction for applyAnnotation
                        const result = await applyAnnotation(annotation as any, reader);
                        logger(`AnnotationResultView: applied annotation ${annotation.id}`, 1);
                        return { action_id: annotation.id, result_data: result } as AckActionLink;
                    } catch (error: any) {
                        const errorMessage = error?.message || 'Failed to apply annotation';
                        logger(`AnnotationResultView: failed to apply ${annotation.id}: ${errorMessage}`, 1);
                        setAgentActionsToError([annotation.id], errorMessage);
                        return null;
                    }
                })
            );

            // Acknowledge successful applications
            const successful = results.filter((r): r is AckActionLink => r !== null);
            if (successful.length > 0) {
                await ackAgentActions(runId, successful);

                // Navigate to first successful annotation
                await new Promise((resolve) => setTimeout(resolve, 250));
                const firstSuccess = successful[0];
                const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
                    firstSuccess.result_data.library_id,
                    firstSuccess.result_data.zotero_key
                );
                if (annotationItem) {
                    await navigateToAnnotation(annotationItem);
                }
            }
        } finally {
            toApply.forEach((a) => setBusy(a.id, false));
        }
    }, [annotations, isAttachmentOpen, runId, ackAgentActions, setAgentActionsToError]);

    /**
     * Handle clicking on an annotation - navigate if applied, re-add if not
     */
    const handleAnnotationClick = useCallback(async (annotation: AnnotationAgentAction) => {
        if (annotation.status === 'applied' && annotation.result_data?.zotero_key) {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(
                annotation.result_data.library_id,
                annotation.result_data.zotero_key
            );
            if (item) {
                await navigateToAnnotation(item);
            }
        } else if (annotation.status !== 'applied') {
            await handleApplyAnnotations(annotation.id);
        }
    }, [handleApplyAnnotations]);

    /**
     * Delete or reject an annotation
     */
    const handleDelete = useCallback(async (annotation: AnnotationAgentAction) => {
        setBusy(annotation.id, true);
        try {
            if (annotation.status === 'applied' && annotation.result_data?.zotero_key) {
                // Delete from PDF
                await deleteAnnotationFromReader(annotation as any);
                undoAgentAction(annotation.id);
            } else {
                // Just reject
                rejectAgentAction(annotation.id);
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to delete annotation';
            setAgentActionsToError([annotation.id], errorMessage);
        } finally {
            setBusy(annotation.id, false);
        }
    }, [rejectAgentAction, undoAgentAction, setAgentActionsToError]);

    /**
     * Re-add an annotation that was rejected/undone
     */
    const handleReAdd = useCallback(async (annotation: AnnotationAgentAction) => {
        await handleApplyAnnotations(annotation.id);
    }, [handleApplyAnnotations]);

    // Empty state
    if (annotations.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No annotations
            </div>
        );
    }

    // Read-only library message
    if (readOnlyLibrary) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                Cannot add annotations to a read-only library
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            {/* Attachment title header */}
            {attachmentTitle && (
                <div className="px-3 pt-2 pb-1 text-xs font-color-tertiary truncate">
                    {attachmentTitle}
                </div>
            )}

            {/* Annotation list */}
            {annotations.map((annotation) => (
                <AnnotationListItem
                    key={annotation.id}
                    annotation={annotation}
                    isBusy={busyIds.has(annotation.id)}
                    onClick={handleAnnotationClick}
                    onDelete={handleDelete}
                    onReAdd={handleReAdd}
                    isHovered={hoveredId === annotation.id}
                    onMouseEnter={() => setHoveredId(annotation.id)}
                    onMouseLeave={() => setHoveredId(null)}
                />
            ))}
        </div>
    );
};

export default AnnotationResultView;

