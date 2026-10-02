import { tryGetWindowRuntime } from '../../../runtime/windowRuntime';
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
    Icon,
} from '../../../components/icons/icons';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { applyCreateItemData } from '../../../utils/addItemActions';
import { ensureItemSynced, ensureItemsSynced } from '../../../../src/utils/sync';
import { logger } from '@beaver/agent-core/platform/logger';
import { resolveItemReference } from '../../../../src/utils/libraryIdentity';
import { notifyReferenceUnavailable } from '../sourceActions';
import {
    ItemCreatingAgentAction,
    isImportItemAgentAction,
    itemActionExternalId,
    ackAgentActionsAtom,
    setAgentActionsToErrorAtom,
    rejectAgentActionAtom,
    undoAgentActionAtom,
} from '../../../agents/agentActions';
import { AckActionLink } from '@beaver/agent-core/transport/clients/agentActionsService';
import { CreateItemResultData } from '@beaver/agent-core/types/agentActions/items';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { executeImportItemActions, undoImportItemActions } from '../../../utils/importItemActions';
import { importActionReference } from '../../../utils/importItemDisplay';
import {
    annotationBusyAtom,
    annotationPanelStateAtom,
    defaultAnnotationPanelState,
    setAnnotationBusyStateAtom,
    setAnnotationPanelStateAtom,
    toggleAnnotationPanelVisibilityAtom
} from '../../../atoms/messageUIState';
import { markExternalReferenceDeletedAtom, markExternalReferenceImportedAtom } from '../../../atoms/externalReferences';
import { currentThreadIdAtom } from '../../../atoms/threads';
import { ToolDisplayFooter } from '../../../components/messages/ToolDisplayFooter';
import AgentActionItemButtons from './AgentActionItemButtons';
import ReferenceMetadataDisplay from '../../../components/externalReferences/ReferenceMetadataDisplay';
import { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { useItemContextMenu } from '@beaver/agent-ui/chat/useItemContextMenu';

interface CreateItemListItemProps {
    action: ItemCreatingAgentAction;
    /** The reference the action stands for (an import_item carries none of its own). */
    reference: ExternalReference;
    isBusy: boolean;
    onApply: (action: ItemCreatingAgentAction) => Promise<void>;
    onReject: (action: ItemCreatingAgentAction) => void;
    onExistingMatch: (action: ItemCreatingAgentAction, itemRef: ZoteroItemReference) => void;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    className?: string;
}

const CreateItemListItem: React.FC<CreateItemListItemProps> = ({
    action,
    reference,
    isBusy,
    onApply,
    onReject,
    onExistingMatch,
    isHovered,
    onMouseEnter,
    onMouseLeave,
    className,
}) => {
    const item = reference;

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

    // Applied actions (imported, or matched to an existing item) name a library item.
    const { openItemMenu, itemMenu } = useItemContextMenu();
    const result = action.status === 'applied' ? action.result_data : undefined;
    const libraryItem: ZoteroItemReference | null = result?.zotero_key
        ? { library_id: result.library_id, zotero_key: result.zotero_key, library_ref: result.library_ref }
        : null;

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
            onContextMenu={libraryItem ? (event) => openItemMenu(libraryItem, event) : undefined}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            {itemMenu}
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
                item={reference}
                isBusy={isBusy}
                onApply={handleApply}
                onReject={handleReject}
                // An import_item never adopts an existing item: the card shows
                // it as already in the library, and nothing is acknowledged.
                onExistingMatch={isImportItemAgentAction(action) ? undefined : handleExistingMatch}
            />
        </div>
    );
};

/**
 * A failed action the user can retry or dismiss. An import that found its work
 * already in the library is settled: the row offers the existing item instead.
 */
function isRetryable(action: ItemCreatingAgentAction): boolean {
    return action.status === 'error' && action.error_details?.error_code !== 'already_in_library';
}

interface CreateItemAgentActionDisplayProps {
    runId: string;
    actions: ItemCreatingAgentAction[];
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
    const markExternalReferenceDeleted = useSetAtom(markExternalReferenceDeletedAtom);
    // Active thread ID — used to stamp the background PDF fetch so the
    // attachment_resolved ws event can route back to the live agent run.
    const threadId = useAtomValue(currentThreadIdAtom);
    const referenceMapping = useAtomValue(externalReferenceMappingAtom);
    const referenceFor = useCallback((action: ItemCreatingAgentAction): ExternalReference => (
        isImportItemAgentAction(action)
            ? importActionReference(action.proposed_data, referenceMapping)
            : action.proposed_data.item
    ), [referenceMapping]);

