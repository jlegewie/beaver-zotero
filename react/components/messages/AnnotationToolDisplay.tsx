import React, { useState, useEffect, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { ToolCall } from '../../types/chat/apiTypes';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Icon,
    TickIcon,
    CancelIcon
} from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import {
    applyAnnotation,
    deleteAnnotationFromReader,
} from '../../utils/annotationActions';
import { getCurrentReaderAndWaitForView, navigateToAnnotation, navigateToPage} from '../../utils/readerUtils';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { logger } from '../../../src/utils/logger';
import { useLoadingDots } from '../../hooks/useLoadingDots';
import { ZoteroReader } from '../../utils/annotationUtils';
import { currentReaderAttachmentKeyAtom } from '../../atoms/messageComposition';
import { isLibraryEditable, shortItemTitle } from '../../../src/utils/zoteroUtils';
import { getProposedActionsByToolcallAtom, setProposedActionsToErrorAtom, rejectProposedActionStateAtom, ackProposedActionsAtom, undoProposedActionAtom } from '../../atoms/proposedActions';
import { AnnotationProposedAction, isAnnotationAction, isNoteAnnotationAction, AnnotationResultData } from '../../types/proposedActions/base';
import { AckLink } from '../../../src/services/proposedActionsService';
import Tooltip from '../ui/Tooltip';
import {
    annotationAttachmentTitlesAtom,
    annotationBusyAtom,
    annotationPanelStateAtom,
    defaultAnnotationPanelState,
    setAnnotationAttachmentTitleAtom,
    setAnnotationBusyStateAtom,
    setAnnotationPanelStateAtom,
    toggleAnnotationPanelVisibilityAtom
} from '../../atoms/messageUIState';
import { getAttachmentIdFromToolCall } from './AssistantMessageTools';

