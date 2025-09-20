import React, { useState, useEffect, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { ToolCall } from '../../types/chat/apiTypes';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Icon,
    DeleteIcon,
    PlusSignIcon,
    PlayIcon,
} from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import { ToolAnnotation } from '../../types/chat/toolAnnotations';
import {
    applyAnnotation,
    deleteAnnotationFromReader,
    openAttachmentForAnnotation,
    validateAppliedAnnotation,
} from '../../utils/toolAnnotationActions';
import { navigateToAnnotation, navigateToPage} from '../../utils/readerUtils';
import { updateToolcallAnnotationAtom } from '../../atoms/threads';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { logger } from '../../../src/utils/logger';
import { useLoadingDots } from '../../hooks/useLoadingDots';
import { getCurrentReader } from '../../utils/readerUtils';
import { ZoteroReader } from '../../utils/annotationUtils';
import { currentReaderAttachmentKeyAtom } from '../../atoms/input';

interface AnnotationListItemProps {
    annotation: ToolAnnotation;
    isBusy: boolean;
    onClick: (annotation: ToolAnnotation) => Promise<void>;
    onDelete: (annotation: ToolAnnotation) => Promise<void>;
    onReAdd: (annotation: ToolAnnotation) => Promise<void>;
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

    const handleAction = useCallback(
        (event: React.SyntheticEvent) => {
            event.stopPropagation();
            if (isBusy) return;
            if (annotation.status === 'deleted') {
                onReAdd(annotation);
            } else {
                onDelete(annotation);
            }
        },
        [annotation, isBusy, onDelete, onReAdd]
    );

    const icon = annotation.annotation_type === 'note'
        ? ZOTERO_ICONS.ANNOTATE_NOTE
        : ZOTERO_ICONS.ANNOTATE_HIGHLIGHT;
    const hasApplicationError = Boolean(annotation.error_message) && annotation.status !== 'deleted';
    const iconColor = hasApplicationError
        ? 'font-color-warning'
        : 'font-color-secondary';
    const baseClasses = [
        'px-2',
        'py-1',
        'display-flex',
        'flex-col',
        'gap-1',
        // 'border-top-quinary',
        'cursor-pointer',
        'rounded-sm',
        'transition',
        'user-select-none',
    ];

    if (isHovered) {
        baseClasses.push('bg-quinary');
    }
    if (annotation.status === 'deleted') {
        baseClasses.push('opacity-60');
    }

