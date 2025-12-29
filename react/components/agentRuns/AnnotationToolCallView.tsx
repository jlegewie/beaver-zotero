import React, { useState, useEffect, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { ToolCallPart } from '../../agents/types';
import { toolResultsMapAtom, getToolCallStatus } from '../../agents/atoms';
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
import { AnnotationResultData } from '../../types/agentActions/annotations';
import { applyAnnotation, deleteAnnotationFromReader } from '../../utils/annotationActions';
import { getCurrentPage, getCurrentReaderAndWaitForView, navigateToAnnotation, navigateToPage } from '../../utils/readerUtils';
import { currentReaderAttachmentKeyAtom } from '../../atoms/messageComposition';
import { isLibraryEditable, shortItemTitle } from '../../../src/utils/zoteroUtils';
import { ZoteroReader } from '../../utils/annotationUtils';
import { logger } from '../../../src/utils/logger';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Icon,
    TickIcon,
    CancelIcon,
    HighlighterIcon,
} from '../icons/icons';
import IconButton from '../ui/IconButton';
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
import { isNoteAnnotationToolResult, isHighlightAnnotationToolResult } from '../../agents/toolResultTypes';

// =============================================================================
// Types
// =============================================================================

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

function toPageIndex(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function getHighlightPageIndexes(annotation: AnnotationAgentAction): number[] {
    const locations = annotation.proposed_data.highlight_locations;
    if (!Array.isArray(locations) || locations.length === 0) return [];

    return locations
        .map((loc) => toPageIndex(loc?.page_idx ?? loc?.page_index ?? loc?.pageIdx ?? loc?.pageIndex))
        .filter((idx): idx is number => typeof idx === 'number');
}

function getNotePageIndex(annotation: AnnotationAgentAction): number | undefined {
    const pos = annotation.proposed_data.note_position;
    return toPageIndex(pos?.page_index ?? pos?.page_idx ?? pos?.pageIndex);
}

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function navigateToNewlyAppliedAnnotation(
    reader: ZoteroReader | undefined,
    annotation: AnnotationAgentAction,
    result: { zotero_key: string; library_id: number }
): Promise<void> {
    try {
        if (reader) {
            const pageIndexes = isNoteAnnotationAgentAction(annotation)
                ? [getNotePageIndex(annotation)]
                : getHighlightPageIndexes(annotation);
            const targetPageIndex = pageIndexes.find((idx): idx is number => typeof idx === 'number');
            const currentPageNumber = getCurrentPage(reader as any);
            const currentPageIndex = typeof currentPageNumber === 'number' ? currentPageNumber - 1 : null;
            const shouldPreNavigateToPage = typeof targetPageIndex === 'number'
                && (currentPageIndex === null || Math.abs(currentPageIndex - targetPageIndex) > 1);

            // Retry a few times to allow the internal reader to render/register the new annotation.
            for (let attempt = 0; attempt < 5; attempt++) {
                // Pre-navigate when we're far from the target page
                if (attempt === 1 && shouldPreNavigateToPage && typeof targetPageIndex === 'number') {
                    try {
                        (reader as any).navigate?.({ pageIndex: targetPageIndex });
                    } catch {
                        // Best-effort only
                    }
                }

                try {
                    await (reader as any)?.navigate?.({ annotationID: result.zotero_key });
                    return;
                } catch {
                    // fall through
                }
                try {
                    await (reader as any)?._internalReader?.navigate?.({ annotationID: result.zotero_key });
                    return;
                } catch {
                    // fall through
                }
                try {
                    await (reader as any)?._internalReader?.navigate?.({ annotationId: result.zotero_key });
                    return;
                } catch {
                    await delay(100);
                }
            }
        }
    } catch {
        // Fall back to DB-based navigation below
    }

    // Fallback: look up the annotation item and navigate using the existing helper
    try {
        const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
            result.library_id,
            result.zotero_key
        );
        if (annotationItem) {
            await navigateToAnnotation(annotationItem);
        }
    } catch {
        // No-op: navigation is best-effort
    }
}

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

    const icon = isNoteAnnotationAgentAction(annotation)
        ? ZOTERO_ICONS.ANNOTATION
        : ZOTERO_ICONS.ANNOTATE_HIGHLIGHT;

    const hasNoApplicationError = annotation.status !== 'error';

    // Determine icon color based on status and annotation color
    const getIconColor = () => {
        const isInactive = annotation.status === 'rejected' || 
                          annotation.status === 'pending' || 
                          annotation.status === 'undone';
        if (annotation.status === 'error') return 'font-color-secondary';
        if (isInactive) return 'font-color-tertiary';
        if (annotation.result_data?.color || annotation.proposed_data.color) {
            const color = annotation.result_data?.color ?? annotation.proposed_data.color;
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

    const baseClasses = [
        'px-25',
        'py-15',
        'display-flex',
        'flex-col',
        'gap-1',
        'cursor-pointer',
        'rounded-sm',
        'transition',
        'user-select-none',
    ];

    if (isHovered) baseClasses.push('bg-quinary');
    if (isInactive) baseClasses.push('opacity-60');

    return (
        <div
            className={`${baseClasses.join(' ')} ${className || ''}`}
            onClick={handleClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="display-flex flex-row items-start gap-3">
                {hasNoApplicationError ? (
                    <ZoteroIcon
                        icon={icon}
                        size={13}
                        className={`flex-shrink-0 mt-020 ${getIconColor()}`}
                    />
                ) : (
                    <Icon
                        icon={AlertIcon}
                        className={`flex-shrink-0 mt-020 ${getIconColor()}`}
                    />
                )}
                <div className="flex-1 min-w-0">
                    <div className={getTextClasses()}>
                        {annotation.proposed_data.title || 'Annotation'}
                    </div>
                </div>

                {/* Applied: show delete button on hover */}
                {annotation.status === 'applied' && (
                    <div className={`display-flex flex-row items-center gap-2 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-secondary"
                            onClick={handleReject}
                            className="p-1"
                            title="Delete annotation"
                            icon={CancelIcon}
                            loading={isBusy}
                        />
                    </div>
                )}

                {/* Rejected/Undone: show re-add button on hover */}
                {(annotation.status === 'rejected' || annotation.status === 'undone') && (
                    <div className={`display-flex flex-row items-center -mr-015 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-secondary"
                            onClick={handleReAdd}
                            className="p-1 scale-13"
                            title="Add annotation"
                            icon={TickIcon}
                            loading={isBusy}
                        />
                    </div>
                )}

                {/* Pending: show both reject and accept buttons on hover */}
                {annotation.status === 'pending' && (
                    <div className={`display-flex flex-row items-center -mr-015 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-tertiary"
                            onClick={handleReject}
                            className="p-1"
                            title="Reject annotation"
                            icon={CancelIcon}
                            loading={isBusy}
                        />
                        <IconButton
                            variant="ghost-tertiary"
                            onClick={handleReAdd}
                            className="p-1 scale-13"
                            title="Add annotation"
                            icon={TickIcon}
                            loading={isBusy}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

// =============================================================================
// AnnotationToolCallView Component
// =============================================================================

interface AnnotationToolCallViewProps {
    part: ToolCallPart;
    runId: string;
}

/**
 * Specialized view for annotation tool calls.
 * Combines the header (like ToolCallPartView) with the annotation list,
 * mirroring the design of the old AnnotationToolDisplay component.
 */
export const AnnotationToolCallView: React.FC<AnnotationToolCallViewProps> = ({ part, runId }) => {
    const toolCallId = part.tool_call_id;
    const isHighlightAnnotationPart = isHighlightAnnotationToolResult(part.tool_name);
    const isNoteAnnotationPart = isNoteAnnotationToolResult(part.tool_name);

    // Get tool call status from results
    const resultsMap = useAtomValue(toolResultsMapAtom);
    const status = getToolCallStatus(toolCallId, resultsMap);
    const isInProgress = status === 'in_progress';
    const isCompleted = status === 'completed';
    const isError = status === 'error';

    // Get annotations from agent actions
    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const annotations = getAgentActionsByToolcall(toolCallId, isAnnotationAgentAction) as AnnotationAgentAction[];
    const totalAnnotations = annotations.length;

    // Current reader state
    const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);
    const isAttachmentOpen = annotations.some(
        (action) => action.proposed_data.attachment_key === currentReaderAttachmentKey
    );
    const readOnlyLibrary = annotations.some(
        (action) => !isLibraryEditable(action.proposed_data.library_id)
    );

    // UI state from atoms (shared across panes)
    const panelStates = useAtomValue(annotationPanelStateAtom);
    const panelState = panelStates[toolCallId] ?? defaultAnnotationPanelState;
    const { resultsVisible, isApplying: isApplyingAnnotations } = panelState;
    const busyStateMap = useAtomValue(annotationBusyAtom);
    const busyState = busyStateMap[toolCallId] ?? {};
    const attachmentTitleMap = useAtomValue(annotationAttachmentTitlesAtom);
    const attachmentTitle = attachmentTitleMap[toolCallId] ?? null;

    // State management atoms
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const toggleAnnotationPanelVisibility = useSetAtom(toggleAnnotationPanelVisibilityAtom);
    const setAnnotationPanelState = useSetAtom(setAnnotationPanelStateAtom);
    const setAnnotationBusy = useSetAtom(setAnnotationBusyStateAtom);
    const setAnnotationAttachmentTitle = useSetAtom(setAnnotationAttachmentTitleAtom);

    // Local UI state
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);

    // Computed annotation states
    const somePending = annotations.some((a) => a.status === 'pending');
    const someErrors = annotations.some((a) => a.status === 'error');
    const allErrors = annotations.every((a) => a.status === 'error');
    const appliedCount = annotations.filter((a) => a.status === 'applied').length;
    const rejectedCount = annotations.filter((a) => a.status === 'rejected' || a.status === 'undone').length;

    // Derived states for UI
    const hasAnnotationsToShow = totalAnnotations > 0;
    const canToggleResults = isCompleted && hasAnnotationsToShow && !allErrors;
    const showApplyButton = isCompleted && (somePending || someErrors) && !isApplyingAnnotations && !readOnlyLibrary;

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
                setAnnotationAttachmentTitle({ key: toolCallId, title });
            }
        };
        if (!attachmentTitle && annotations.length > 0) {
            fetchTitle();
        }
    }, [annotations, attachmentTitle, toolCallId, setAnnotationAttachmentTitle]);

    // Toggle visibility
    const toggleResults = useCallback(() => {
        if (canToggleResults) {
            toggleAnnotationPanelVisibility(toolCallId);
        }
    }, [canToggleResults, toolCallId, toggleAnnotationPanelVisibility]);

    /**
     * Apply annotations to the PDF
     */
    const handleApplyAnnotations = useCallback(async (annotationId?: string) => {
        if (annotations.length === 0) return;
        setAnnotationPanelState({ key: toolCallId, updates: { isApplying: true } });

        try {
            const isSingleApply = Boolean(annotationId);

            // Open attachment if not already open
            if (!isAttachmentOpen) {
                const firstAnnotation = annotations[0];
                const attachmentItem = await Zotero.Items.getByLibraryAndKeyAsync(
                    firstAnnotation.proposed_data.library_id,
                    firstAnnotation.proposed_data.attachment_key
                );

                if (!attachmentItem) {
                    setAgentActionsToError(annotations.map((a) => a.id), 'Attachment not found');
                    setAnnotationPanelState({ key: toolCallId, updates: { isApplying: false } });
                    return;
                }

                // Calculate the page to navigate to
                const pageIndexes = annotations
                    .flatMap((a) => (isNoteAnnotationAgentAction(a) ? [getNotePageIndex(a)] : getHighlightPageIndexes(a)))
                    .filter((idx): idx is number => typeof idx === 'number');
                const minPageIndex = pageIndexes.length > 0 ? Math.min(...pageIndexes) : 0;

                await navigateToPage(attachmentItem.id, minPageIndex + 1);
            }

            // Get reader
            const reader = await getCurrentReaderAndWaitForView(undefined, true) as ZoteroReader | undefined;
            if (!reader) {
                setAnnotationPanelState({ key: toolCallId, updates: { isApplying: false } });
                return;
            }

            // Filter annotations to apply
            const annotationsToApply = annotations.filter((a) => {
                if (a.status === 'applied') return false;
                if (annotationId && a.id !== annotationId) return false;
                return true;
            });

            if (annotationsToApply.length === 0) {
                setAnnotationPanelState({ key: toolCallId, updates: { isApplying: false } });
                return;
            }

            // Apply annotations in parallel
            const results: (AckActionLink | null)[] = await Promise.all(
                annotationsToApply.map(async (annotation) => {
                    try {
                        const result: AnnotationResultData = await applyAnnotation(annotation as any, reader);
                        logger(`AnnotationToolCallView: applied annotation ${annotation.id}`, 1);
                        return { action_id: annotation.id, result_data: result } as AckActionLink;
                    } catch (error: any) {
                        const errorMessage = error?.message || 'Failed to apply annotation';
                        logger(`AnnotationToolCallView: failed to apply ${annotation.id}: ${errorMessage}`, 1);
                        setAgentActionsToError([annotation.id], errorMessage);
                        return null;
                    }
                })
            );

            // Acknowledge successful applications
            const successful = results.filter((r): r is AckActionLink => r !== null);
            if (successful.length > 0) {
                await ackAgentActions(runId, successful);
            }

            // Show results and mark complete
            setAnnotationPanelState({ key: toolCallId, updates: { resultsVisible: true, isApplying: false } });

            // Navigate to the newly applied annotation(s)
            if (successful.length > 0) {
                if (isSingleApply && annotationId) {
                    const ack = successful.find((s) => s.action_id === annotationId);
                    const targetAnnotation = annotations.find((a) => a.id === annotationId);
                    if (ack?.result_data && targetAnnotation) {
                        await navigateToNewlyAppliedAnnotation(reader, targetAnnotation, ack.result_data);
                    }
                } else {
                    const firstSuccess = successful[0];
                    const targetAnnotation = annotations.find((a) => a.id === firstSuccess.action_id);
                    if (firstSuccess?.result_data && targetAnnotation) {
                        await navigateToNewlyAppliedAnnotation(reader, targetAnnotation, firstSuccess.result_data);
                    }
                }
            }
        } catch (error) {
            logger(`AnnotationToolCallView: unexpected error: ${error}`, 1);
            setAnnotationPanelState({ key: toolCallId, updates: { isApplying: false } });
        }
    }, [annotations, isAttachmentOpen, runId, toolCallId, ackAgentActions, setAgentActionsToError, setAnnotationPanelState]);

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
        setAnnotationBusy({ key: toolCallId, annotationId: annotation.id, isBusy: true });
        try {
            if (annotation.status === 'applied' && annotation.result_data?.zotero_key) {
                await deleteAnnotationFromReader(annotation as any);
                undoAgentAction(annotation.id);
            } else {
                rejectAgentAction(annotation.id);
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to delete annotation';
            setAgentActionsToError([annotation.id], errorMessage);
        } finally {
            setAnnotationBusy({ key: toolCallId, annotationId: annotation.id, isBusy: false });
        }
    }, [toolCallId, rejectAgentAction, undoAgentAction, setAgentActionsToError, setAnnotationBusy]);

    /**
     * Re-add an annotation
     */
    const handleReAdd = useCallback(async (annotation: AnnotationAgentAction) => {
        await handleApplyAnnotations(annotation.id);
    }, [handleApplyAnnotations]);

    /**
     * Reject all pending annotations
     */
    const handleRejectAll = useCallback(() => {
        const pendingAnnotations = annotations.filter(
            (a) => a.status === 'pending' || a.status === 'error'
        );
        pendingAnnotations.forEach((a) => rejectAgentAction(a.id));
    }, [annotations, rejectAgentAction]);

    // Determine icon based on state
    const getIcon = () => {
        if (isInProgress || isApplyingAnnotations) return Spinner;
        if (isError || allErrors) return AlertIcon;
        if (isCompleted) {
            if (resultsVisible) return ArrowDownIcon;
            if (isButtonHovered && hasAnnotationsToShow) return ArrowRightIcon;
            if (!hasAnnotationsToShow) return AlertIcon;
            return HighlighterIcon;
        }
        return HighlighterIcon;
    };

    // Button text
    const getButtonText = () => {
        const annotationCount = status === 'completed' ? `${totalAnnotations} ` : "";
        if (isHighlightAnnotationPart) return isError ? 'Highlights: Error' : `${annotationCount}Highlight${totalAnnotations === 1 ? '' : 's'}`;
        if (isNoteAnnotationPart) return isError ? 'Notes: Error' : `${annotationCount}Note${totalAnnotations === 1 ? '' : 's'}`;
        if (isError) return 'Annotations: Error';
        return 'Annotations';
    };

    const isButtonDisabled = isInProgress || isError || (isCompleted && !hasAnnotationsToShow);

    return (
        <div
            id={`tool-${toolCallId}`}
            className="border-popup rounded-md display-flex flex-col min-w-0"
        >
            {/* Header */}
            <div
                className={`
                    display-flex flex-row bg-senary py-15 px-25
                    ${resultsVisible && hasAnnotationsToShow ? 'border-bottom-quinary' : ''}
                `}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
            >
                <button
                    type="button"
                    className={`variant-ghost-secondary display-flex flex-row py-15 gap-2 text-left ${canToggleResults ? 'cursor-pointer' : ''} ${isError ? 'font-color-warning' : ''}`}
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={resultsVisible}
                    aria-controls={`annotation-list-${toolCallId}`}
                    onClick={toggleResults}
                    disabled={isButtonDisabled && !canToggleResults}
                >
                    <div className="display-flex flex-row gap-2">
                        <div className="flex-1 display-flex mt-010">
                            <Icon icon={getIcon()} />
                        </div>
                        <div className={`display-flex ${isInProgress ? 'shimmer-text' : ''}`}>
                            {getButtonText()}
                        </div>
                        {/* Annotation metrics */}
                        {isCompleted && hasAnnotationsToShow && (
                            <div className="display-flex flex-row items-center gap-1">
                                {appliedCount > 0 && (
                                    <div className="font-color-green text-sm">+{appliedCount}</div>
                                )}
                                {rejectedCount > 0 && (
                                    <div className="font-color-tertiary text-sm">-{rejectedCount}</div>
                                )}
                            </div>
                        )}
                    </div>
                </button>
                <div className="flex-1" />

                {readOnlyLibrary && (
                    <div className="text-sm font-color-tertiary mt-015">
                        Read-only library
                    </div>
                )}

                {showApplyButton && (
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
                )}

                {!showApplyButton && !readOnlyLibrary && attachmentTitle && (
                    <div className="text-sm truncate font-color-tertiary mt-015" style={{ maxWidth: '155px' }}>
                        {attachmentTitle}
                    </div>
                )}
            </div>

            {/* Annotation list */}
            {resultsVisible && hasAnnotationsToShow && isCompleted && (
                <div className="display-flex flex-col gap-1" id={`annotation-list-${toolCallId}`}>
                    {annotations.map((annotation, index) => (
                        <AnnotationListItem
                            key={annotation.id}
                            annotation={annotation}
                            isBusy={Boolean(busyState[annotation.id])}
                            onClick={handleAnnotationClick}
                            onDelete={handleDelete}
                            onReAdd={handleReAdd}
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

export default AnnotationToolCallView;

