import React, { useState, useCallback, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
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
import { applyCreateItemData } from '../../utils/addItemActions';
import { ensureItemSynced, ensureItemsSynced } from '../../../src/utils/sync';
import { logger } from '../../../src/utils/logger';
import {
    CreateItemAgentAction,
    ackAgentActionsAtom,
    setAgentActionsToErrorAtom,
    rejectAgentActionAtom,
    undoAgentActionAtom,
} from '../../agents/agentActions';
import { AckActionLink } from '../../../src/services/agentActionsService';
import { CreateItemResultData } from '../../types/agentActions/items';
import {
    annotationBusyAtom,
    annotationPanelStateAtom,
    defaultAnnotationPanelState,
    setAnnotationBusyStateAtom,
    setAnnotationPanelStateAtom,
    toggleAnnotationPanelVisibilityAtom
} from '../../atoms/messageUIState';
import { markExternalReferenceImportedAtom } from '../../atoms/externalReferences';
import { ToolDisplayFooter } from '../messages/ToolDisplayFooter';
import AgentActionItemButtons from './AgentActionItemButtons';
import ReferenceMetadataDisplay from '../externalReferences/ReferenceMetadataDisplay';
import { ZoteroItemReference } from '../../types/zotero';

interface CreateItemListItemProps {
    action: CreateItemAgentAction;
    isBusy: boolean;
    onApply: (action: CreateItemAgentAction) => Promise<void>;
    onReject: (action: CreateItemAgentAction) => void;
    onExistingMatch: (action: CreateItemAgentAction, itemRef: ZoteroItemReference) => void;
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

    // Apply opacity to the metadata display wrapper instead of the entire container
    const metadataWrapperClasses = ['display-flex', 'flex-col', 'gap-2', 'min-w-0'];
    if (action.status === 'rejected' || action.status === 'undone' || action.status === 'error') {
        metadataWrapperClasses.push('opacity-60');
    }

    const getTextClasses = (defaultClass: string = 'font-color-primary') => {
        if (action.status === 'rejected' || action.status === 'undone') return 'font-color-tertiary line-through';
        return defaultClass;
    };

    return (
        <div
            className={`${baseClasses.join(' ')} ${className}`}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className={metadataWrapperClasses.join(' ')}>
                <ReferenceMetadataDisplay
                    title={item.title}
                    authors={item.authors}
                    publicationTitle={item.journal?.name || item.venue}
                    year={item.year}
                    getTextClasses={getTextClasses}
                />
            </div>
            <AgentActionItemButtons
                action={action}
                isBusy={isBusy}
                onApply={handleApply}
                onReject={handleReject}
                onExistingMatch={handleExistingMatch}
            />
        </div>
    );
};

interface CreateItemAgentActionDisplayProps {
    runId: string;
    actions: CreateItemAgentAction[];
}

/**
 * Displays and manages AI-proposed Zotero items from agent actions.
 * Handles the lifecycle of items from proposal to creation in Zotero.
 *
 * Item lifecycle:
 * 1. pending -> Item proposed by AI, user can accept or reject
 *    - If item already exists in library, auto-acknowledge with existing reference
 * 2. applied -> Item created in or linked to Zotero library
 * 3. rejected/undone -> User declined or removed the item
 */
const CreateItemAgentActionDisplay: React.FC<CreateItemAgentActionDisplayProps> = ({
    runId,
    actions,
}) => {
    const groupId = `${runId}:citations`;

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

    // Agent actions state management
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const markExternalReferenceImported = useSetAtom(markExternalReferenceImportedAtom);

    // Panel state management
    const togglePanelVisibility = useSetAtom(toggleAnnotationPanelVisibilityAtom);
    const setPanelState = useSetAtom(setAnnotationPanelStateAtom);
    const setBusyState = useSetAtom(setAnnotationBusyStateAtom);

    const totalItems = actions.length;

    // Compute overall state of all items
    const somePending = actions.some((action) => action.status === 'pending');
    const someErrors = actions.some((action) => action.status === 'error');
    const appliedCount = actions.filter((action) => action.status === 'applied').length;
    const rejectedCount = actions.filter((action) => action.status === 'rejected' || action.status === 'undone').length;
    const pendingCount = actions.filter((action) => action.status === 'pending').length;
    const allErrors = actions.every((action) => action.status === 'error');

    // Toggle visibility of item list
    const toggleResults = useCallback(() => {
        if (totalItems > 0) {
            togglePanelVisibility(groupId);
        }
    }, [groupId, totalItems, togglePanelVisibility]);

    /**
     * Handle existing library match - auto-acknowledge the action
     */
    const handleExistingMatch = useCallback(async (action: CreateItemAgentAction, itemRef: ZoteroItemReference) => {
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

        // Acknowledge the action with the existing item reference
        const resultData: CreateItemResultData = {
            library_id: itemRef.library_id,
            zotero_key: itemRef.zotero_key
        };

        await ackAgentActions(runId, [{
            action_id: action.id,
            result_data: resultData
        }]);
    }, [ackAgentActions, markExternalReferenceImported, runId]);

    /**
     * Apply a single create item action
     */
    const handleApplyItem = useCallback(async (action: CreateItemAgentAction) => {
        setBusyState({ key: groupId, annotationId: action.id, isBusy: true });

        try {
            // Create the item in Zotero with full post-processing
            const result: CreateItemResultData = await applyCreateItemData(action.proposed_data);

            logger(`handleApplyItem: created item ${action.id}: ${JSON.stringify(result)}`, 1);

            // Update external reference cache
            if (action.proposed_data.item.source_id) {
                markExternalReferenceImported(action.proposed_data.item.source_id, {
                    library_id: result.library_id,
                    zotero_key: result.zotero_key
                });
            }

            // Sync the newly created item to backend
            await ensureItemSynced(result.library_id, result.zotero_key);

            // Acknowledge the action with result data
            await ackAgentActions(runId, [{
                action_id: action.id,
                result_data: result
            }]);

        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to create item';
            logger(`handleApplyItem: failed to create item ${action.id}: ${errorMessage}`, 1);
            setAgentActionsToError([action.id], errorMessage);
        } finally {
            setBusyState({ key: groupId, annotationId: action.id, isBusy: false });
        }
    }, [ackAgentActions, groupId, markExternalReferenceImported, runId, setBusyState, setAgentActionsToError]);

    /**
     * Apply all pending items
     * Process in smaller batches to avoid overwhelming the system
     */
    const handleApplyAll = useCallback(async () => {
        if (actions.length === 0) return;
        setPanelState({ key: groupId, updates: { isApplying: true } });

        try {
            const actionsToApply = actions.filter(
                action => action.status === 'pending' || action.status === 'error'
            );

            if (actionsToApply.length === 0) {
                setPanelState({ key: groupId, updates: { isApplying: false } });
                return;
            }

            // Mark all items as busy before starting
            actionsToApply.forEach(action => {
                setBusyState({ key: groupId, annotationId: action.id, isBusy: true });
            });

            // Process items in smaller batches to avoid timeouts
            // Maximum 3 concurrent imports to prevent overwhelming the system
            const BATCH_SIZE = 3;
            const applyResults: (AckActionLink | null)[] = [];
            
            for (let i = 0; i < actionsToApply.length; i += BATCH_SIZE) {
                const batch = actionsToApply.slice(i, i + BATCH_SIZE);
                logger(`handleApplyAll: Processing batch ${i / BATCH_SIZE + 1} of ${Math.ceil(actionsToApply.length / BATCH_SIZE)} (${batch.length} items)`, 1);
                
                const batchResults = await Promise.all(
                    batch.map(async (action) => {
                        try {
                            // Create the item in Zotero with full post-processing
                            const result: CreateItemResultData = await applyCreateItemData(action.proposed_data);
                            
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
                            } as AckActionLink;
                        } catch (error: any) {
                            const errorMessage = error?.message || 'Failed to create item';
                            logger(`handleApplyAll: failed to create item ${action.id}: ${errorMessage}`, 1);
                            setAgentActionsToError([action.id], errorMessage);
                            return null;
                        } finally {
                            // Clear busy state for this item
                            setBusyState({ key: groupId, annotationId: action.id, isBusy: false });
                        }
                    })
                );
                
                applyResults.push(...batchResults);
            }

            // Acknowledge successfully created items
            const successfulResults = applyResults.filter((result): result is AckActionLink => result !== null);
            if (successfulResults.length > 0) {
                await ackAgentActions(runId, successfulResults);
                
                // Batch sync all successfully created items
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

            setPanelState({ key: groupId, updates: { isApplying: false } });

        } catch (error) {
            logger(`handleApplyAll: unexpected error: ${error}`, 1);
            setPanelState({ key: groupId, updates: { isApplying: false } });
        }
    }, [ackAgentActions, actions, groupId, markExternalReferenceImported, runId, setPanelState, setAgentActionsToError, setBusyState]);

    /**
     * Handle rejecting an item (for pending items) or deleting (for applied items)
     */
    const handleReject = useCallback(async (action: CreateItemAgentAction) => {
        setBusyState({ key: groupId, annotationId: action.id, isBusy: true });
        try {
            if (action.status !== 'applied' || !action.result_data?.zotero_key) {
                // Item not created yet - just mark as rejected
                rejectAgentAction(action.id);
            } else {
                // Delete the item from Zotero
                const item = await Zotero.Items.getByLibraryAndKeyAsync(
                    action.result_data.library_id,
                    action.result_data.zotero_key
                );
                if (item) {
                    await Zotero.DB.executeTransaction(async () => {
                        await item.eraseTx();
                    });
                }
                undoAgentAction(action.id);
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to delete item';
            setAgentActionsToError([action.id], errorMessage);
        } finally {
            setBusyState({ key: groupId, annotationId: action.id, isBusy: false });
        }
    }, [groupId, rejectAgentAction, setBusyState, setAgentActionsToError, undoAgentAction]);

    /**
     * Reject all pending items
     */
    const handleRejectAll = useCallback(() => {
        const pendingActions = actions.filter(
            action => action.status === 'pending' || action.status === 'error'
        );
        pendingActions.forEach(action => {
            rejectAgentAction(action.id);
        });
    }, [actions, rejectAgentAction]);

    // Determine which icon to show
    const getIcon = () => {
        if (isButtonHovered && totalItems > 0) return ArrowRightIcon;
        if (isApplying || anyBusy) return Spinner;
        if (resultsVisible) return ArrowDownIcon;
        if (allErrors) return AlertIcon;
        if (totalItems === 0) return AlertIcon;
        return DocumentValidationIcon;
    };

    // Generate button text
    const getButtonText = () => {
        if (pendingCount > 0) {
            return `Import ${pendingCount} Item${pendingCount === 1 ? '' : 's'}`;
        }
        if (allErrors) {
            return `Error importing ${totalItems} Item${totalItems === 1 ? '' : 's'}`;
        }
        return `Imported ${appliedCount} Item${appliedCount === 1 ? '' : 's'}`;
    };

    // Determine when results can be toggled
    const hasItemsToShow = totalItems > 0;
    const canToggleResults = hasItemsToShow && !allErrors;
    const isButtonDisabled = !hasItemsToShow;

    // Determine when to show apply button
    const showApplyButton = (somePending || someErrors) && !isApplying;

    return (
        <div
            id={`agent-actions-${groupId}`}
            className="border-popup rounded-md display-flex flex-col min-w-0"
        >
            {/* Header with button and action icons */}
            <div
                className={`display-flex flex-row py-15 px-2 ${resultsVisible && hasItemsToShow ? 'border-bottom-quinary' : ''}`}
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
                        `}
                        disabled={isButtonDisabled && !canToggleResults}
                    >
                        <span className={`mr-1`}>{getButtonText()}</span>
                    </Button>
                    <div className="flex-1" />
                </div>

                {/* Apply/Reject all buttons */}
                {showApplyButton && !allErrors && (
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
            {resultsVisible && hasItemsToShow && (
                <div className="display-flex flex-col">
                    {actions.map((action, index) => (
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

export default CreateItemAgentActionDisplay;