    // Panel state management
    const togglePanelVisibility = useSetAtom(toggleAnnotationPanelVisibilityAtom);
    const setPanelState = useSetAtom(setAnnotationPanelStateAtom);
    const setBusyState = useSetAtom(setAnnotationBusyStateAtom);

    const totalItems = actions.length;

    // Compute overall state of all items
    const somePending = actions.some((action) => action.status === 'pending');
    const someErrors = actions.some(isRetryable);
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
    const handleExistingMatch = useCallback(async (action: ItemCreatingAgentAction, itemRef: ZoteroItemReference) => {
        // An import_item never adopts an existing item: acknowledging it would
        // make undo erase the user's own item.
        if (isImportItemAgentAction(action)) return;
        // Prevent duplicate auto-acknowledges
        if (autoAcknowledgedRef.current.has(action.id)) {
            return;
        }
        autoAcknowledgedRef.current.add(action.id);

        logger(`handleExistingMatch: Auto-acknowledging action ${action.id} with existing item ${itemRef.library_id}-${itemRef.zotero_key}`, 1);

        // Update external reference cache
        const externalId = itemActionExternalId(action);
        if (externalId) {
            markExternalReferenceImported(externalId, itemRef);
        }

        // Acknowledge the action with the existing item reference.
        // The matched library item already exists, so the PDF state is
        // whatever it is on disk; we leave attachment_status as 'none' here
        // and let any subsequent lookup observe the current state. (No new
        // bg fetch is scheduled when we auto-acknowledge an existing match.)
        const resultData: CreateItemResultData = {
            library_id: itemRef.library_id,
            zotero_key: itemRef.zotero_key,
            library_ref: itemRef.library_ref,
            attachment_status: 'none',
        };

        await ackAgentActions(runId, [{
            action_id: action.id,
            result_data: resultData
        }]);
    }, [ackAgentActions, markExternalReferenceImported, runId]);

    /**
     * Apply a single create item action
     */
    /**
     * Create the item for one import_item action: resolved at this click, written
     * into the library being viewed. A work already in the library fails the
     * action (nothing is adopted); the card then shows it as already there.
     */
    const applyImportItems = useCallback(async (actions: ItemCreatingAgentAction[]): Promise<AckActionLink[]> => {
        const batch = await executeImportItemActions(actions, {
            runId,
            threadId: threadId ?? undefined,
        });
        for (const failure of batch.failures) {
            const existing = failure.errorDetails?.existing_item as ZoteroItemReference | undefined;
            const externalId = itemActionExternalId(failure.action);
            if (failure.errorDetails?.error_code === 'already_in_library' && existing && externalId) {
                markExternalReferenceImported(externalId, existing);
            }
            setAgentActionsToError([failure.action.id], failure.error, failure.errorDetails);
        }
        return batch.successes.map((success) => {
            const externalId = itemActionExternalId(success.action);
            if (externalId) {
                markExternalReferenceImported(externalId, {
                    library_id: success.result.library_id,
                    zotero_key: success.result.zotero_key,
                    library_ref: success.result.library_ref,
                });
            }
            return { action_id: success.action.id, result_data: success.result } as AckActionLink;
        });
    }, [markExternalReferenceImported, runId, setAgentActionsToError, threadId]);

