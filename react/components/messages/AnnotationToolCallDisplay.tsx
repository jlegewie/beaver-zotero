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
    resolveExistingAnnotationKey,
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


const AnnotationToolCallDisplay: React.FC<AnnotationToolCallDisplayProps> = ({ messageId, toolCall }) => {
    const [resultsVisible, setResultsVisible] = useState(false);
    const [busyState, setBusyState] = useState<Record<string, boolean>>({});
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const loadingDots = useLoadingDots(toolCall.status === 'in_progress');
    const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
    const setAnnotationState = useSetAtom(updateToolcallAnnotationAtom);

    // Get annotations from tool call
    const annotations = (toolCall.annotations as ToolAnnotation[]) || [];
    const totalAnnotations = annotations.length;

    // Tool call state
    const allPending = annotations.every((annotation) => annotation.status === 'pending');
    const hasErrors = annotations.some((annotation) => annotation.status === 'error');

    const toggleResults = useCallback(() => {
        // Only allow toggling if completed and has annotations
        if (toolCall.status === 'completed' && totalAnnotations > 0) {
            setResultsVisible((prev) => !prev);
        }
    }, [toolCall.status, totalAnnotations]);

    const markAnnotationState = useCallback(
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

    useEffect(() => {
        let cancelled = false;

        const applyPendingAnnotations = async () => {
            for (const annotation of annotations) {
                if (cancelled) return;
                if (annotation.status === 'deleted') continue;
                if (annotation.status === 'applied') continue;
                if (annotation.status === 'error') continue;

                const existingKey =
                    await resolveExistingAnnotationKey(annotation);
                if (cancelled) return;
                if (existingKey) {
                    markAnnotationState(annotation.id, {
                        status: 'applied',
                        error_message: null,
                        zotero_key: existingKey,
                    });
                    continue;
                }

                setBusyState((prev) => ({ ...prev, [annotation.id]: true }));
                const result = await applyAnnotation(annotation);
                if (cancelled) {
                    setBusyState((prev) => ({
                        ...prev,
                        [annotation.id]: false,
                    }));
                    return;
                }

                if (result.status === 'applied') {
                    markAnnotationState(annotation.id, {
                        status: 'applied',
                        error_message: null,
                        zotero_key: result.zotero_key,
                    });
                } else if (result.status === 'pending') {
                    // Do nothing, wait for user interaction or reader to open
                } else {
                    markAnnotationState(annotation.id, {
                        status: 'error',
                        error_message:
                            result.reason || 'Failed to create annotation',
                    });
                }
                setBusyState((prev) => ({ ...prev, [annotation.id]: false }));
            }
        };

        applyPendingAnnotations();

        return () => {
            cancelled = true;
        };
    }, [annotations, markAnnotationState]);

    const handleAnnotationClick = useCallback(
        async (annotation: ToolAnnotation) => {
            setBusyState((prev) => ({ ...prev, [annotation.id]: true }));

            let existingKey = annotation.zotero_key;
            if (!existingKey) {
                logger(
                    `handleAnnotationClick: Resolving existing annotation key for ${annotation.id}`
                );
                existingKey =
                    (await resolveExistingAnnotationKey(annotation)) ||
                    undefined;
            }

            if (existingKey) {
                logger(
                    `handleAnnotationClick: Existing annotation key found for ${annotation.id} (${existingKey})`
                );
                markAnnotationState(annotation.id, {
                    status: 'applied',
                    error_message: null,
                    zotero_key: existingKey,
                });
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

            const attemptApply = async () => {
                logger(
                    `handleAnnotationClick: Attempting to apply annotation ${annotation.id}`
                );
                let result = await applyAnnotation(annotation);
                if (result.status === 'pending') {
                    logger(
                        `handleAnnotationClick: Annotation ${annotation.id} is pending, opening attachment`
                    );
                    await openAttachmentForAnnotation(annotation);
                    result = await applyAnnotation(annotation);
                }
                return result;
            };

            const result = await attemptApply();

            if (result.status === 'applied') {
                logger(
                    `handleAnnotationClick: Annotation ${annotation.id} is applied`
                );
                markAnnotationState(annotation.id, {
                    status: 'applied',
                    error_message: null,
                    zotero_key: result.zotero_key,
                });
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
                markAnnotationState(annotation.id, {
                    status: 'error',
                    error_message:
                        result.reason || 'Failed to create annotation',
                });
            }

            setBusyState((prev) => ({ ...prev, [annotation.id]: false }));
        },
        [markAnnotationState]
    );

    const handleDelete = useCallback(
        async (annotation: ToolAnnotation) => {
            setBusyState((prev) => ({ ...prev, [annotation.id]: true }));
            try {
                if (
                    annotation.status !== 'applied' ||
                    !annotation.zotero_key
                ) {
                    markAnnotationState(annotation.id, {
                        status: 'deleted',
                    });
                } else {
                    await deleteAnnotationFromReader(annotation);
                    markAnnotationState(annotation.id, {
                        status: 'deleted',
                    });
                }
            } catch (error: any) {
                markAnnotationState(annotation.id, {
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
        [markAnnotationState]
    );

    const handleReAddAnnotation = useCallback(
        async (annotation: ToolAnnotation) => {
            await handleAnnotationClick(annotation);
        },
        [handleAnnotationClick]
    );

    // Updated icon logic to return JSX elements directly
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

    // Updated button text logic to match regular tool calls
    const getButtonText = () => {
        const label = `${totalAnnotations} ${toolCall.label || 'Annotations'}`;
        return label;
    };

    // Updated logic for when results can be toggled and button is disabled
    const hasAnnotationsToShow = totalAnnotations > 0;
    const canToggleResults = toolCall.status === 'completed' && hasAnnotationsToShow;
    const isButtonDisabled = toolCall.status === 'in_progress' || toolCall.status === 'error' || (toolCall.status === 'completed' && !hasAnnotationsToShow);

    return (
        <div
            id={`tool-${toolCall.id}`}
            className={`${resultsVisible ? 'border-popup' : 'border-transparent'} rounded-md flex flex-col min-w-0 py-1`}
        >
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

            {/* Only show annotations when expanded and completed */}
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