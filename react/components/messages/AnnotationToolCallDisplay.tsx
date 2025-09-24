import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { ToolCall } from '../../types/chat/apiTypes';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Icon,
    DeleteIcon,
    PlayIcon,
    TickIcon
} from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import { ToolAnnotation } from '../../types/chat/toolAnnotations';
import {
    applyAnnotation,
    deleteAnnotationFromReader,
    validateAppliedAnnotation,
} from '../../utils/toolAnnotationActions';
import { getCurrentReaderAndWaitForView, navigateToAnnotation, navigateToPage} from '../../utils/readerUtils';
import { getToolCallAnnotationsAtom, updateToolcallAnnotationAtom, updateToolcallAnnotationsAtom, AnnotationUpdates } from '../../atoms/toolAnnotations';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { logger } from '../../../src/utils/logger';
import { useLoadingDots } from '../../hooks/useLoadingDots';
import { ZoteroReader } from '../../utils/annotationUtils';
import { currentReaderAttachmentKeyAtom } from '../../atoms/input';
import { shortItemTitle } from '../../../src/utils/zoteroUtils';
import { toolAnnotationsService } from '../../../src/services/toolAnnotationsService';

interface AnnotationListItemProps {
    annotation: ToolAnnotation;
    isBusy: boolean;
    onClick: (annotation: ToolAnnotation) => Promise<void>;
    onDelete: (annotation: ToolAnnotation) => Promise<void>;
    onReAdd: (annotation: ToolAnnotation) => Promise<void>;
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
            if (annotation.status === 'deleted' || annotation.status === 'pending') {
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
    const hasApplicationError = annotation.status !== 'error';

    // Icon color
    let iconColor = annotation.status === 'deleted' || annotation.status === 'pending'
        ? 'font-color-tertiary'
        : 'font-color-secondary';
    iconColor = annotation.color ? `font-color-${annotation.color}` : iconColor;
    iconColor = annotation.status === 'error' ? 'font-color-secondary' : iconColor;

    const baseClasses = [
        'px-3',
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
        if (annotation.status === 'deleted') return 'font-color-tertiary line-through';
        if (annotation.status === 'pending') return 'font-color-tertiary';
        return 'font-color-secondary';
    }

    if (isHovered) {
        baseClasses.push('bg-quinary');
    }
    if (annotation.status === 'deleted' || annotation.status === 'error') {
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
                        {annotation.title || 'Annotation'}
                        {annotation.status === 'applied' &&
                            <Icon icon={TickIcon} className="-mb-015 ml-2 font-color-secondary scale-12" />
                        }
                    </div>
                </div>
                {(annotation.status === 'applied') && (
                    <div className={`display-flex flex-row items-center gap-2 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-secondary"
                            // onClick={annotation.status === 'applied' ? handleDelete : handleApplyAnnotation}
                            onClick={handleAction}
                            className="p-1"
                            title='Delete annotation'
                            icon={DeleteIcon}
                            loading={isBusy}
                        />
                    </div>
                )}
                {(annotation.status === 'deleted' || annotation.status === 'pending') && (
                    <div className={`display-flex flex-row items-center gap-2 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-secondary"
                            onClick={handleAction}
                            className="p-1"
                            title='Apply annotation'
                            icon={PlayIcon}
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
    const getToolCallAnnotations = useAtomValue(getToolCallAnnotationsAtom);

    // Current reader state
    const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);

    // UI state for collapsible annotation list
    const [resultsVisible, setResultsVisible] = useState(true);
    
    // Track which individual annotations are currently being processed
    const [isApplyingAnnotations, setIsApplyingAnnotations] = useState(false);
    const [busyState, setBusyState] = useState<Record<string, boolean>>({});
    const [attachmentTitle, setAttachmentTitle] = useState<string | null>(null);
    const attachmentTitleKeyRef = useRef<string | null>(null);

    // Track hover states for UI interactions
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
    
    // Loading animation for in-progress tool calls
    const loadingDots = useLoadingDots(toolCall.status === 'in_progress');
    
    // Global state updater for annotation status changes
    const setAnnotationState = useSetAtom(updateToolcallAnnotationAtom);
    const updateAnnotationsInBatch = useSetAtom(updateToolcallAnnotationsAtom);

    // Extract annotations from tool call result
    const annotations = getToolCallAnnotations(toolCall.id);
    const totalAnnotations = annotations.length;

    // Is the current reader attachment key the same as the attachment key for annotations
    const isAttachmentOpen = annotations.some((annotation) => annotation.attachment_key === currentReaderAttachmentKey);

    // Compute overall state of all annotations
    const somePending = annotations.some((annotation) => annotation.status === 'pending');
    const someErrors = annotations.some((annotation) => annotation.status === 'error');
    const appliedAnnotationCount = annotations.filter((annotation) => annotation.status === 'applied').length;
    const allErrors = annotations.every((annotation) => annotation.status === 'error');

    // Toggle visibility of annotation list (only when tool call is completed and has processable annotations)
    const toggleResults = useCallback(() => {
        if (toolCall.status === 'completed' && totalAnnotations > 0) {
            setResultsVisible((prev) => !prev);
        }
    }, [toolCall.status, totalAnnotations]);

    // Helper to update annotation state in global store
    const updateAnnotationState = useCallback(
        (annotationId: string | undefined, updates: Partial<ToolAnnotation>) => {
            setAnnotationState({
                toolcallId: toolCall.id,
                annotationId,
                updates,
            });
        },
        [setAnnotationState, toolCall.id]
    );

    /**
     * Handle applying annotations
     * This function is called when the user clicks the apply button
     */
    const handleApplyAnnotations = useCallback(async (annotationId?: string) => {
        if (annotations.length === 0) return;
        setIsApplyingAnnotations(true);

        try {
            // Open attachment if not already open
            if (!isAttachmentOpen) {
                const attachmentItem = await Zotero.Items.getByLibraryAndKeyAsync(
                    annotations[0].library_id,
                    annotations[0].attachment_key
                );
                if (!attachmentItem) {
                    const errorMessage = 'Attachment not found';
                    const errorUpdates = annotations
                        .filter(a => !annotationId || a.id === annotationId)
                        .map(annotation => ({
                            annotationId: annotation.id,
                            updates: {
                                status: 'error' as const,
                                error_message: errorMessage,
                                modified_at: new Date().toISOString(),
                            },
                        })) as AnnotationUpdates[];

                    if (errorUpdates.length > 0) {
                        updateAnnotationsInBatch({
                            toolcallId: toolCall.id,
                            updates: errorUpdates,
                        });

                        await Promise.all(
                            errorUpdates.map((update) =>
                                toolAnnotationsService.updateAnnotation(update.annotationId, {
                                    status: 'error',
                                    error_message: errorMessage,
                                }).catch((error) => {
                                    logger(`handleApplyAnnotations: failed to persist attachment error for annotation ${update.annotationId}: ${error}`, 1);
                                })
                            )
                        );
                    }

                    setIsApplyingAnnotations(false);
                    return;
                }

                // Get the minimum page index of all annotations
                const pageIndexes = annotations.map((a) => (
                    a.annotation_type === 'note'
                        ? a.note_position?.pageIndex
                        : a.highlight_locations?.[0]?.pageIndex
                ));
                const minPageIndex = Math.min(...pageIndexes.filter((idx) => typeof idx === 'number'));

                // Navigate to the minimum page index
                await navigateToPage(attachmentItem.id, minPageIndex + 1);
            }

            // Get the current reader and wait for the view to be initialized
            const reader = await getCurrentReaderAndWaitForView() as ZoteroReader | undefined;
            if (!reader) {
                setIsApplyingAnnotations(false);
                return;
            }

            // Filter annotations to apply
            const annotationsToApply = annotations.filter(annotation => {
                if (annotation.status === 'applied') return false;
                if (annotationId && annotation.id !== annotationId) return false;
                return true;
            });

            if (annotationsToApply.length === 0) {
                setIsApplyingAnnotations(false);
                return;
            }

            type ApplyResult = {
                update: AnnotationUpdates | null;
                updatedAnnotation: ToolAnnotation;
            };

            const applyResults: ApplyResult[] = await Promise.all(
                annotationsToApply.map(async (annotation) => {
                    try {
                        const result = await applyAnnotation(annotation, reader);
                        if (!result.updated) {
                            return { update: null, updatedAnnotation: annotation };
                        }

                        const updatedAnnotation: ToolAnnotation = {
                            ...result.annotation,
                            ...(result.annotation.status === 'error' && !result.annotation.error_message
                                ? { error_message: result.error || 'Failed to create annotation' }
                                : {}),
                        };

                        if (updatedAnnotation.status === 'applied') {
                            logger(`handleApplyAnnotations: applied annotation ${annotation.id}: ${JSON.stringify(updatedAnnotation)}`, 1);
                        }

                        return {
                            update: {
                                annotationId: annotation.id,
                                updates: updatedAnnotation,
                            },
                            updatedAnnotation,
                        };
                    } catch (error: any) {
                        const errorMessage = error?.message || 'Failed to apply annotation';
                        logger(`handleApplyAnnotations: failed to apply annotation ${annotation.id}: ${errorMessage}`, 1);
                        const updatedAnnotation: ToolAnnotation = {
                            ...annotation,
                            status: 'error',
                            error_message: errorMessage,
                            modified_at: new Date().toISOString(),
                        };

                        return {
                            update: {
                                annotationId: annotation.id,
                                updates: updatedAnnotation,
                            },
                            updatedAnnotation,
                        };
                    }
                })
            );

            const batchUpdates = applyResults
                .map(result => result.update)
                .filter((update): update is AnnotationUpdates => update !== null);

            if (batchUpdates.length > 0) {
                updateAnnotationsInBatch({
                    toolcallId: toolCall.id,
                    updates: batchUpdates,
                });
            }

            setResultsVisible(true);

            const ackErrorIds = new Set<string>();
            const annotationsToAcknowledge = applyResults
                .map(result => result.updatedAnnotation)
                .filter(annotation => annotation.status === 'applied' && Boolean(annotation.zotero_key));

            if (annotationsToAcknowledge.length > 0) {
                try {
                    const response = await toolAnnotationsService.markAnnotationsApplied(
                        messageId,
                        toolCall.id,
                        annotationsToAcknowledge.map(annotation => ({
                            annotationId: annotation.id,
                            zoteroKey: annotation.zotero_key as string,
                        }))
                    );

                    if (response.errors.length > 0) {
                        const ackErrorUpdates: AnnotationUpdates[] = response.errors.map((ackError) => {
                            ackErrorIds.add(ackError.annotation_id);
                            return {
                                annotationId: ackError.annotation_id,
                                updates: {
                                    status: 'error',
                                    error_message: ackError.detail,
                                    modified_at: new Date().toISOString(),
                                },
                            };
                        });

                        updateAnnotationsInBatch({
                            toolcallId: toolCall.id,
                            updates: ackErrorUpdates,
                        });

                        await Promise.all(
                            response.errors.map((ackError) =>
                                toolAnnotationsService.updateAnnotation(ackError.annotation_id, {
                                    status: 'error',
                                    error_message: ackError.detail,
                                }).catch((error) => {
                                    logger(`handleApplyAnnotations: failed to persist ack error for annotation ${ackError.annotation_id}: ${error}`, 1);
                                })
                            )
                        );
                    }
                } catch (ackError: any) {
                    logger(`handleApplyAnnotations: failed to acknowledge annotations: ${ackError?.message || ackError}`, 1);
                }
            }

            const errorAnnotationsForBackend = applyResults
                .map(result => result.updatedAnnotation)
                .filter(annotation => annotation.status === 'error' && !ackErrorIds.has(annotation.id));

            if (errorAnnotationsForBackend.length > 0) {
                await Promise.all(
                    errorAnnotationsForBackend.map(annotation =>
                        toolAnnotationsService.updateAnnotation(annotation.id, {
                            status: 'error',
                            error_message: annotation.error_message || 'Failed to apply annotation',
                        }).catch((error) => {
                            logger(`handleApplyAnnotations: failed to persist error status for annotation ${annotation.id}: ${error}`, 1);
                        })
                    )
                );
            }

            setIsApplyingAnnotations(false);

            const firstAppliedResult = applyResults.find(
                (result) =>
                    result.updatedAnnotation.status === 'applied' &&
                    result.updatedAnnotation.zotero_key &&
                    !ackErrorIds.has(result.updatedAnnotation.id)
            );

            if (firstAppliedResult) {
                const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
                    firstAppliedResult.updatedAnnotation.library_id,
                    firstAppliedResult.updatedAnnotation.zotero_key as string
                );
                if (annotationItem) {
                    await navigateToAnnotation(annotationItem);
                }
            }

        } catch (error) {
            logger(`handleApplyAnnotations: unexpected error: ${error}`, 1);
            setIsApplyingAnnotations(false);
        }
    }, [isAttachmentOpen, annotations, toolCall.id, updateAnnotationsInBatch, messageId]);

    useEffect(() => {
        const getAttachmentTitle = async () => {
            // Guard clause
            if (annotations.length === 0) return;
            if(attachmentTitleKeyRef.current === annotations[0].attachment_key) return;
            attachmentTitleKeyRef.current = annotations[0].attachment_key;

            const attachmentItem = await Zotero.Items.getByLibraryAndKeyAsync(annotations[0].library_id, annotations[0].attachment_key);
            if (!attachmentItem) return;
            const title = await shortItemTitle(attachmentItem);
            setAttachmentTitle(title);
        };
        getAttachmentTitle();
    }, [annotations]);

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
                        logger('validationResult: skipping because modified in last 10 seconds');
                        continue;
                    }
                }

                // Validate annotation
                const validationResult = await validateAppliedAnnotation(annotation);
                if (validationResult.markAsDeleted) {
                    logger('validationResult: marking as deleted');
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
            } else if (annotation.status === 'deleted' || annotation.status === 'pending') {
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
                    await toolAnnotationsService.updateAnnotation(annotation.id, {
                        status: 'deleted',
                        error_message: null,
                    }).catch((error) => {
                        logger(`handleDelete: failed to persist deleted status for annotation ${annotation.id}: ${error}`, 1);
                    });
                } else {
                    // deleteAnnotationFromReader: Removes annotation from PDF reader
                    await deleteAnnotationFromReader(annotation);
                    updateAnnotationState(annotation.id, {
                        status: 'deleted',
                    });
                    await toolAnnotationsService.updateAnnotation(annotation.id, {
                        status: 'deleted',
                        zotero_key: '',  // set to null in backend
                        error_message: null,
                    }).catch((error) => {
                        logger(`handleDelete: failed to persist deleted status for annotation ${annotation.id}: ${error}`, 1);
                    });
                }
            } catch (error: any) {
                const errorMessage = error?.message || 'Failed to delete annotation';
                updateAnnotationState(annotation.id, {
                    status: 'error',
                    error_message: errorMessage,
                });
                await toolAnnotationsService.updateAnnotation(annotation.id, {
                    status: 'error',
                    error_message: errorMessage,
                }).catch((persistError) => {
                    logger(`handleDelete: failed to persist error status for annotation ${annotation.id}: ${persistError}`, 1);
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
        if (toolCall.status === 'in_progress' || isApplyingAnnotations) return Spinner;
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
        if (toolCall.status === 'in_progress') {
            return `Annotations${''.padEnd(loadingDots, '.')}`;
        }
        if (toolCall.status === 'error') {
            return 'Annotations: Error';
        }
        return 'Annotations';
    };

    // Determine when the results can be toggled and when button should be disabled
    const hasAnnotationsToShow = totalAnnotations > 0;
    const canToggleResults = toolCall.status === 'completed' && hasAnnotationsToShow && !allErrors;
    const isButtonDisabled = toolCall.status === 'in_progress' || toolCall.status === 'error' || (toolCall.status === 'completed' && !hasAnnotationsToShow);

    // Determine when to show apply button
    const showApplyButton = toolCall.status === 'completed' && (somePending || someErrors) && !isApplyingAnnotations;
    
    return (
        <div
            id={`tool-${toolCall.id}`}
            className={`${resultsVisible && hasAnnotationsToShow ? 'border-popup' : 'border-quinary'} rounded-md display-flex flex-col min-w-0`}
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
                            ${toolCall.status === 'error' ? 'font-color-warning' : ''}
                        `}
                        disabled={isButtonDisabled && !canToggleResults}
                    >
                        <span>{getButtonText()}</span>
                        {toolCall.status === 'completed' && appliedAnnotationCount > 0 && hasAnnotationsToShow &&
                            <span className="ml-05 mt-015 font-color-green text-xs">+{appliedAnnotationCount}</span>
                        }
                        {toolCall.status === 'completed' && appliedAnnotationCount === 0 && hasAnnotationsToShow &&
                            <span className="ml-05 mt-015 font-color-tertiary text-xs">{totalAnnotations}x</span>
                        }
                    </Button>
                    <div className="flex-1"/>
                </div>
                {showApplyButton ? (
                    <Button
                        icon={PlayIcon}
                        iconClassName="-mr-015"
                        variant="ghost-tertiary"
                        onClick={() => handleApplyAnnotations()}
                    >
                        <span className="text-sm truncate" style={{ maxWidth: '125px' }}>
                            {!isAttachmentOpen && attachmentTitle ? `Apply to ${attachmentTitle}` : 'Apply'}
                        </span>
                    </Button>
                ) : (
                    <div className="text-sm truncate font-color-tertiary mt-015" style={{ maxWidth: '125px' }}>
                        {attachmentTitle}
                    </div>
                )}
            </div>

            {/* Expandable list of individual annotations */}
            {resultsVisible && hasAnnotationsToShow && toolCall.status === 'completed' && (
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

export default AnnotationToolCallDisplay;