    /**
     * Apply a single create item action
     */
    const handleApplyItem = useCallback(async (action: ItemCreatingAgentAction) => {
        setBusyState({ key: groupId, annotationId: action.id, isBusy: true });

        try {
            let result: CreateItemResultData;
            if (isImportItemAgentAction(action)) {
                const [link] = await applyImportItems([action]);
                if (!link) return;
                result = link.result_data as CreateItemResultData;
            } else {
                // Create the item in Zotero with full post-processing.
                // applyCreateItemData handles library/collection resolution internally.
                // Thread action/run/thread IDs so the background PDF fetch can emit
                // attachment_resolved back to this thread on completion.
                result = await applyCreateItemData(action.proposed_data, {
                    actionId: action.id,
                    runId,
                    threadId: threadId ?? undefined,
                });

                // Update external reference cache
                if (action.proposed_data.item.source_id) {
                    markExternalReferenceImported(action.proposed_data.item.source_id, {
                        library_id: result.library_id,
                        zotero_key: result.zotero_key,
                        library_ref: result.library_ref,
                    });
                }
            }

            logger(`handleApplyItem: created item ${action.id}: ${JSON.stringify(result)}`, 1);

            // Sync the newly created item to backend
            await ensureItemSynced(result.library_id, result.zotero_key);

            // Acknowledge the action with result data
            await ackAgentActions(runId, [{
                action_id: action.id,
                result_data: result
            }]);

            // Select the newly created item in Zotero (single item import)
            const newItem = await Zotero.Items.getByLibraryAndKeyAsync(result.library_id, result.zotero_key);
            if (newItem) {
                const contextWindow = tryGetWindowRuntime()?.contextWindow;
                const ZoteroPane = contextWindow && !contextWindow.closed ? contextWindow.ZoteroPane : undefined;
                if (ZoteroPane) {
                    ZoteroPane.selectItem(newItem.id);
                }
            }

        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to create item';
            logger(`handleApplyItem: failed to create item ${action.id}: ${errorMessage}`, 1);
            setAgentActionsToError([action.id], errorMessage, {
                stack_trace: error?.stack || '',
                error_name: error?.name,
            });
        } finally {
            setBusyState({ key: groupId, annotationId: action.id, isBusy: false });
        }
    }, [ackAgentActions, applyImportItems, groupId, markExternalReferenceImported, runId, threadId, setBusyState, setAgentActionsToError]);