    return (
        <div
            className={baseClasses.join(' ')}
            onClick={handleClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="display-flex flex-row items-start gap-3">
                <ZoteroIcon
                    icon={icon}
                    size={13}
                    className={`flex-shrink-0 mt-020 ${iconColor}`}
                />
                <div className="flex-1 min-w-0">
                    <div
                        className={`${
                            annotation.status === 'deleted'
                                ? 'font-color-tertiary line-through'
                                : 'font-color-secondary'
                        }`}
                    >
                        {annotation.title + ' (' + annotation.status + ')' || 'Annotation'}
                    </div>
                </div>
                {(annotation.status === 'applied' || annotation.status === 'deleted') && (
                    <div className="display-flex flex-row items-center gap-2">
                        <IconButton
                            variant="ghost-secondary"
                            // onClick={annotation.status === 'applied' ? handleDelete : handleApplyAnnotation}
                            onClick={handleAction}
                            className="p-1"
                            title={
                                annotation.status === 'applied'
                                    ? 'Delete annotation'
                                    : 'Apply annotation'
                            }
                            icon={
                                annotation.status === 'applied'
                                    ? DeleteIcon
                                    : PlayIcon
                            }
                            loading={isBusy}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

interface AnnotationToolCallDisplayProps {
    messageId: string;
    toolCall: ToolCall;
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
const AnnotationToolCallDisplay: React.FC<AnnotationToolCallDisplayProps> = ({ messageId, toolCall }) => {
    // Current reader state
    const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);

    // UI state for collapsible annotation list
    const [resultsVisible, setResultsVisible] = useState(false);
    
    // Track which individual annotations are currently being processed
    const [busyState, setBusyState] = useState<Record<string, boolean>>({});
    
    // Track hover states for UI interactions
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
    
    // Loading animation for in-progress tool calls
    const loadingDots = useLoadingDots(toolCall.status === 'in_progress');
    
    // Global state updater for annotation status changes
    const setAnnotationState = useSetAtom(updateToolcallAnnotationAtom);

    // Extract annotations from tool call result
    const annotations = (toolCall.annotations as ToolAnnotation[]) || [];
    const totalAnnotations = annotations.length;

    // Is the current reader attachment key the same as the attachment key for annotations
    const isAttachmentOpen = annotations.some((annotation) => annotation.attachment_key === currentReaderAttachmentKey);

    // Compute overall state of all annotations
    const allPending = annotations.every((annotation) => annotation.status === 'pending');
    const allErrors = annotations.every((annotation) => annotation.status === 'error');
    const hasErrors = annotations.some((annotation) => annotation.status === 'error');

    // Toggle visibility of annotation list (only when tool call is completed and has processable annotations)
    const toggleResults = useCallback(() => {
        if (toolCall.status === 'completed' && totalAnnotations > 0) {
            setResultsVisible((prev) => !prev);
        }
    }, [toolCall.status, totalAnnotations, allPending]);

    // Helper to update annotation state in global store
    const updateAnnotationState = useCallback(
        (annotationId: string | undefined, updates: Partial<ToolAnnotation>) => {
            setAnnotationState({
                messageId,
                toolcallId: toolCall.id,
                annotationId,
                updates,
            });
        },
        [messageId, setAnnotationState, toolCall.id]
    );

    /**
     * Handle applying annotations
     * This function is called when the user clicks the apply button
     */
    const handleApplyAnnotations = useCallback(async () => {
        // Open attachment if not already open
        if (!isAttachmentOpen) {
            const attachmentItem = await Zotero.Items.getByLibraryAndKeyAsync(
                annotations[0].library_id,
                annotations[0].attachment_key
            );
            if (!attachmentItem) return;
            // Get the minimum page index of all annotations
            const pageIndexes = annotations.map((a) => {
                return a.annotation_type === 'note'
                    ? a.note_position?.pageIndex
                    : a.highlight_locations?.[0]?.pageIndex;
            });
            const minPageIndex = Math.min(...pageIndexes.filter((idx) => typeof idx === 'number'));
            
            // Navigate to the minimum page index
            await navigateToPage(attachmentItem.id, minPageIndex);
        }

        // Apply annotations
        const reader = getCurrentReader() as ZoteroReader | undefined;
        if (!reader) return;
        for (const annotation of annotations) {
            const result = await applyAnnotation(annotation, reader);
            if (result.updated) {
                // TODO: batch apply to minimize re-renders
                updateAnnotationState(annotation.id, result.annotation);
            }
        }

        // Show the annotations
        setResultsVisible(true);

    }, [isAttachmentOpen, annotations]);

    /**
     * Validate applied annotations
     *
     * validateAppliedAnnotation checks if an annotation that's marked as 'applied'
     * still exists in Zotero. This handles the case where the annotation was applied
     * but manually deleted from Zotero by the user.
     */
    useEffect(() => {
        const validateAppliedAnnotations = async () => {
            const appliedAnnotations = annotations.filter((a: ToolAnnotation) => a.status === 'applied');
            for (const annotation of appliedAnnotations) {

                // Skip if annotation was modified in last 10 seconds
                if (annotation.modified_at) {
                    const timeSinceModified = Date.now() - new Date(annotation.modified_at).getTime();
                    if (timeSinceModified < 10000) { // 10 seconds
                        console.log('validationResult: skipping because modified in last 10 seconds');
                        continue;
                    }
                }

                // Validate annotation
                const validationResult = await validateAppliedAnnotation(annotation);
                if (validationResult.markAsDeleted) {
                    console.log('validationResult: markAsDeleted');
                    // Annotation was marked as applied but no longer exists - mark as deleted
                    updateAnnotationState(annotation.id, {
                        status: 'deleted',
                        zotero_key: undefined,
                        error_message: null,
                    });
                }
                // If validationResult.key exists, annotation is still valid - no action needed
                continue;
            }
        };

        validateAppliedAnnotations();
    }, [annotations, updateAnnotationState]);

    /**
     * Navigate to an annotation on annotation click
     */
    const handleAnnotationClick = useCallback(
        async (annotation: ToolAnnotation) => {
            // Navigate to annotation if it exists
            if (annotation.status === 'applied' && annotation.zotero_key) {
                const annotationItem =
                    await Zotero.Items.getByLibraryAndKeyAsync(
                        annotation.library_id,
                        annotation.zotero_key
                    );
                if (!annotationItem) return;
                await navigateToAnnotation(annotationItem);

            // Re-add annotation if it was deleted
            } else if (annotation.status === 'deleted') {
                // await handleReAddAnnotation(annotation);
            }
        },
        [updateAnnotationState]
    );

    /**
     * Handle deleting an annotation from the PDF
     * If annotation exists in PDF, deletes it; otherwise just marks as deleted
     */
    const handleDelete = useCallback(
        async (annotation: ToolAnnotation) => {
            setBusyState((prev) => ({ ...prev, [annotation.id]: true }));
            try {
                if (
                    annotation.status !== 'applied' ||
                    !annotation.zotero_key
                ) {
                    // Annotation not yet applied to PDF - just mark as deleted
                    updateAnnotationState(annotation.id, {
                        status: 'deleted',
                    });
                } else {
                    // deleteAnnotationFromReader: Removes annotation from PDF reader
                    await deleteAnnotationFromReader(annotation);
                    updateAnnotationState(annotation.id, {
                        status: 'deleted',
                    });
                }
            } catch (error: any) {
                updateAnnotationState(annotation.id, {
                    status: 'error',
                    error_message:
                        error?.message || 'Failed to delete annotation',
                });
            } finally {
                setBusyState((prev) => ({
                    ...prev,
                    [annotation.id]: false,
                }));
            }
        },
        [updateAnnotationState]
    );

    // Re-add a deleted annotation by treating it like a click
    const handleReAddAnnotation = useCallback(
        async (annotation: ToolAnnotation) => {
            await handleAnnotationClick(annotation);
        },
        [handleAnnotationClick]
    );

    // Determine which icon to show based on tool call and UI state
    const getIcon = () => {
        if (toolCall.status === 'in_progress') return Spinner;
        if (toolCall.status === 'error' || allErrors) return AlertIcon;
        if (toolCall.status === 'completed') {
            if (resultsVisible) return ArrowDownIcon;
            if (isButtonHovered && totalAnnotations > 0) return ArrowRightIcon;
            if (totalAnnotations === 0) return AlertIcon;
            return <ZoteroIcon icon={ZOTERO_ICONS.ANNOTATION} size={12} className="flex-shrink-0" />;
        }
        return <ZoteroIcon icon={ZOTERO_ICONS.ANNOTATION} size={12} className="flex-shrink-0" />;
    };

    // Generate button text showing annotation count
    const getButtonText = () => {
        const label = `${totalAnnotations} Annotations`;
        return label;
    };

    // Determine when the results can be toggled and when button should be disabled
    const hasAnnotationsToShow = totalAnnotations > 0;
    const canToggleResults = toolCall.status === 'completed' && hasAnnotationsToShow;
    const isButtonDisabled = toolCall.status === 'in_progress' || toolCall.status === 'error' || (toolCall.status === 'completed' && !hasAnnotationsToShow);

    // Determine when to show apply button
    const showApplyButton = toolCall.status === 'completed' && allPending;
    

    return (
        <div
            id={`tool-${toolCall.id}`}
            className={`${resultsVisible ? 'border-popup' : 'border-quinary'} rounded-md display-flex flex-col min-w-0`}
        >
            {/* Main button that shows annotation count and toggles visibility */}
            <div
                className={`display-flex flex-row bg-senary py-15 ${resultsVisible ? 'border-bottom-quinary' : ''}`}
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
                            text-base scale-105 ml-2
                            ${isButtonDisabled && !canToggleResults ? 'disabled-but-styled' : ''}
                            ${toolCall.status === 'error' ? 'font-color-warning' : ''}
                        `}
                        disabled={isButtonDisabled && !canToggleResults}
                    >
                        {getButtonText()}
                    </Button>
                    <div className="flex-1"/>
                </div>
                {showApplyButton && (
                    <Button
                        rightIcon={PlayIcon}
                        iconClassName="-ml-015"
                        className="mr-015"
                        variant="ghost-secondary"
                        onClick={handleApplyAnnotations}
                    >
                        Apply
                    </Button>
                )}
            </div>

            {/* Expandable list of individual annotations */}
            {resultsVisible && hasAnnotationsToShow && toolCall.status === 'completed' && (
                <div className={`py-15 mt-15`}>
                    <div className="display-flex flex-col gap-1">
                        {annotations.map((annotation) => (
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
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default AnnotationToolCallDisplay;