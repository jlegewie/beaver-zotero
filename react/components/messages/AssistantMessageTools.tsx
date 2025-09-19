import React, { useState, useEffect, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { ChatMessage } from '../../types/chat/uiTypes';
import { ToolCall } from '../../types/chat/apiTypes';
import MarkdownRenderer from './MarkdownRenderer';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    SearchIcon,
    ViewIcon,
    Icon,
    DeleteIcon,
} from '../icons/icons';
import Button from '../ui/Button';
import ZoteroItemsList from '../ui/ZoteroItemsList';
import { isAnnotationTool, ToolAnnotationResult } from '../../types/chat/toolAnnotations';
import {
    applyAnnotation,
    deleteAnnotationFromReader,
    navigateToAnnotation,
    openAttachmentForAnnotation,
    resolveExistingAnnotationKey,
} from '../../utils/toolAnnotationActions';
import {
    updateToolcallAnnotationAtom,
} from '../../atoms/threads';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';

interface AssistantMessageToolsProps {
    message: ChatMessage;
    isFirstAssistantMessage: boolean;
    previousMessageHasToolCalls: boolean;
}

interface ToolCallDisplayProps {
    messageId: string;
    toolCall: ToolCall;
}

interface AnnotationListItemProps {
    annotation: ToolAnnotationResult;
    isBusy: boolean;
    onClick: (annotation: ToolAnnotationResult) => Promise<void>;
    onDelete: (annotation: ToolAnnotationResult) => Promise<void>;
}

const AnnotationListItem: React.FC<AnnotationListItemProps> = ({
    annotation,
    isBusy,
    onClick,
    onDelete,
}) => {
    const handleClick = useCallback(() => {
        if (isBusy) return;
        onClick(annotation);
    }, [annotation, isBusy, onClick]);

    const handleDelete = useCallback(
        (event: React.SyntheticEvent) => {
            event.stopPropagation();
            if (isBusy) return;
            onDelete(annotation);
        },
        [annotation, isBusy, onDelete]
    );

    const icon = annotation.annotationType === 'note' ? ZOTERO_ICONS.ANNOTATE_NOTE : ZOTERO_ICONS.ANNOTATE_HIGHLIGHT;
    const hasApplicationError = Boolean(annotation.applicationError) && !annotation.isDeleted;
    const iconColor = hasApplicationError ? 'font-color-warning' : 'font-color-secondary';
    const baseClasses = [
        'px-2',
        'py-1',
        'display-flex',
        'flex-col',
        'gap-1',
        // 'border-top-quinary',
        'cursor-pointer',
        'rounded-sm',
    ];

    if (annotation.pendingAttachmentOpen && !annotation.isApplied) {
        baseClasses.push('bg-quinary');
    }
    if (annotation.isDeleted) {
        baseClasses.push('opacity-60');
    }

    return (
        <div className={baseClasses.join(' ')} onClick={handleClick}>
            <div className="display-flex flex-row items-start gap-3">
                <ZoteroIcon icon={icon} size={13} className={`flex-shrink-0 mt-020 ${iconColor}`} />
                <div className="flex-1 min-w-0">
                    <div className={`${annotation.isDeleted ? 'font-color-tertiary line-through' : 'font-color-secondary'}`}>
                        {annotation.title || 'Annotation'}
                    </div>
                </div>
                <div className="display-flex flex-row items-center gap-2">
                    <Button
                        variant="ghost"
                        onClick={handleDelete}
                        disabled={isBusy}
                        className="p-1"
                        title={annotation.isDeleted ? 'Annotation deleted' : 'Delete annotation from PDF'}
                    >
                        {isBusy ? <Spinner /> : <Icon icon={DeleteIcon} />}
                    </Button>
                </div>
            </div>
            {annotation.pendingAttachmentOpen && !annotation.isApplied && !annotation.isDeleted && (
                <div className="text-xs font-color-tertiary">
                    Open the attachment to place this annotation
                </div>
            )}
        </div>
    );
};

interface AnnotationToolCallDisplayProps {
    messageId: string;
    toolCall: ToolCall;
}