    /**
     * Apply all pending items
     * Process in smaller batches to avoid overwhelming the system
     */
    const handleApplyAll = useCallback(async () => {
        if (actions.length === 0) return;
        setPanelState({ key: groupId, updates: { isApplying: true } });

        try {
            const actionsToApply = actions.filter(
                action => action.status === 'pending' || isRetryable(action)
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

            // import_item actions resolve and write in one plugin-realm batch.
            const importActions = actionsToApply.filter(isImportItemAgentAction);
            if (importActions.length > 0) {
                try {
                    applyResults.push(...await applyImportItems(importActions));
                } finally {
                    importActions.forEach((action) => setBusyState({ key: groupId, annotationId: action.id, isBusy: false }));
                }
            }
            const legacyActions = actionsToApply.filter((action) => !isImportItemAgentAction(action));

            for (let i = 0; i < legacyActions.length; i += BATCH_SIZE) {
                const batch = legacyActions.slice(i, i + BATCH_SIZE);
                logger(`handleApplyAll: Processing batch ${i / BATCH_SIZE + 1} of ${Math.ceil(legacyActions.length / BATCH_SIZE)} (${batch.length} items)`, 1);
                
                const batchResults = await Promise.all(
                    batch.map(async (action) => {
                        try {
                            // Create the item in Zotero with full post-processing.
                            // Pass action/run/thread IDs so the background PDF
                            // fetch can emit attachment_resolved back to this thread.
                            if (isImportItemAgentAction(action)) return null;
                            const result: CreateItemResultData = await applyCreateItemData(action.proposed_data, {
                                actionId: action.id,
                                runId,
                                threadId: threadId ?? undefined,
                            });

                            // Update external reference cache
                            if (action.proposed_data.item.source_id) {
                                markExternalReferenceImported(action.proposed_data.item.source_id, {
                                    library_id: result.library_id,
                                    zotero_key: result.zotero_key,
                                    library_ref: result.library_ref,
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
                            setAgentActionsToError([action.id], errorMessage, {
                                stack_trace: error?.stack || '',
                                error_name: error?.name,
                            });
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
                
                // If only one item was imported, select it in Zotero
                if (successfulResults.length === 1) {
                    const data = successfulResults[0].result_data as CreateItemResultData;
                    const newItem = await Zotero.Items.getByLibraryAndKeyAsync(data.library_id, data.zotero_key);
                    if (newItem) {
                        const contextWindow = tryGetWindowRuntime()?.contextWindow;
                        const ZoteroPane = contextWindow && !contextWindow.closed ? contextWindow.ZoteroPane : undefined;
                        if (ZoteroPane) {
                            ZoteroPane.selectItem(newItem.id);
                        }
                    }
                }
            }

            setPanelState({ key: groupId, updates: { isApplying: false } });

        } catch (error) {
            logger(`handleApplyAll: unexpected error: ${error}`, 1);
            setPanelState({ key: groupId, updates: { isApplying: false } });
        }
    }, [ackAgentActions, actions, applyImportItems, groupId, markExternalReferenceImported, runId, threadId, setPanelState, setAgentActionsToError, setBusyState]);

    /**
     * Handle rejecting an item (for pending items) or deleting (for applied items)
     */
    const handleReject = useCallback(async (action: ItemCreatingAgentAction) => {
        setBusyState({ key: groupId, annotationId: action.id, isBusy: true });
        try {
            if (action.status !== 'applied' || !action.result_data?.zotero_key) {
                // Item not created yet - just mark as rejected
                rejectAgentAction(action.id);
            } else if (isImportItemAgentAction(action)) {
                const batch = await undoImportItemActions([action]);
                if (batch.failures.length > 0) throw new Error(batch.failures[0].error);
                const externalId = itemActionExternalId(action);
                if (externalId) markExternalReferenceDeleted(externalId);
                undoAgentAction(action.id);
            } else {
                // Delete the item from Zotero. Resolve through the device-portable
                // library_ref so a group item created on another computer maps to the
                // right local library instead of a stale device-local library_id.
                const resolved = await resolveItemReference({
                    library_ref: action.result_data.library_ref,
                    library_id: action.result_data.library_id,
                    zotero_key: action.result_data.zotero_key,
                });
                if (resolved.status === 'library_unavailable') {
                    // The item is in a library this computer doesn't have (e.g. an
                    // unjoined group). We can't delete it here, and marking it undone
                    // would misrepresent the applied state on other devices.
                    notifyReferenceUnavailable('item', 'library_unavailable');
                    return;
                }
                if (resolved.status === 'found') {
                    await Zotero.DB.executeTransaction(async () => {
                        await resolved.item.eraseTx();
                    });
                }
                undoAgentAction(action.id);
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to delete item';
            setAgentActionsToError([action.id], errorMessage, {
                stack_trace: error?.stack || '',
                error_name: error?.name,
            });
        } finally {
            setBusyState({ key: groupId, annotationId: action.id, isBusy: false });
        }
    }, [groupId, markExternalReferenceDeleted, rejectAgentAction, setBusyState, setAgentActionsToError, undoAgentAction]);

    /**
     * Reject all pending items
     */
    const handleRejectAll = useCallback(() => {
        const pendingActions = actions.filter(
            action => action.status === 'pending' || isRetryable(action)
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

    // Generate button text parts (bold label + regular detail)
    const getButtonTextParts = (): { label: string; detail: string } => {
        if (pendingCount > 0) {
            return { label: 'Import', detail: `${pendingCount} Item${pendingCount === 1 ? '' : 's'}` };
        }
        if (allErrors) {
            return { label: 'Error importing', detail: `${totalItems} Item${totalItems === 1 ? '' : 's'}` };
        }
        return { label: 'Imported', detail: `${appliedCount} Item${appliedCount === 1 ? '' : 's'}` };
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
            className="border-card rounded-card display-flex flex-col min-w-0"
        >
            {/* Header with button and action icons */}
            <div
                className={`
                    display-flex flex-row py-15 px-25
                    ${resultsVisible && hasItemsToShow ? 'border-bottom-quinary' : ''}
                `}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
            >
                <button
                    type="button"
                    className={`variant-ghost-secondary display-flex flex-row py-15 gap-2 ml-05 text-left ${canToggleResults ? 'cursor-pointer' : ''}`}
                    style={{ background: 'transparent', border: 0, padding: 0, fontSize: '1rem' }}
                    aria-expanded={resultsVisible}
                    aria-controls={`agent-actions-content-${groupId}`}
                    onClick={toggleResults}
                    disabled={isButtonDisabled && !canToggleResults}
                >
                    <div className="display-flex flex-row gap-2">
                        <div className="flex-1 display-flex mt-010">
                            <Icon icon={getIcon()} className="scale-105"/>
                        </div>
                        <div className="display-flex">
                            <span className="font-color-primary font-medium">{getButtonTextParts().label}</span>
                            <span className="ml-15">{getButtonTextParts().detail}</span>
                        </div>
                    </div>
                </button>
                <div className="flex-1" />

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
                <div className="display-flex flex-col" id={`agent-actions-content-${groupId}`}>
                    {actions.map((action, index) => (
                        <CreateItemListItem
                            key={action.id}
                            action={action}
                            reference={referenceFor(action)}
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
