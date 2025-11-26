import React, { useState, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { ToolCall } from '../../types/chat/apiTypes';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    TickIcon,
    CancelIcon,
    DocumentValidationIcon,
} from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import { CSSItemTypeIcon } from '../icons/icons';
import { ZOTERO_ICONS } from '../icons/ZoteroIcon';
import {
    applyCreateItem,
    deleteAddedItem,
} from '../../utils/addItemActions';
import { logger } from '../../../src/utils/logger';
import { useLoadingDots } from '../../hooks/useLoadingDots';
import { 
    getProposedActionsByToolcallAtom, 
    setProposedActionsToErrorAtom, 
    rejectProposedActionStateAtom, 
    ackProposedActionsAtom, 
    undoProposedActionAtom 
} from '../../atoms/proposedActions';
import { CreateItemProposedAction, isCreateItemAction, CreateItemResultData } from '../../types/proposedActions/items';
import { AckLink } from '../../../src/services/proposedActionsService';
import {
    annotationBusyAtom,
    annotationPanelStateAtom,
    defaultAnnotationPanelState,
    setAnnotationBusyStateAtom,
    setAnnotationPanelStateAtom,
    toggleAnnotationPanelVisibilityAtom
} from '../../atoms/messageUIState';
import { markExternalReferenceImportedAtom } from '../../atoms/externalReferences';
import { ToolDisplayFooter } from './ToolDisplayFooter';
import ExternalReferenceListItem from '../externalReferences/ExternalReferenceListItem';
import { revealSource } from '../../utils/sourceUtils';

interface CreateItemListItemProps {
    action: CreateItemProposedAction;
    isBusy: boolean;
    onClick: (action: CreateItemProposedAction) => Promise<void>;
    onDelete: (action: CreateItemProposedAction) => Promise<void>;
    onApply: (action: CreateItemProposedAction) => Promise<void>;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    className?: string;
}