const AnnotationToolCallDisplay: React.FC<AnnotationToolCallDisplayProps> = ({ messageId, toolCall }) => {
    const [resultsVisible, setResultsVisible] = useState(false); // Changed from true to false
    const [busyState, setBusyState] = useState<Record<string, boolean>>({});
    const [isButtonHovered, setIsButtonHovered] = useState(false); // Added for hover state
    const [loadingDots, setLoadingDots] = useState(1); // Added for loading animation
    const setAnnotationState = useSetAtom(updateToolcallAnnotationAtom);

    const annotations = toolCall.annotations || [];
    const totalAnnotations = annotations.length;
    const appliedAnnotations = annotations.filter((annotation) => annotation.isApplied && !annotation.isDeleted).length;
    const pendingAnnotations = annotations.filter(
        (annotation) => annotation.pendingAttachmentOpen && !annotation.isDeleted
    ).length;
    const deletedAnnotations = annotations.filter((annotation) => annotation.isDeleted).length;
    const hasErrors = annotations.some((annotation) => annotation.applicationError && !annotation.isDeleted);

    // Added loading dots animation for in_progress state
    useEffect(() => {
        let interval: NodeJS.Timeout | undefined;
        if (toolCall.status === 'in_progress') {
            setLoadingDots(1); 
            interval = setInterval(() => {
                setLoadingDots((dots) => (dots < 3 ? dots + 1 : 1));
            }, 250);
        } else {
            setLoadingDots(1); 
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [toolCall.status]);

    const toggleResults = useCallback(() => {
        // Only allow toggling if completed and has annotations
        if (toolCall.status === 'completed' && totalAnnotations > 0) {
            setResultsVisible((prev) => !prev);
        }
    }, [toolCall.status, totalAnnotations]);

    const markAnnotationState = useCallback(
        (annotationId: string, updates: Partial<ToolAnnotationResult>) => {
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
                if (annotation.isDeleted) continue;
                if (annotation.isApplied) continue;
                if (annotation.pendingAttachmentOpen) continue;
                if (annotation.applicationError) continue;
                if (annotation.origin === 'summary') {
                    const existingKey = await resolveExistingAnnotationKey(annotation);
                    if (cancelled) return;
                    if (existingKey) {
                        markAnnotationState(annotation.id, {
                            isApplied: true,
                            pendingAttachmentOpen: false,
                            applicationError: null,
                            zoteroAnnotationKey: existingKey,
                            isDeleted: false,
                        });
                    } else {
                        markAnnotationState(annotation.id, {
                            isDeleted: true,
                            pendingAttachmentOpen: false,
                            applicationError: 'Annotation not found in Zotero document',
                        });
                    }
                    continue;
                }

                const existingKey = await resolveExistingAnnotationKey(annotation);
                if (cancelled) return;
                if (existingKey) {
                    markAnnotationState(annotation.id, {
                        isApplied: true,
                        pendingAttachmentOpen: false,
                        applicationError: null,
                        zoteroAnnotationKey: existingKey,
                        isDeleted: false,
                    });
                    continue;
                }

                setBusyState((prev) => ({ ...prev, [annotation.id]: true }));
                const result = await applyAnnotation(annotation);
                if (cancelled) {
                    setBusyState((prev) => ({ ...prev, [annotation.id]: false }));
                    return;
                }

                if (result.status === 'applied') {
                    markAnnotationState(annotation.id, {
                        isApplied: true,
                        pendingAttachmentOpen: false,
                        applicationError: null,
                        zoteroAnnotationKey: result.zoteroAnnotationKey,
                    });
                } else if (result.status === 'pending') {
                    markAnnotationState(annotation.id, {
                        pendingAttachmentOpen: true,
                    });
                } else {
                    markAnnotationState(annotation.id, {
                        applicationError: result.reason || 'Failed to create annotation',
                        pendingAttachmentOpen: false,
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
        async (annotation: ToolAnnotationResult) => {
            setBusyState((prev) => ({ ...prev, [annotation.id]: true }));

            let existingKey = annotation.zoteroAnnotationKey;
            if (!existingKey) {
                existingKey = (await resolveExistingAnnotationKey(annotation)) || undefined;
            }

            if (existingKey) {
                markAnnotationState(annotation.id, {
                    isApplied: true,
                    pendingAttachmentOpen: false,
                    applicationError: null,
                    zoteroAnnotationKey: existingKey,
                    isDeleted: false,
                });
                await navigateToAnnotation(existingKey);
                setBusyState((prev) => ({ ...prev, [annotation.id]: false }));
                return;
            }

            const attemptApply = async () => {
                let result = await applyAnnotation(annotation);
                if (result.status === 'pending') {
                    await openAttachmentForAnnotation(annotation);
                    result = await applyAnnotation(annotation);
                }
                return result;
            };

            const result = await attemptApply();

            if (result.status === 'applied') {
                markAnnotationState(annotation.id, {
                    isApplied: true,
                    pendingAttachmentOpen: false,
                    applicationError: null,
                    zoteroAnnotationKey: result.zoteroAnnotationKey,
                    isDeleted: false,
                });
                await navigateToAnnotation(result.zoteroAnnotationKey);
            } else if (result.status === 'pending') {
                markAnnotationState(annotation.id, {
                    pendingAttachmentOpen: true,
                });
            } else {
                markAnnotationState(annotation.id, {
                    applicationError: result.reason || 'Failed to create annotation',
                });
            }

            setBusyState((prev) => ({ ...prev, [annotation.id]: false }));
        },
        [markAnnotationState]
    );

    const handleDelete = useCallback(
        async (annotation: ToolAnnotationResult) => {
            setBusyState((prev) => ({ ...prev, [annotation.id]: true }));
            try {
                if (!annotation.isApplied || !annotation.zoteroAnnotationKey) {
                    markAnnotationState(annotation.id, {
                        isDeleted: true,
                        isApplied: false,
                        pendingAttachmentOpen: false,
                    });
                } else {
                    await deleteAnnotationFromReader(annotation);
                    markAnnotationState(annotation.id, {
                        isDeleted: true,
                        isApplied: false,
                        pendingAttachmentOpen: false,
                    });
                }
            } catch (error: any) {
                markAnnotationState(annotation.id, {
                    applicationError: error?.message || 'Failed to delete annotation',
                });
            } finally {
                setBusyState((prev) => ({ ...prev, [annotation.id]: false }));
            }
        },
        [markAnnotationState]
    );

    // Updated icon logic to return JSX elements directly
    const getIcon = () => {
        if (toolCall.status === 'in_progress') return <Icon icon={Spinner} />;
        if (toolCall.status === 'error') return <Icon icon={AlertIcon} />;
        if (toolCall.status === 'completed') {
            if (resultsVisible) return <Icon icon={ArrowDownIcon} />;
            if (isButtonHovered && totalAnnotations > 0) return <Icon icon={ArrowRightIcon} />;
            if (totalAnnotations === 0) return <Icon icon={AlertIcon} />;
            if (hasErrors || deletedAnnotations === totalAnnotations) return <Icon icon={AlertIcon} />;
            return <ZoteroIcon icon={ZOTERO_ICONS.ANNOTATION} size={12} className="flex-shrink-0" />;
        }
        return <ZoteroIcon icon={ZOTERO_ICONS.ANNOTATION} size={12} className="flex-shrink-0" />;
    };

    // Updated button text logic to match regular tool calls
    const getButtonText = () => {
        const label = toolCall.label || 'Annotation tool';
        if (toolCall.status === 'error') {
            return `${label}: Unexpected error`;
        }
        if (toolCall.status === 'in_progress') {
            return `${label}${''.padEnd(loadingDots, '.')}`;
        }
        if (toolCall.status === 'completed') {
            if (totalAnnotations === 0) return `${label}: No annotations`;

            const parts: string[] = [];
            if (appliedAnnotations > 0) {
                parts.push(`${appliedAnnotations}/${totalAnnotations} applied`);
            } else {
                parts.push(
                    `${totalAnnotations} ${totalAnnotations === 1 ? 'annotation' : 'annotations'}`
                );
            }
            if (pendingAnnotations > 0) {
                parts.push(`${pendingAnnotations} pending`);
            }
            if (deletedAnnotations > 0) {
                parts.push(`${deletedAnnotations} deleted`);
            }
            if (hasErrors) {
                parts.push('check reader');
            }

            return `${label}: ${parts.join(', ')}`;
        }
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
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export const ToolCallDisplay: React.FC<ToolCallDisplayProps> = ({ messageId: _messageId, toolCall }) => {
    if (isAnnotationTool(toolCall.function?.name)) {
        return <AnnotationToolCallDisplay messageId={_messageId} toolCall={toolCall} />;
    }
    const [resultsVisible, setResultsVisible] = useState(false);
    const [loadingDots, setLoadingDots] = useState(1);
    const [isButtonHovered, setIsButtonHovered] = useState(false);

    useEffect(() => {
        let interval: NodeJS.Timeout | undefined;
        if (toolCall.status === 'in_progress') {
            setLoadingDots(1); 
            interval = setInterval(() => {
                setLoadingDots((dots) => (dots < 3 ? dots + 1 : 1));
            }, 250);
        } else {
            setLoadingDots(1); 
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [toolCall.status]);

    const numResults = toolCall.response?.attachments?.length ?? 0;

    const toggleResults = () => {
        if (toolCall.status === 'completed' && numResults > 0) {
            setResultsVisible(!resultsVisible);
        }
    };

    const getIcon = () => {
        if (toolCall.status === 'in_progress') return Spinner;
        if (toolCall.status === 'error') return AlertIcon;
        if (toolCall.status === 'completed') {
            if (resultsVisible) return ArrowDownIcon;
            if (isButtonHovered && numResults > 0) return ArrowRightIcon;
            if(toolCall.function.name === 'related_items_search') return SearchIcon;
            if(toolCall.function.name === 'tag_search') return SearchIcon;
            if(toolCall.function.name === 'search_references_by_topic') return SearchIcon;
            if(toolCall.function.name === 'get_fulltext_content') return numResults ? ViewIcon : AlertIcon;
            if(toolCall.function.name === 'search_metadata') return SearchIcon;
            if(toolCall.function.name === 'search_references_by_metadata') return SearchIcon;
            if(toolCall.function.name === 'view_page_images') return ViewIcon;
            return SearchIcon;
        }
        return SearchIcon;
    };

    const getButtonText = () => {
        const label = toolCall.label || "Calling function";
        if (toolCall.status === 'error') {
            return `${label}: Error`;
        }
        if (toolCall.status === 'in_progress') {
            return `${label}${''.padEnd(loadingDots, '.')}`;
        }
        if (toolCall.status === 'completed') {
            if (numResults === 0 && !toolCall.response?.content) return `${label}: No results`;
            if (numResults > 0) return `${label} (${numResults} ${numResults === 1 ? 'item' : 'items'})`;
            return label; // For completed tools that only have response.content
        }
        return label;
    };
    
    const hasAttachmentsToShow = numResults > 0;
    const canToggleResults = toolCall.status === 'completed' && hasAttachmentsToShow;
    const isButtonDisabled = toolCall.status === 'in_progress' || toolCall.status === 'error' || (toolCall.status === 'completed' && !hasAttachmentsToShow && !toolCall.response?.content);

    return (
        <div id={`tool-${toolCall.id}`} className={`${resultsVisible ? 'border-popup' : 'border-transparent'} rounded-md flex flex-col min-w-0 py-1`}>
            <Button
                variant="ghost-secondary"
                onClick={toggleResults}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
                className={`
                    text-base scale-105 w-full min-w-0 align-start text-left
                    ${isButtonDisabled && !canToggleResults ? 'disabled-but-styled' : ''}
                    ${!hasAttachmentsToShow && toolCall.status === 'completed' && toolCall.response?.content ? 'justify-start' : ''}
                    ${toolCall.status === 'completed' && toolCall.response?.attachments && toolCall.response.attachments.length > 0 ? 'justify-start' : ''}
                `}
                style={{ padding: '2px 6px', maxHeight: 'none'}}
                disabled={isButtonDisabled && !canToggleResults}
            >
                <div className="display-flex flex-row px-3 gap-2">
                    <div className={`flex-1 display-flex mt-020 ${resultsVisible ? 'font-color-primary' : ''}`}>
                        <Icon icon={getIcon()} />
                    </div>
                    
                    <div className={`display-flex ${resultsVisible ? 'font-color-primary' : ''}`}>
                        {getButtonText()}
                    </div>
                    
                </div>
            </Button>

            {toolCall.status === 'error' && toolCall.response?.error && !toolCall.response?.content && (
                <div className="px-4 py-1 text-sm text-red-600">
                     <MarkdownRenderer className="markdown" content={toolCall.response.error} />
                </div>
            )}

            {resultsVisible && hasAttachmentsToShow && toolCall.response && toolCall.response.attachments && (
                <div className={`py-1 ${resultsVisible ? 'border-top-quinary' : ''} mt-15`}>
                    <ZoteroItemsList messageAttachments={toolCall.response.attachments} />
                </div>
            )}
        </div>
    );
};

export const AssistantMessageTools: React.FC<AssistantMessageToolsProps> = ({
    message,
    isFirstAssistantMessage,
    previousMessageHasToolCalls,
}) => {
    if (!message.tool_calls || message.tool_calls.length === 0) {
        return null;
    }

    const getTopMargin = function() {
        if (message.content == '' && previousMessageHasToolCalls) return '-mt-2';
        if (message.content == '' && isFirstAssistantMessage) return '-mt-1';
        return 'mt-1';
    }

    return (
        <div
            id={`tools-${message.id}`}
            className={
                `display-flex flex-col py-1 gap-3
                ${getTopMargin()}`
            }
        >
            {message.tool_calls.map((toolCall) => (
                <ToolCallDisplay key={toolCall.id} messageId={message.id} toolCall={toolCall} />
            ))}
        </div>
    );
};

export default AssistantMessageTools;
