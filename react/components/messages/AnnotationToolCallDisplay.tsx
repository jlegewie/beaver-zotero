import React, { useState, useEffect, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { ChatMessage } from '../../types/chat/uiTypes';
import { ToolCall } from '../../types/chat/apiTypes';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Icon,
    DeleteIcon,
    PlusSignIcon,
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
import { navigateToAnnotation } from '../../utils/readerUtils';
import {
    updateToolcallAnnotationAtom,
} from '../../atoms/threads';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { logger } from '../../../src/utils/logger';
import { useLoadingDots } from '../../hooks/useLoadingDots';

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

    const icon =
        annotation.annotation_type === 'note'
            ? ZOTERO_ICONS.ANNOTATE_NOTE
            : ZOTERO_ICONS.ANNOTATE_HIGHLIGHT;
    const hasApplicationError =
        Boolean(annotation.error_message) && annotation.status !== 'deleted';
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
                        {annotation.title || 'Annotation'}
                    </div>
                </div>
                <div className="display-flex flex-row items-center gap-2">
                    <IconButton
                        variant="ghost-secondary"
                        onClick={handleAction}
                        disabled={isBusy}
                        className="p-1"
                        title={
                            annotation.status === 'deleted'
                                ? 'Re-add annotation'
                                : 'Delete annotation from PDF'
                        }
                        icon={
                            annotation.status === 'deleted'
                                ? PlusSignIcon
                                : DeleteIcon
                        }
                        loading={isBusy}
                    />
                </div>
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

    // Compute overall state of all annotations
    const allPending = annotations.every((annotation) => annotation.status === 'pending');
    const hasErrors = annotations.some((annotation) => annotation.status === 'error');

    // Toggle visibility of annotation list (only when tool call is completed and has processable annotations)
    const toggleResults = useCallback(() => {
        if (toolCall.status === 'completed' && totalAnnotations > 0 && !allPending) {
            setResultsVisible((prev) => !prev);
        }
    }, [toolCall.status, totalAnnotations, allPending]);

    // Helper to update annotation state in global store
    const updateAnnotationState = useCallback(
        (annotationId: string, updates: Partial<ToolAnnotation>) => {
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
     * Main annotation processing effect - automatically processes pending annotations
     * This effect runs whenever annotations change and attempts to:
     * 1. Check if each annotation already exists in the PDF (validateAppliedAnnotation)
     * 2. If not, create the annotation in the PDF reader (applyAnnotation)
     */
    useEffect(() => {
        let cancelled = false;

        const applyPendingAnnotations = async () => {
            for (const annotation of annotations) {
                if (cancelled) return;
                
                // Skip annotations that don't need processing
                if (annotation.status === 'deleted') continue;
                if (annotation.status === 'error') continue;

                /**
                 * Validate annotations that are marked as applied
                 * 
                 * validateAppliedAnnotation checks if an annotation that's marked as 'applied'
                 * still exists in Zotero. This handles the case where the annotation was applied
                 * but manually deleted from Zotero by the user.
                 */
                if (annotation.status === 'applied') {
                    const validationResult = await validateAppliedAnnotation(annotation);
                    if (cancelled) return;
                    
                    if (validationResult.markAsDeleted) {
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

                // Process pending annotations
                if (annotation.status === 'pending') {
                    // Attempt to create new annotation in the PDF
                    setBusyState((prev) => ({ ...prev, [annotation.id]: true }));
                    
                    /**
                     * applyAnnotation: Attempts to create the annotation in the PDF reader.
                     * Returns status:
                     * - 'applied': Successfully created, includes zotero_key
                     * - 'pending': PDF reader not open/available, needs user interaction
                     * - 'error': Failed to create annotation
                     */
                    const result = await applyAnnotation(annotation);
                    
                    if (cancelled) {
                        setBusyState((prev) => ({
                            ...prev,
                            [annotation.id]: false,
                        }));
                        return;
                    }

                    // Update annotation state based on result
                    if (result.status === 'applied') {
                        updateAnnotationState(annotation.id, {
                            status: 'applied',
                            error_message: null,
                            zotero_key: result.zotero_key,
                        });
                    } else if (result.status === 'pending') {
                        // Do nothing, wait for user interaction or reader to open
                    } else {
                        updateAnnotationState(annotation.id, {
                            status: 'error',
                            error_message:
                                result.reason || 'Failed to create annotation',
                        });
                    }
                    setBusyState((prev) => ({ ...prev, [annotation.id]: false }));
                }
            }
        };

        applyPendingAnnotations();

        // Cleanup function to cancel ongoing operations if component unmounts
        return () => {
            cancelled = true;
        };
    }, [annotations, updateAnnotationState]);

    /**
     * Handle user clicking on an annotation item
     * Attempts to navigate to the annotation, creating it first if necessary
     */
    const handleAnnotationClick = useCallback(
        async (annotation: ToolAnnotation) => {
            setBusyState((prev) => ({ ...prev, [annotation.id]: true }));

            // First, check if we already have the annotation key
            let existingKey = annotation.zotero_key;
            if (!existingKey) {
                logger(
                    `handleAnnotationClick: Validating annotation for ${annotation.id}`
                );
                // validateAppliedAnnotation: Check if annotation exists in PDF
                const result = await validateAppliedAnnotation(annotation);
                
                if (result.markAsDeleted) {
                    // Annotation was marked as applied but no longer exists
                    updateAnnotationState(annotation.id, {
                        status: 'deleted',
                        error_message: null,
                    });
                    setBusyState((prev) => ({
                        ...prev,
                        [annotation.id]: false,
                    }));
                    return;
                }
                
                existingKey = result.key || undefined;
            }

            // If annotation exists, navigate to it
            if (existingKey) {
                logger(
                    `handleAnnotationClick: Existing annotation key found for ${annotation.id} (${existingKey})`
                );
                updateAnnotationState(annotation.id, {
                    status: 'applied',
                    error_message: null,
                    zotero_key: existingKey,
                });
                
                // Get the Zotero annotation item and navigate to it
                const annotationItem =
                    await Zotero.Items.getByLibraryAndKeyAsync(
                        annotation.library_id,
                        existingKey
                    );
                if (!annotationItem) return;
                await navigateToAnnotation(annotationItem);
                setBusyState((prev) => ({
                    ...prev,
                    [annotation.id]: false,
                }));
                return;
            }

            // Annotation doesn't exist yet - try to create it
            const attemptApply = async () => {
                logger(
                    `handleAnnotationClick: Attempting to apply annotation ${annotation.id}`
                );
                let result = await applyAnnotation(annotation);
                
                // If pending (reader not open), open the PDF and try again
                if (result.status === 'pending') {
                    logger(
                        `handleAnnotationClick: Annotation ${annotation.id} is pending, opening attachment`
                    );
                    // openAttachmentForAnnotation: Opens the PDF in Zotero reader
                    await openAttachmentForAnnotation(annotation);
                    result = await applyAnnotation(annotation);
                }
                return result;
            };

            const result = await attemptApply();

            // Handle the result of annotation creation
            if (result.status === 'applied') {
                logger(
                    `handleAnnotationClick: Annotation ${annotation.id} is applied`
                );
                updateAnnotationState(annotation.id, {
                    status: 'applied',
                    error_message: null,
                    zotero_key: result.zotero_key,
                });
                
                // Navigate to the newly created annotation
                const annotationItem =
                    await Zotero.Items.getByLibraryAndKeyAsync(
                        annotation.library_id,
                        result.zotero_key
                    );
                if (!annotationItem) return;
                await navigateToAnnotation(annotationItem);
            } else if (result.status === 'pending') {
                logger(
                    `handleAnnotationClick: Annotation ${annotation.id} is pending, opening attachment`
                );
                // The logic to open the attachment is already handled inside attemptApply
            } else {
                logger(
                    `handleAnnotationClick: Annotation ${annotation.id} has error, setting error`
                );
                updateAnnotationState(annotation.id, {
                    status: 'error',
                    error_message:
                        result.reason || 'Failed to create annotation',
                });
            }

            setBusyState((prev) => ({ ...prev, [annotation.id]: false }));
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
        if (toolCall.status === 'in_progress') return <Icon icon={Spinner} />;
        if (toolCall.status === 'error') return <Icon icon={AlertIcon} />;
        if (toolCall.status === 'completed') {
            if (resultsVisible) return <Icon icon={ArrowDownIcon} />;
            if (isButtonHovered && totalAnnotations > 0) return <Icon icon={ArrowRightIcon} />;
            if (totalAnnotations === 0) return <Icon icon={AlertIcon} />;
            if (hasErrors) return <Icon icon={AlertIcon} />;
            return <ZoteroIcon icon={ZOTERO_ICONS.ANNOTATION} size={12} className="flex-shrink-0" />;
        }
        return <ZoteroIcon icon={ZOTERO_ICONS.ANNOTATION} size={12} className="flex-shrink-0" />;
    };

    // Generate button text showing annotation count
    const getButtonText = () => {
        const label = `${totalAnnotations} ${toolCall.label || 'Annotations'}`;
        return label;
    };

    // Determine when the results can be toggled and when button should be disabled
    const hasAnnotationsToShow = totalAnnotations > 0;
    const canToggleResults = toolCall.status === 'completed' && hasAnnotationsToShow;
    const isButtonDisabled = toolCall.status === 'in_progress' || toolCall.status === 'error' || (toolCall.status === 'completed' && !hasAnnotationsToShow);

    return (
        <div
            id={`tool-${toolCall.id}`}
            className={`${resultsVisible ? 'border-popup' : 'border-transparent'} rounded-md flex flex-col min-w-0 py-1`}
        >
            {/* Main button that shows annotation count and toggles visibility */}
            <Button
                variant="ghost-secondary"
                onClick={toggleResults}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
                className={`
                    text-base scale-105 w-full min-w-0 align-start text-left
                    ${isButtonDisabled && !canToggleResults ? 'disabled-but-styled' : ''}
                    ${toolCall.status === 'error' ? 'font-color-warning' : ''}
                `}
                style={{ padding: '2px 6px', maxHeight: 'none'}}
                disabled={isButtonDisabled && !canToggleResults}
            >
                <div className="display-flex flex-row px-3 gap-2">
                    <div className={`flex-1 display-flex mt-020 ${resultsVisible ? 'font-color-primary' : ''}`}>
                        {getIcon()}
                    </div>
                    <div className={`display-flex ${resultsVisible ? 'font-color-primary' : ''}`}>
                        {getButtonText()}
                    </div>
                </div>
            </Button>

            {/* Expandable list of individual annotations */}
            {resultsVisible && hasAnnotationsToShow && toolCall.status === 'completed' && (
                <div className={`py-1 ${resultsVisible ? 'border-top-quinary' : ''} mt-15`}>
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