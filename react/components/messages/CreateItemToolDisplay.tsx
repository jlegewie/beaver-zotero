import React, { useState, useCallback, useRef } from 'react';
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
import {
    applyCreateItem,
    deleteAddedItem,
} from '../../utils/addItemActions';
import { ensureItemSynced, ensureItemsSynced } from '../../../src/utils/sync';
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
import ProposedItemButtons from '../externalReferences/ProposedItemButtons';
import ReferenceMetadataDisplay from '../externalReferences/ReferenceMetadataDisplay';
import { ZoteroItemReference } from '../../types/zotero';

interface CreateItemListItemProps {
    action: CreateItemProposedAction;
    isBusy: boolean;
    onApply: (action: CreateItemProposedAction) => Promise<void>;
    onReject: (action: CreateItemProposedAction) => void;
    onExistingMatch: (action: CreateItemProposedAction, itemRef: ZoteroItemReference) => void;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    className?: string;
}

const CreateItemListItem: React.FC<CreateItemListItemProps> = ({
    action,
    isBusy,
    onApply,
    onReject,
    onExistingMatch,
    isHovered,
    onMouseEnter,
    onMouseLeave,
    className,
}) => {
    const item = action.proposed_data.item;

    const handleApply = useCallback(() => {
        if (isBusy) return;
        onApply(action);
    }, [action, isBusy, onApply]);

    const handleReject = useCallback(() => {
        if (isBusy) return;
        onReject(action);
    }, [action, isBusy, onReject]);

    const handleExistingMatch = useCallback((itemRef: ZoteroItemReference) => {
        onExistingMatch(action, itemRef);
    }, [action, onExistingMatch]);

    const baseClasses = [
        'px-3',
        'py-2',
        'display-flex',
        'flex-col',
        'gap-1',
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

    const getTextClasses = (defaultClass: string = 'font-color-primary') => {
        if (action.status === 'rejected' || action.status === 'undone') return 'font-color-tertiary line-through';
        // if (action.status === 'pending') return 'font-color-secondary';
        return defaultClass;
    };

    return (
        <div
            className={`${baseClasses.join(' ')} ${className}`}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="display-flex flex-col gap-2 min-w-0">
                <ReferenceMetadataDisplay
                    title={item.title}
                    authors={item.authors}
                    publicationTitle={item.journal?.name || item.venue}
                    year={item.year}
                    getTextClasses={getTextClasses}
                />
                <ProposedItemButtons
                    action={action}
                    isBusy={isBusy}
                    onApply={handleApply}
                    onReject={handleReject}
                    onExistingMatch={handleExistingMatch}
                />
            </div>
        </div>
    );
};

interface CreateItemToolDisplayProps {
    messageId: string;
    toolCall?: ToolCall;
    createItemActions?: CreateItemProposedAction[];
}

/**
 * Component that displays and manages AI-proposed Zotero items.
 * Handles the lifecycle of items from proposal to creation in Zotero.
 * Supports both tool call and create item actions.
 *
 * Item lifecycle:
 * 1. pending -> Item proposed by AI, user can accept or reject
 *    - If item already exists in library, auto-acknowledge with existing reference
 * 2. applied -> Item created in or linked to Zotero library
 * 3. rejected/undone -> User declined or removed the item
 */
const CreateItemToolDisplay: React.FC<CreateItemToolDisplayProps> = ({
    messageId,
    toolCall,
    createItemActions,
}) => {
    if (!toolCall && !createItemActions) {
        throw new Error('Either toolCall or createItemActions must be provided');
    }
    const isToolCall = !!toolCall;
    // Generate unique group ID: use tool call ID if available, otherwise use first action's toolcall_id or fallback
    const toolCallId = toolCall?.id ?? createItemActions?.[0]?.toolcall_id ?? 'create-item';
    const groupId = `${messageId}:${toolCallId}`;

    // UI state for collapsible item list
    const panelStates = useAtomValue(annotationPanelStateAtom);
    const panelState = panelStates[groupId] ?? defaultAnnotationPanelState;
    const { resultsVisible, isApplying } = panelState;
    const busyStateMap = useAtomValue(annotationBusyAtom);
    const busyState = busyStateMap[groupId] ?? {};
    const anyBusy = Object.values(busyState).some((isBusy) => isBusy);

    // Track hover states for UI interactions
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const [hoveredActionId, setHoveredActionId] = useState<string | null>(null);

    // Track which actions have been auto-acknowledged to prevent duplicates
    const autoAcknowledgedRef = useRef<Set<string>>(new Set());

    // Tool call state
    const isInProgress = isToolCall ? toolCall.status === 'in_progress': false;
    const isCompleted = isToolCall ? toolCall.status === 'completed': true;
    const isError = isToolCall ? toolCall.status === 'error': false;

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
    createItemActions = isToolCall
        ? getProposedActionsByToolcall(toolCall!.id, isCreateItemAction) as CreateItemProposedAction[]
        : createItemActions ?? [];
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
    const pendingCount = createItemActions.filter((action) => action.status === 'pending').length;
    const allErrors = createItemActions.every((action) => action.status === 'error');

    // Toggle visibility of item list
    const toggleResults = useCallback(() => {
        if (isCompleted && totalItems > 0) {
            togglePanelVisibility(groupId);
        }
    }, [groupId, isCompleted, totalItems, togglePanelVisibility]);

    /**
     * Handle existing library match - auto-acknowledge the action
     * This is called when ProposedItemButtons finds an existing library item
     */
    const handleExistingMatch = useCallback(async (action: CreateItemProposedAction, itemRef: ZoteroItemReference) => {
        // Prevent duplicate auto-acknowledges
        if (autoAcknowledgedRef.current.has(action.id)) {
            return;
        }
        autoAcknowledgedRef.current.add(action.id);

        logger(`handleExistingMatch: Auto-acknowledging action ${action.id} with existing item ${itemRef.library_id}-${itemRef.zotero_key}`, 1);

        // Update external reference cache
        if (action.proposed_data.item.source_id) {
            markExternalReferenceImported(action.proposed_data.item.source_id, itemRef);
        }

        // Sync the existing item to backend (it may not be synced yet)
        // Fire-and-forget: don't block the acknowledge flow
        // ensureItemSynced(itemRef.library_id, itemRef.zotero_key).catch(err => {
        //     logger(`handleExistingMatch: Failed to sync existing item: ${err.message}`, 2);
        // });

        // Acknowledge the action with the existing item reference
        const resultData: CreateItemResultData = {
            library_id: itemRef.library_id,
            zotero_key: itemRef.zotero_key
        };

        await ackProposedActions(messageId, [{
            action_id: action.id,
            result_data: resultData
        }]);
    }, [ackProposedActions, markExternalReferenceImported, messageId]);

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

            // Sync the newly created item to backend immediately to ensure it's available for follow-up AI queries
            await ensureItemSynced(result.library_id, result.zotero_key);

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
                
                // Batch sync all successfully created items (more efficient than individual calls)
                // Group by library and sync each library's items together
                const itemsByLibrary = new Map<number, string[]>();
                for (const result of successfulResults) {
                    const data = result.result_data as CreateItemResultData;
                    if (!itemsByLibrary.has(data.library_id)) {
                        itemsByLibrary.set(data.library_id, []);
                    }
                    itemsByLibrary.get(data.library_id)!.push(data.zotero_key);
                }
                
                // Sync each library's items (fire-and-forget to not block UI)
                for (const [libraryId, keys] of itemsByLibrary) {
                    ensureItemsSynced(libraryId, keys).catch(err => {
                        logger(`handleApplyAll: Failed to sync items in library ${libraryId}: ${err.message}`, 2);
                    });
                }
            }

            // Show the results panel
            setPanelState({ key: groupId, updates: { resultsVisible: true, isApplying: false } });

        } catch (error) {
            logger(`handleApplyAll: unexpected error: ${error}`, 1);
            setPanelState({ key: groupId, updates: { isApplying: false } });
        }
    }, [ackProposedActions, createItemActions, groupId, markExternalReferenceImported, messageId, setPanelState, setProposedActionsToError]);

    /**
     * Handle rejecting an item (for pending items) or deleting (for applied items)
     */
    const handleReject = useCallback(async (action: CreateItemProposedAction) => {
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
        if (isInProgress || isApplying || anyBusy) return Spinner;
        if (isError || allErrors) return AlertIcon;
        if (isCompleted) {
            if (resultsVisible) return ArrowDownIcon;
            if (isButtonHovered && totalItems > 0) return ArrowRightIcon;
            if (totalItems === 0) return AlertIcon;
            return DocumentValidationIcon;
        }
        return DocumentValidationIcon;
    };

    // Generate button text
    const getButtonText = () => {
        if (isInProgress) {
            return `Import Items${''.padEnd(loadingDots, '.')}`;
        }
        if (isError) {
            return 'Import Items: Error';
        }
        if (pendingCount > 0) {
            return `Import ${pendingCount} Item${pendingCount === 1 ? '' : 's'}`;
        }
        return `Imported ${appliedCount} Item${appliedCount === 1 ? '' : 's'}`;
    };

    // Determine when results can be toggled and when button should be disabled
    const hasItemsToShow = totalItems > 0;
    const canToggleResults = isCompleted && hasItemsToShow && !allErrors;
    const isButtonDisabled = isInProgress || isError || (isCompleted && !hasItemsToShow);

    // Determine when to show apply button
    const showApplyButton = isCompleted && (somePending || someErrors) && !isApplying;

    // Determine background color
    const backgroundColor = isToolCall || resultsVisible ? 'bg-senary' : undefined;

    return (
        <div
            id={`tool-${groupId}`}
            className="border-popup rounded-md display-flex flex-col min-w-0"
        >
            {/* Header with button and action icons */}
            <div
                className={`display-flex flex-row ${backgroundColor} py-15 px-2 ${resultsVisible && hasItemsToShow ? 'border-bottom-quinary' : ''}`}
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
                        {isToolCall && isCompleted && hasItemsToShow && (
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
                <div className="display-flex flex-col">
                    {createItemActions.map((action, index) => (
                        <CreateItemListItem
                            key={action.id}
                            action={action}
                            isBusy={Boolean(busyState[action.id])}
                            onApply={handleApplyItem}
                            onReject={handleReject}
                            onExistingMatch={handleExistingMatch}
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

export default CreateItemToolDisplay;