const CreateItemListItem: React.FC<CreateItemListItemProps> = ({
    action,
    isBusy,
    onClick,
    onDelete,
    onApply,
    isHovered,
    onMouseEnter,
    onMouseLeave,
    className,
}) => {
    const item = action.proposed_data.item;

    const handleClick = useCallback(() => {
        if (isBusy) return;
        onClick(action);
    }, [action, isBusy, onClick]);

    const handleReject = useCallback(
        (event: React.SyntheticEvent) => {
            event.stopPropagation();
            if (isBusy) return;
            onDelete(action);
        },
        [action, isBusy, onDelete]
    );

    const handleApply = useCallback(
        (event: React.SyntheticEvent) => {
            event.stopPropagation();
            if (isBusy) return;
            onApply(action);
        },
        [action, isBusy, onApply]
    );

    const baseClasses = [
        'px-3',
        'py-2',
        'display-flex',
        'flex-col',
        'gap-1',
        'cursor-pointer',
        'rounded-sm',
        'transition',
        'user-select-none',
    ];

    if (isHovered) {
        baseClasses.push('bg-quinary');
    }
    if (action.status === 'rejected' || action.status === 'undone' || action.status === 'error') {
        baseClasses.push('opacity-60');
    }

    const getTextClasses = () => {
        if (action.status === 'rejected' || action.status === 'undone') return 'font-color-tertiary line-through';
        if (action.status === 'pending') return 'font-color-secondary';
        return 'font-color-primary';
    };

    // Format authors for display
    const formatAuthors = (authors: string[] | undefined) => {
        if (!authors || authors.length === 0) return null;
        if (authors.length === 1) return authors[0];
        if (authors.length === 2) return authors.join(' & ');
        return `${authors[0]} et al.`;
    };

    const authors = formatAuthors(item.authors);
    const publicationTitle = item.journal?.name || item.venue;
    const year = item.year;

    return (
        <div
            className={`${baseClasses.join(' ')} ${className}`}
            onClick={handleClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="display-flex flex-row items-start gap-3">
                <div className="display-flex flex-col flex-1 gap-1 min-w-0">
                    <div className={getTextClasses()}>
                        {item.title || 'Untitled Item'}
                    </div>
                    {authors && (
                        <div className="display-flex flex-row items-center gap-1">
                            <div className="font-color-secondary truncate">{authors}</div>
                        </div>
                    )}
                    {(publicationTitle || year) && (
                        <div className="font-color-secondary">
                            {publicationTitle && <i>{publicationTitle}</i>}
                            {publicationTitle && year && ', '}
                            {year}
                        </div>
                    )}
                </div>

                {/* Applied: show delete button on hover */}
                {action.status === 'applied' && (
                    <div className={`display-flex flex-row items-center gap-2 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-secondary"
                            onClick={handleReject}
                            className="p-1"
                            title="Delete item"
                            icon={CancelIcon}
                            loading={isBusy}
                        />
                    </div>
                )}

                {/* Rejected/Undone: show re-add button on hover */}
                {(action.status === 'rejected' || action.status === 'undone') && (
                    <div className={`display-flex flex-row items-center -mr-015 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-secondary"
                            onClick={handleApply}
                            className="p-1 scale-13"
                            title="Add item"
                            icon={TickIcon}
                            loading={isBusy}
                        />
                    </div>
                )}

                {/* Pending: show both reject and apply buttons on hover */}
                {action.status === 'pending' && (
                    <div className={`display-flex flex-row items-center -mr-015 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-tertiary"
                            onClick={handleReject}
                            className="p-1"
                            title="Reject item"
                            icon={CancelIcon}
                            loading={isBusy}
                        />
                        <IconButton
                            variant="ghost-tertiary"
                            onClick={handleApply}
                            className="p-1 scale-13"
                            title="Add item"
                            icon={TickIcon}
                            loading={isBusy}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

interface AddItemToolDisplayProps {
    messageId: string;
    toolCall: ToolCall;
}

/**
 * Component that displays and manages AI-proposed Zotero items.
 * Handles the lifecycle of items from proposal to creation in Zotero.
 *
 * Item lifecycle:
 * 1. pending -> Item proposed by AI, user can accept or reject
 * 2. applied -> Item created in Zotero library
 * 3. rejected/undone -> User declined or removed the item
 */
const AddItemToolDisplay: React.FC<AddItemToolDisplayProps> = ({ messageId, toolCall }) => {
    const groupId = `${messageId}:${toolCall.id}`;

    // UI state for collapsible item list
    const panelStates = useAtomValue(annotationPanelStateAtom);
    const panelState = panelStates[groupId] ?? defaultAnnotationPanelState;
    const { resultsVisible, isApplying } = panelState;
    const busyStateMap = useAtomValue(annotationBusyAtom);
    const busyState = busyStateMap[groupId] ?? {};

    // Track hover states for UI interactions
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const [hoveredActionId, setHoveredActionId] = useState<string | null>(null);

    // Tool call state
    const isInProgress = toolCall.status === 'in_progress';
    const isCompleted = toolCall.status === 'completed';
    const isError = toolCall.status === 'error';

    // Loading animation for in-progress tool calls
    const loadingDots = useLoadingDots(isInProgress);

    // Proposed actions state management
    const ackProposedActions = useSetAtom(ackProposedActionsAtom);
    const rejectProposedAction = useSetAtom(rejectProposedActionStateAtom);
    const setProposedActionsToError = useSetAtom(setProposedActionsToErrorAtom);
    const undoProposedAction = useSetAtom(undoProposedActionAtom);
    const markExternalReferenceImported = useSetAtom(markExternalReferenceImportedAtom);

    // Extract create item actions from proposed actions
    const getProposedActionsByToolcall = useAtomValue(getProposedActionsByToolcallAtom);
    const createItemActions = getProposedActionsByToolcall(toolCall.id, isCreateItemAction) as CreateItemProposedAction[];
    const totalItems = createItemActions.length;

    // Panel state management
    const togglePanelVisibility = useSetAtom(toggleAnnotationPanelVisibilityAtom);
    const setPanelState = useSetAtom(setAnnotationPanelStateAtom);
    const setBusyState = useSetAtom(setAnnotationBusyStateAtom);

    // Compute overall state of all items
    const somePending = createItemActions.some((action) => action.status === 'pending');
    const someErrors = createItemActions.some((action) => action.status === 'error');
    const appliedCount = createItemActions.filter((action) => action.status === 'applied').length;
    const rejectedCount = createItemActions.filter((action) => action.status === 'rejected' || action.status === 'undone').length;
    const allErrors = createItemActions.every((action) => action.status === 'error');

    // Toggle visibility of item list
    const toggleResults = useCallback(() => {
        if (isCompleted && totalItems > 0) {
            togglePanelVisibility(groupId);
        }
    }, [groupId, isCompleted, totalItems, togglePanelVisibility]);

    /**
     * Apply a single create item action
     */
    const handleApplyItem = useCallback(async (action: CreateItemProposedAction) => {
        setBusyState({ key: groupId, annotationId: action.id, isBusy: true });

        try {
            // Create the item in Zotero
            const result: CreateItemResultData = await applyCreateItem(action);

            logger(`handleApplyItem: created item ${action.id}: ${JSON.stringify(result)}`, 1);

            // Update external reference cache
            if (action.proposed_data.item.source_id) {
                markExternalReferenceImported(action.proposed_data.item.source_id, {
                    library_id: result.library_id,
                    zotero_key: result.zotero_key
                });
            }

            // Acknowledge the action with result data
            await ackProposedActions(messageId, [{
                action_id: action.id,
                result_data: result
            }]);

        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to create item';
            logger(`handleApplyItem: failed to create item ${action.id}: ${errorMessage}`, 1);
            setProposedActionsToError([action.id], errorMessage);
        } finally {
            setBusyState({ key: groupId, annotationId: action.id, isBusy: false });
        }
    }, [ackProposedActions, groupId, markExternalReferenceImported, messageId, setBusyState, setProposedActionsToError]);

    /**
     * Apply all pending items
     */
    const handleApplyAll = useCallback(async () => {
        if (createItemActions.length === 0) return;
        setPanelState({ key: groupId, updates: { isApplying: true } });

        try {
            const actionsToApply = createItemActions.filter(
                action => action.status === 'pending' || action.status === 'error'
            );

            if (actionsToApply.length === 0) {
                setPanelState({ key: groupId, updates: { isApplying: false } });
                return;
            }

            // Apply all items in parallel
            const applyResults: (AckLink | null)[] = await Promise.all(
                actionsToApply.map(async (action) => {
                    try {
                        const result: CreateItemResultData = await applyCreateItem(action);
                        
                        // Update external reference cache
                        if (action.proposed_data.item.source_id) {
                            markExternalReferenceImported(action.proposed_data.item.source_id, {
                                library_id: result.library_id,
                                zotero_key: result.zotero_key
                            });
                        }

                        logger(`handleApplyAll: created item ${action.id}: ${JSON.stringify(result)}`, 1);
                        return {
                            action_id: action.id,
                            result_data: result
                        } as AckLink;
                    } catch (error: any) {
                        const errorMessage = error?.message || 'Failed to create item';
                        logger(`handleApplyAll: failed to create item ${action.id}: ${errorMessage}`, 1);
                        setProposedActionsToError([action.id], errorMessage);
                        return null;
                    }
                })
            );

            // Acknowledge successfully created items
            const successfulResults = applyResults.filter((result): result is AckLink => result !== null);
            if (successfulResults.length > 0) {
                await ackProposedActions(messageId, successfulResults);
            }

            // Show the results panel
            setPanelState({ key: groupId, updates: { resultsVisible: true, isApplying: false } });

        } catch (error) {
            logger(`handleApplyAll: unexpected error: ${error}`, 1);
            setPanelState({ key: groupId, updates: { isApplying: false } });
        }
    }, [ackProposedActions, createItemActions, groupId, markExternalReferenceImported, messageId, setPanelState, setProposedActionsToError]);

    /**
     * Handle clicking an item - reveal if applied, otherwise apply
     */
    const handleItemClick = useCallback(async (action: CreateItemProposedAction) => {
        if (action.status === 'applied' && action.result_data?.zotero_key) {
            // Reveal the item in Zotero
            revealSource({
                library_id: action.result_data.library_id,
                zotero_key: action.result_data.zotero_key
            });
        } else if (action.status === 'pending' || action.status === 'rejected' || action.status === 'undone') {
            // Apply the item
            await handleApplyItem(action);
        }
    }, [handleApplyItem]);

    /**
     * Handle deleting/rejecting an item
     */
    const handleDelete = useCallback(async (action: CreateItemProposedAction) => {
        setBusyState({ key: groupId, annotationId: action.id, isBusy: true });
        try {
            if (action.status !== 'applied' || !action.result_data?.zotero_key) {
                // Item not created yet - just mark as rejected
                rejectProposedAction(action.id);
            } else {
                // Delete the item from Zotero
                await deleteAddedItem(action);
                undoProposedAction(action.id);
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to delete item';
            setProposedActionsToError([action.id], errorMessage);
        } finally {
            setBusyState({ key: groupId, annotationId: action.id, isBusy: false });
        }
    }, [groupId, rejectProposedAction, setBusyState, setProposedActionsToError, undoProposedAction]);

    /**
     * Reject all pending items
     */
    const handleRejectAll = useCallback(() => {
        const pendingActions = createItemActions.filter(
            action => action.status === 'pending' || action.status === 'error'
        );
        pendingActions.forEach(action => {
            rejectProposedAction(action.id);
        });
    }, [createItemActions, rejectProposedAction]);

    // Determine which icon to show
    const getIcon = () => {
        if (isInProgress || isApplying) return Spinner;
        if (isError || allErrors) return AlertIcon;
        if (isCompleted) {
            if (resultsVisible) return ArrowDownIcon;
            if (isButtonHovered && totalItems > 0) return ArrowRightIcon;
            if (totalItems === 0) return AlertIcon;
            // return <CSSItemTypeIcon icon={ZOTERO_ICONS.ANNOTATION} size={12} className="flex-shrink-0" />;
            return DocumentValidationIcon
        }
        return DocumentValidationIcon
    };

    // Generate button text
    const getButtonText = () => {
        if (isInProgress) {
            return `Add Items${''.padEnd(loadingDots, '.')}`;
        }
        if (isError) {
            return 'Add Items: Error';
        }
        return 'Add Items';
    };

    // Determine when results can be toggled and when button should be disabled
    const hasItemsToShow = totalItems > 0;
    const canToggleResults = isCompleted && hasItemsToShow && !allErrors;
    const isButtonDisabled = isInProgress || isError || (isCompleted && !hasItemsToShow);

    // Determine when to show apply button
    const showApplyButton = isCompleted && (somePending || someErrors) && !isApplying;

    return (
        <div
            id={`tool-${toolCall.id}`}
            className="border-popup rounded-md display-flex flex-col min-w-0"
        >
            {/* Header with button and action icons */}
            <div
                className={`display-flex flex-row bg-senary py-15 px-2 ${resultsVisible && hasItemsToShow ? 'border-bottom-quinary' : ''}`}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
            >
                <div className="display-flex flex-row flex-1" onClick={toggleResults}>
                    <Button
                        variant="ghost-secondary"
                        icon={getIcon()}
                        className={`
                            text-base scale-105
                            ${isButtonDisabled && !canToggleResults ? 'disabled-but-styled' : ''}
                            ${isError ? 'font-color-warning' : ''}
                        `}
                        disabled={isButtonDisabled && !canToggleResults}
                    >
                        <span className="mr-1">{getButtonText()}</span>

                        {/* Item metrics */}
                        {isCompleted && hasItemsToShow && (
                            <div className="display-flex flex-row items-center gap-1">
                                {appliedCount > 0 && (
                                    <div className="font-color-green text-sm">+{appliedCount}</div>
                                )}
                                {rejectedCount > 0 && (
                                    <div className="font-color-tertiary text-sm">-{rejectedCount}</div>
                                )}
                                {rejectedCount === 0 && appliedCount === 0 && (
                                    <div className="font-color-tertiary text-sm">({totalItems})</div>
                                )}
                            </div>
                        )}
                    </Button>
                    <div className="flex-1" />
                </div>

                {/* Apply/Reject all buttons */}
                {showApplyButton && (
                    <div className="display-flex flex-row items-center gap-3 mr-015">
                        <Tooltip content="Reject all" showArrow singleLine>
                            <IconButton
                                icon={CancelIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-red"
                                onClick={handleRejectAll}
                            />
                        </Tooltip>
                        <Tooltip content="Add all items" showArrow singleLine>
                            <IconButton
                                icon={TickIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-green scale-14"
                                onClick={handleApplyAll}
                            />
                        </Tooltip>
                    </div>
                )}
            </div>

            {/* Expandable list of individual items */}
            {resultsVisible && hasItemsToShow && isCompleted && (
                <div className="display-flex flex-col gap-1">
                    {createItemActions.map((action, index) => (
                        <CreateItemListItem
                            key={action.id}
                            action={action}
                            isBusy={Boolean(busyState[action.id])}
                            onClick={handleItemClick}
                            onDelete={handleDelete}
                            onApply={handleApplyItem}
                            isHovered={hoveredActionId === action.id}
                            onMouseEnter={() => setHoveredActionId(action.id)}
                            onMouseLeave={() => setHoveredActionId(null)}
                            className={index === 0 ? 'pt-2' : ''}
                        />
                    ))}
                    <ToolDisplayFooter toggleContent={toggleResults} />
                </div>
            )}
        </div>
    );
};

export default AddItemToolDisplay;