interface AnnotationListItemProps {
    annotation: AnnotationProposedAction;
    isBusy: boolean;
    onClick: (annotation: AnnotationProposedAction) => Promise<void>;
    onDelete: (annotation: AnnotationProposedAction) => Promise<void>;
    onReAdd: (annotation: AnnotationProposedAction) => Promise<void>;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    className?: string;
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
    className,
}) => {
    const handleClick = useCallback(() => {
        if (isBusy) return;
        onClick(annotation);
    }, [annotation, isBusy, onClick]);

    const handleAction = useCallback(
        (event: React.SyntheticEvent) => {
            event.stopPropagation();
            if (isBusy) return;
            if (annotation.status === 'rejected' || annotation.status === 'pending' || annotation.status === 'undone') {
                onReAdd(annotation);
            } else {
                onDelete(annotation);
            }
        },
        [annotation, isBusy, onDelete, onReAdd]
    );

    const handleReject = useCallback(
        (event: React.SyntheticEvent) => {
            event.stopPropagation();
            if (isBusy) return;
            onDelete(annotation);
        },
        [annotation, isBusy, onDelete]
    );

    const handleReAdd = useCallback(
        (event: React.SyntheticEvent) => {
            event.stopPropagation();
            if (isBusy) return;
            onReAdd(annotation);
        },
        [annotation, isBusy, onReAdd]
    );

    const icon = isNoteAnnotationAction(annotation)
        ? ZOTERO_ICONS.ANNOTATE_NOTE
        : ZOTERO_ICONS.ANNOTATE_HIGHLIGHT;
    const hasApplicationError = annotation.status !== 'error';

    // Icon color
    let iconColor = annotation.status === 'rejected' || annotation.status === 'pending' || annotation.status === 'undone'
        ? 'font-color-tertiary'
        : 'font-color-secondary';
    iconColor = annotation.result_data?.color
        ? `${annotation.result_data.color == 'yellow' ? 'opacity-100' : ''} font-color-${annotation.result_data.color}`
        : iconColor;
    iconColor = annotation.status === 'error' ? 'font-color-secondary' : iconColor;

    const baseClasses = [
        'px-25',
        'py-15',
        'display-flex',
        'flex-col',
        'gap-1',
        // 'border-top-quinary',
        'cursor-pointer',
        'rounded-sm',
        'transition',
        'user-select-none',
    ];

    const getTextClasses = () => {
        if (annotation.status === 'rejected' || annotation.status === 'undone') return 'font-color-tertiary line-through';
        if (annotation.status === 'pending') return 'font-color-tertiary';
        return 'font-color-secondary';
    }

    if (isHovered) {
        baseClasses.push('bg-quinary');
    }
    if (annotation.status === 'rejected' || annotation.status === 'undone' || annotation.status === 'error') {
        baseClasses.push('opacity-60');
    }

    return (
        <div
            className={`${baseClasses.join(' ')} ${className}`}
            onClick={handleClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="display-flex flex-row items-start gap-3">
                {hasApplicationError ? (
                    <ZoteroIcon
                        icon={icon}
                        size={13}
                        className={`flex-shrink-0 mt-020 ${iconColor}`}
                    />
                ) : (
                    <Icon
                        icon={AlertIcon}
                        className={`flex-shrink-0 mt-020 ${iconColor}`}
                    />
                )}
                <div className="flex-1 min-w-0">
                    <div className={getTextClasses()}>
                        {annotation.proposed_data.title || 'Annotation'}
                        {/* {annotation.status === 'applied' &&
                            <Icon icon={TickIcon} className="-mb-015 ml-2 font-color-secondary scale-12" />
                        } */}
                    </div>
                </div>
                {(annotation.status === 'applied') && (
                    <div className={`display-flex flex-row items-center gap-2 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-secondary"
                            // onClick={annotation.status === 'applied' ? handleDelete : handleApplyAnnotation}
                            onClick={handleReject}
                            className="p-1"
                            title='Delete annotation'
                            icon={CancelIcon}
                            loading={isBusy}
                        />
                    </div>
                )}
                
                {(annotation.status === 'rejected' || annotation.status === 'undone') && (
                    <div className={`display-flex flex-row items-center -mr-015 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-secondary"
                            onClick={handleReAdd}
                            className="p-1 scale-13"
                            title='Add annotation'
                            icon={TickIcon}
                            loading={isBusy}
                        />
                    </div>
                )}
                {(annotation.status === 'pending') && (
                    <div className={`display-flex flex-row items-center -mr-015 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-tertiary"
                            onClick={handleReject}
                            className="p-1"
                            title='Reject annotation'
                            icon={CancelIcon}
                            loading={isBusy}
                        />
                        <IconButton
                            variant="ghost-tertiary"
                            onClick={handleReAdd}
                            className="p-1 scale-13"
                            title='Add annotation'
                            icon={TickIcon}
                            loading={isBusy}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

interface AnnotationToolDisplayProps {
    messageId: string;
    groupId: string;
    toolCalls: ToolCall[];
}

/**
 * Component that displays and manages AI-generated annotations for PDFs.
 * Handles the lifecycle of annotations from creation to application in Zotero.
 * 
 * Annotation lifecycle:
 * 1. pending -> Check if annotation already exists in PDF
 * 2. pending -> Apply annotation to PDF (if reader is open)
 * 3. applied -> User can navigate to or delete the annotation
 */
const AnnotationToolDisplay: React.FC<AnnotationToolDisplayProps> = ({ messageId, groupId, toolCalls }) => {

    // Current reader state
    const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);

    // UI state for collapsible annotation list
    const panelStates = useAtomValue(annotationPanelStateAtom);
    const panelState = panelStates[groupId] ?? defaultAnnotationPanelState;
    const { resultsVisible, isApplying: isApplyingAnnotations } = panelState;
    const busyStateMap = useAtomValue(annotationBusyAtom);
    const busyState = busyStateMap[groupId] ?? {};
    const attachmentTitleMap = useAtomValue(annotationAttachmentTitlesAtom);
    const attachmentTitle = attachmentTitleMap[groupId] ?? null;

    // Track hover states for UI interactions
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);

    // State of tool calls group
    const isInProgress = toolCalls.some((toolCall) => toolCall.status === 'in_progress');
    const isCompleted = toolCalls.every((toolCall) => toolCall.status === 'completed');
    const isError = toolCalls.some((toolCall) => toolCall.status === 'error');
    const readOnlyLibrary = toolCalls.some((toolCall) =>
        getAttachmentIdFromToolCall(toolCall) && !isLibraryEditable(Number(getAttachmentIdFromToolCall(toolCall)?.split('-')[0]))
    );
    
    // Loading animation for in-progress tool calls
    const loadingDots = useLoadingDots(isInProgress);
    
    // Global state updater for annotation status changes
    const ackProposedActions = useSetAtom(ackProposedActionsAtom);
    const rejectProposedAction = useSetAtom(rejectProposedActionStateAtom);
    const setProposedActionsToError = useSetAtom(setProposedActionsToErrorAtom);
    const undoProposedAction = useSetAtom(undoProposedActionAtom);

    // Extract annotations from tool call result
    const getProposedActionsByToolcall = useAtomValue(getProposedActionsByToolcallAtom);
    const annotations = toolCalls.map((toolCall) => getProposedActionsByToolcall(toolCall.id, isAnnotationAction)).flat() as AnnotationProposedAction[];
    const totalAnnotations = annotations.length;

    // Is the current reader attachment key the same as the attachment key for annotations
    const isAttachmentOpen = annotations.some((action) => action.proposed_data.attachment_key === currentReaderAttachmentKey);

    // Compute overall state of all annotations
    const somePending = annotations.some((annotation) => annotation.status === 'pending');
    const someErrors = annotations.some((annotation) => annotation.status === 'error');
    const appliedAnnotationCount = annotations.filter((annotation) => annotation.status === 'applied').length;
    const rejectedAnnotationCount = annotations.filter((annotation) => annotation.status === 'rejected' || annotation.status === 'undone').length;
    const allErrors = annotations.every((annotation) => annotation.status === 'error');

    const toggleAnnotationPanelVisibility = useSetAtom(toggleAnnotationPanelVisibilityAtom);
    const setAnnotationPanelState = useSetAtom(setAnnotationPanelStateAtom);
    const setAnnotationBusy = useSetAtom(setAnnotationBusyStateAtom);
    const setAnnotationAttachmentTitle = useSetAtom(setAnnotationAttachmentTitleAtom);

    // Toggle visibility of annotation list (only when tool call is completed and has processable annotations)
    const toggleResults = useCallback(() => {
        if (isCompleted && totalAnnotations > 0) {
            toggleAnnotationPanelVisibility(groupId);
        }
    }, [groupId, isCompleted, totalAnnotations, toggleAnnotationPanelVisibility]);

    /**
     * Handle applying annotations to the PDF
     * 
     * This function orchestrates the entire process of creating annotations in Zotero.
     * It handles opening the PDF, applying each annotation, syncing with the backend,
     * and navigating the user to the first successfully applied annotation.
     * 
     * @param annotationId - Optional ID to apply only a specific annotation. If not provided, applies all pending/error annotations.
     */
    const handleApplyAnnotations = useCallback(async (annotationId?: string) => {
        // Guard clause: No annotations to apply
        if (annotations.length === 0) return;
        setAnnotationPanelState({ key: groupId, updates: { isApplying: true } });

        try {
            // STEP 1: ENSURE PDF IS OPEN
            // If the attachment is not open, open it and navigate to the first annotation's page
            if (!isAttachmentOpen) {
                const attachmentItem = await Zotero.Items.getByLibraryAndKeyAsync(
                    annotations[0].proposed_data.library_id,
                    annotations[0].proposed_data.attachment_key
                );

                // Handle case where attachment doesn't exist
                if (!attachmentItem) {
                    setProposedActionsToError(annotations.map(a => a.id), 'Attachment not found');
                    setAnnotationPanelState({ key: groupId, updates: { isApplying: false } });
                    return;
                }

                // Calculate the page to navigate to (find the minimum page index across all annotations)
                const pageIndexes = annotations.map((a) => (
                    isNoteAnnotationAction(a)
                        ? a.proposed_data.note_position?.page_index
                        : a.proposed_data.highlight_locations?.[0]?.page_index
                ));
                const minPageIndex = pageIndexes.length > 0
                    ? Math.min(...pageIndexes.filter((idx) => typeof idx === 'number'))
                    : 0;

                // Open the PDF and navigate to the calculated page
                await navigateToPage(attachmentItem.id, minPageIndex + 1);
            }

            // STEP 2: GET READER INSTANCE AND WAIT FOR VIEW TO LOAD
            const reader = await getCurrentReaderAndWaitForView() as ZoteroReader | undefined;
            if (!reader) {
                setAnnotationPanelState({ key: groupId, updates: { isApplying: false } });
                return;
            }

            // STEP 3: FILTER ANNOTATIONS TO APPLY
            const annotationsToApply = annotations.filter(annotation => {
                // Skip already applied annotations
                if (annotation.status === 'applied') return false;
                // If a specific annotationId was provided, only apply that one
                if (annotationId && annotation.id !== annotationId) return false;
                return true;
            });

            // Guard clause: No annotations to apply
            if (annotationsToApply.length === 0) {
                setAnnotationPanelState({ key: groupId, updates: { isApplying: false } });
                return;
            }

            // STEP 4: APPLY ALL ANNOTATIONS IN PARALLEL
            const applyResults: (AckLink | null)[] = await Promise.all(
                annotationsToApply.map(async (annotation) => {
                    try {
                        // Apply the annotation to the PDF
                        const result: AnnotationResultData = await applyAnnotation(annotation, reader);

                        // Log the successful application
                        logger(`handleApplyAnnotations: applied annotation ${annotation.id}: ${JSON.stringify(result)}`, 1);
                        return {
                            action_id: annotation.id,
                            result_data: result,
                        } as AckLink;
                    } catch (error: any) {
                        // Handle errors during annotation application
                        const errorMessage = error?.message || 'Failed to apply annotation';
                        logger(`handleApplyAnnotations: failed to apply annotation ${annotation.id}: ${errorMessage}`, 1);
                        setProposedActionsToError([annotation.id], errorMessage);
                        return null;
                    }
                })
            );

            // STEP 5: ACKNOWLEDGE SUCCESSFULLY APPLIED ANNOTATIONS AND UPDATE UI STATE
            const actionsResultDataToAcknowledge = applyResults.filter(result => result !== null);
            if (actionsResultDataToAcknowledge.length > 0) {
                await ackProposedActions(messageId, actionsResultDataToAcknowledge);
            }

            // Show the results panel and mark operation as complete
            setAnnotationPanelState({ key: groupId, updates: { resultsVisible: true, isApplying: false } });

            // STEP 6: NAVIGATE TO FIRST SUCCESSFULLY APPLIED ANNOTATION
            if (actionsResultDataToAcknowledge.length > 0) {
                await new Promise(resolve => setTimeout(resolve, 250));
                const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
                    actionsResultDataToAcknowledge[0].result_data.library_id,
                    actionsResultDataToAcknowledge[0].result_data.zotero_key
                );
                if (annotationItem) {
                    await navigateToAnnotation(annotationItem);
                }
            }

        } catch (error) {
            logger(`handleApplyAnnotations: unexpected error: ${error}`, 1);
            setAnnotationPanelState({ key: groupId, updates: { isApplying: false } });
        }
    }, [annotations, groupId, isAttachmentOpen, messageId, setAnnotationPanelState, ackProposedActions, setProposedActionsToError]);

    /**
     * Get the title of the attachment
     */
    useEffect(() => {
        const getAttachmentTitle = async () => {
            if (annotations.length === 0) return;
            const attachmentKey = annotations[0].proposed_data?.attachment_key;
            if (!attachmentKey) return;
            const attachmentItem = await Zotero.Items.getByLibraryAndKeyAsync(
                annotations[0].proposed_data?.library_id,
                attachmentKey
            );
            if (!attachmentItem) return;
            const title = await shortItemTitle(attachmentItem);
            setAnnotationAttachmentTitle({ key: groupId, title });
        };
        if (!attachmentTitle) {
            getAttachmentTitle();
        }
    }, [annotations, attachmentTitle, groupId, setAnnotationAttachmentTitle]);

    /**
     * Navigate to an annotation on annotation click
     */
    const handleAnnotationClick = useCallback(
        async (annotation: AnnotationProposedAction) => {
            // Navigate to annotation if it exists
            if (annotation.status === 'applied' && annotation.result_data?.zotero_key) {
                const annotationItem =
                    await Zotero.Items.getByLibraryAndKeyAsync(
                        annotation.result_data.library_id,
                        annotation.result_data.zotero_key
                    );
                if (!annotationItem) return;
                await navigateToAnnotation(annotationItem);

            // Re-add annotation if it was deleted
            } else if (annotation.status === 'rejected' || annotation.status === 'pending' || annotation.status === 'undone') {
                await handleApplyAnnotations(annotation.id);
            }
        },
        [handleApplyAnnotations]
    );

    /**
     * Handle deleting an annotation from the PDF
     * If annotation exists in PDF, deletes it; otherwise just marks as deleted
     */
    const handleDelete = useCallback(
        async (annotation: AnnotationProposedAction) => {
            setAnnotationBusy({ key: groupId, annotationId: annotation.id, isBusy: true });
            try {
                if (
                    annotation.status !== 'applied' ||
                    !annotation.result_data?.zotero_key
                ) {
                    // Annotation not yet applied to PDF - just mark as deleted
                    rejectProposedAction(annotation.id);
                } else {
                    // deleteAnnotationFromReader: Removes annotation from PDF reader
                    await deleteAnnotationFromReader(annotation);
                    undoProposedAction(annotation.id);
                }
            } catch (error: any) {
                const errorMessage = error?.message || 'Failed to delete annotation';
                setProposedActionsToError([annotation.id], errorMessage);
            } finally {
                setAnnotationBusy({ key: groupId, annotationId: annotation.id, isBusy: false });
            }
        },
        [groupId, rejectProposedAction, setAnnotationBusy, setProposedActionsToError, undoProposedAction]
    );

    // Re-add a deleted annotation by treating it like a click
    const handleReAddAnnotation = useCallback(
        async (annotation: AnnotationProposedAction) => {
            await handleAnnotationClick(annotation);
        },
        [handleAnnotationClick]
    );

    /**
     * Reject all pending annotations (those not yet applied)
     */
    const handleRejectAll = useCallback(() => {
        const pendingAnnotations = annotations.filter(
            (annotation) => annotation.status === 'pending' || annotation.status === 'error'
        );
        pendingAnnotations.forEach((annotation) => {
            rejectProposedAction(annotation.id);
        });
    }, [annotations, rejectProposedAction]);

    // Determine which icon to show based on tool call and UI state
    const getIcon = () => {
        if (isInProgress || isApplyingAnnotations) return Spinner;
        if (isError || allErrors) return AlertIcon;
        if (isCompleted) {
            if (resultsVisible) return ArrowDownIcon;
            if (isButtonHovered && totalAnnotations > 0) return ArrowRightIcon;
            if (totalAnnotations === 0) return AlertIcon;
            return <ZoteroIcon icon={ZOTERO_ICONS.ANNOTATION} size={12} className="flex-shrink-0" />;
        }
        return <ZoteroIcon icon={ZOTERO_ICONS.ANNOTATION} size={12} className="flex-shrink-0" />;
    };

    // Generate button text showing annotation count
    const getButtonText = () => {
        if (isInProgress) {
            return `Annotations${''.padEnd(loadingDots, '.')}`;
        }
        if (isError) {
            return 'Annotations: Error';
        }
        
        return 'Annotations';
    };

    // Determine when the results can be toggled and when button should be disabled
    const hasAnnotationsToShow = totalAnnotations > 0;
    const canToggleResults = isCompleted && hasAnnotationsToShow && !allErrors;
    const isButtonDisabled = isInProgress || isError || (isCompleted && !hasAnnotationsToShow);

    // Determine when to show apply button
    const showApplyButton = isCompleted && (somePending || someErrors) && !isApplyingAnnotations;
    
    return (
        <div
            id={`tool-${toolCalls[0].id}`}
            className="border-popup rounded-md display-flex flex-col min-w-0"
        >
            {/* Main button that shows annotation count and toggles visibility */}
            <div
                className={`display-flex flex-row bg-senary py-15 px-2 ${resultsVisible && hasAnnotationsToShow ? 'border-bottom-quinary' : ''}`}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
            >
                <div className="display-flex flex-row flex-1" onClick={toggleResults}>
                    <Button
                        variant="ghost-secondary"
                        icon={getIcon()}
                        // onClick={toggleResults}
                        // onMouseEnter={() => setIsButtonHovered(true)}
                        // onMouseLeave={() => setIsButtonHovered(false)}
                        className={`
                            text-base scale-105
                            ${isButtonDisabled && !canToggleResults ? 'disabled-but-styled' : ''}
                            ${isError ? 'font-color-warning' : ''}
                        `}
                        disabled={isButtonDisabled && !canToggleResults}
                    >
                        <span className="mr-1">{getButtonText()}</span>

                        {/* Annotations metrics */}
                        {isCompleted && hasAnnotationsToShow && (
                            <div className="display-flex flex-row items-center gap-1">
                                {appliedAnnotationCount > 0 &&
                                   <div className="font-color-green text-sm">+{appliedAnnotationCount}</div>
                                }
                                {rejectedAnnotationCount > 0 &&
                                    <div className="font-color-tertiary text-sm">-{rejectedAnnotationCount}</div>
                                }
                                {rejectedAnnotationCount == 0 && appliedAnnotationCount === 0 &&
                                    <div className="font-color-tertiary text-sm">({totalAnnotations})</div>
                                }
                            </div>
                        )}
                    </Button>
                    <div className="flex-1"/>
                </div>
                {readOnlyLibrary && (
                    <div className="text-sm font-color-tertiary mt-015">
                        Read-only library
                    </div>
                )}
                {showApplyButton && !readOnlyLibrary && (
                    <div className="display-flex flex-row items-center gap-3 mr-015">
                        <Tooltip content={attachmentTitle} showArrow singleLine>
                            <div className="text-sm truncate font-color-tertiary" style={{ maxWidth: '135px' }}>
                                {attachmentTitle}
                            </div>
                        </Tooltip>
                        <Tooltip content="Reject all" showArrow singleLine>
                            <IconButton
                                icon={CancelIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-red"
                                onClick={handleRejectAll}
                            />
                        </Tooltip>
                        <Tooltip content="Add annotations" showArrow singleLine>
                            <IconButton
                                icon={TickIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-green scale-14"
                                onClick={() => handleApplyAnnotations()}
                            />
                        </Tooltip>
                    </div>
                    
                    // <Button
                    //     icon={TickIcon}
                    //     iconClassName="-mr-015"
                    //     variant="ghost-tertiary"
                    //     onClick={() => handleApplyAnnotations()}
                    // >
                    //     <span className="text-sm truncate" style={{ maxWidth: '125px' }}>
                    //         {!isAttachmentOpen && attachmentTitle ? `Add to ${attachmentTitle}` : 'Add'}
                    //     </span>
                    // </Button>
                )}
                {!showApplyButton && !readOnlyLibrary && (
                    <div className="text-sm truncate font-color-tertiary mt-015" style={{ maxWidth: '155px' }}>
                        {attachmentTitle}
                    </div>
                )}
            </div>

            {/* Expandable list of individual annotations */}
            {resultsVisible && hasAnnotationsToShow && isCompleted && (
                <div className="display-flex flex-col gap-1">
                    {annotations.map((annotation, index) => (
                        <AnnotationListItem
                            key={annotation.id}
                            annotation={annotation}
                            isBusy={Boolean(busyState[annotation.id])}
                            onClick={handleAnnotationClick}
                            onDelete={handleDelete}
                            onReAdd={handleReAddAnnotation}
                            isHovered={hoveredAnnotationId === annotation.id}
                            onMouseEnter={() => setHoveredAnnotationId(annotation.id)}
                            onMouseLeave={() => setHoveredAnnotationId(null)}
                            className={index === 0 ? 'pt-2' : ''}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

export default AnnotationToolDisplay;
