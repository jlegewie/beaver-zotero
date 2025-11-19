import React, { useState, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { ToolCall } from '../../types/chat/apiTypes';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Icon,
    DeleteIcon,
    TickIcon,
    DownloadIcon,
    CSSItemTypeIcon,
    GlobalSearchIcon,
    ArrowUpIcon,
} from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import {
    applyAddItem,
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
import { AddItemProposedAction, isAddItemAction, AddItemResultData } from '../../types/proposedActions/items';
import { AckLink } from '../../../src/services/proposedActionsService';
import {
    annotationBusyAtom,
    annotationPanelStateAtom,
    defaultAnnotationPanelState,
    setAnnotationBusyStateAtom,
    setAnnotationPanelStateAtom,
    toggleAnnotationPanelVisibilityAtom
} from '../../atoms/messageUIState';

interface AddItemListItemProps {
    action: AddItemProposedAction;
    isBusy: boolean;
    onClick: (action: AddItemProposedAction) => Promise<void>;
    onDelete: (action: AddItemProposedAction) => Promise<void>;
    onReAdd: (action: AddItemProposedAction) => Promise<void>;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    className?: string;
}

const formatAuthors = (authors?: string[]): string => {
    if (!authors || authors.length === 0) return '';

    const clean = authors.filter(Boolean).map(a => a.trim());

    if (clean.length === 0) return '';

    if (clean.length > 3) {
        return `${clean[0]} et al.`;
    }

    if (clean.length === 1) {
        return clean[0];
    }

    if (clean.length === 2) {
        return `${clean[0]} and ${clean[1]}`;
    }

    // exactly 3
    return `${clean[0]}, ${clean[1]} and ${clean[2]}`;
}


const AddItemListItem: React.FC<AddItemListItemProps> = ({
    action,
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
        onClick(action);
    }, [action, isBusy, onClick]);

    const handleAction = useCallback(
        (event: React.SyntheticEvent) => {
            event.stopPropagation();
            if (isBusy) return;
            if (action.status === 'rejected' || action.status === 'pending' || action.status === 'undone') {
                onReAdd(action);
            } else {
                onDelete(action);
            }
        },
        [action, isBusy, onDelete, onReAdd]
    );

    const hasApplicationError = action.status !== 'error';
    const itemData = action.proposed_data.item;

    // Icon color
    let iconColor = action.status === 'rejected' || action.status === 'pending' || action.status === 'undone'
        ? 'font-color-tertiary'
        : 'font-color-secondary';
    iconColor = action.status === 'error' ? 'font-color-secondary' : iconColor;

    const baseClasses = [
        'px-3',
        'py-15',
        'display-flex',
        'flex-col',
        'gap-1',
        'cursor-pointer',
        'rounded-sm',
        'transition',
        'user-select-none',
    ];

    const getTextClasses = () => {
        if (action.status === 'rejected' || action.status === 'undone') return 'font-color-tertiary line-through';
        if (action.status === 'pending') return 'font-color-secondary';
        return 'font-color-secondary';
    }

    if (isHovered) {
        baseClasses.push('bg-quinary');
    }
    if (action.status === 'rejected' || action.status === 'undone' || action.status === 'error') {
        baseClasses.push('opacity-60');
    }
    
    const authors = formatAuthors(itemData.authors);
    const metaParts = [itemData.publication_title || itemData.venue, itemData.year].filter(Boolean);
    const meta = metaParts.join(', ');

    const getItemIcon = () => {
        if (isBusy) return Spinner;
        if (action.status === 'applied') return TickIcon;
        if (action.status === 'rejected' || action.status === 'pending' || action.status === 'undone') return DownloadIcon;
        return AlertIcon;
    }

    return (
        <div
            className={`${baseClasses.join(' ')} ${className}`}
            onClick={handleClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="display-flex flex-row items-start gap-3">
                <IconButton
                    icon={getItemIcon()}
                    variant="ghost-secondary"
                    className={`
                        flex-shrink-0
                        ${action.status === 'error' ? 'scale-100' : 'scale-12'}
                        ${action.status === 'applied' ? '' : 'mt-020'}
                    `}
                    title={action.status === 'applied' ? 'Delete item' : 'Import item'}
                    onClick={handleAction}
                    loading={isBusy}
                />
                <div className={`display-flex flex-col flex-1 gap-1 min-w-0 ${getTextClasses()}`}>
                    <div className="font-weight-medium">{itemData.title || 'Untitled Item'}</div>
                    {itemData.authors && authors && 
                        <div className="display-flex flex-row items-center gap-1">
                            {/* {itemData.authors.length > 1
                                ? <Icon icon={AuthorGroupIcon} size={18} className="font-color-tertiary" />
                                : <Icon icon={AuthorIcon} size={16} className="font-color-tertiary" />} */}
                            <div className="font-color-tertiary truncate">{authors}</div>
                        </div>
                    }
                    {meta && <div className="font-color-tertiary">{meta}</div>}
                </div>
                {/* {(action.status === 'applied') && (
                    <div className={`display-flex flex-row items-center gap-2 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                        <IconButton
                            variant="ghost-secondary"
                            onClick={handleAction}
                            className="p-1"
                            title='Delete item'
                            icon={DeleteIcon}
                            loading={isBusy}
                        />
                    </div>
                )} */}
                {/* <div className={`display-flex flex-row items-center gap-2 ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                    {(action.status === 'rejected' || action.status === 'pending' || action.status === 'undone') && (
                        <IconButton
                            variant="ghost-secondary"
                            onClick={handleAction}
                            className="p-1 scale-12"
                            title='Import item'
                            icon={DownloadIcon}
                            loading={isBusy}
                        />
                    )}
                    {action.status === 'applied' && (
                        <IconButton
                            variant="ghost-secondary"
                            onClick={handleAction}
                            className="p-1 scale-12"
                            title='Import item'
                            icon={TickIcon}
                            loading={isBusy}
                        />
                    )}
                </div> */}
            </div>
        </div>
    );
};

interface AddItemToolDisplayProps {
    messageId: string;
    groupId: string;
    toolCalls: ToolCall[];
}

const AddItemToolDisplay: React.FC<AddItemToolDisplayProps> = ({ messageId, groupId, toolCalls }) => {

    // UI state
    const panelStates = useAtomValue(annotationPanelStateAtom);
    const panelState = panelStates[groupId] ?? defaultAnnotationPanelState;
    const { resultsVisible, isApplying } = panelState;
    const busyStateMap = useAtomValue(annotationBusyAtom);
    const busyState = busyStateMap[groupId] ?? {};

    // Track hover states
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const [isExpandHovered, setIsExpandHovered] = useState(false);
    const [hoveredActionId, setHoveredActionId] = useState<string | null>(null);

    // Tool calls state
    const isInProgress = toolCalls.some((toolCall) => toolCall.status === 'in_progress');
    const isCompleted = toolCalls.every((toolCall) => toolCall.status === 'completed');
    const isError = toolCalls.some((toolCall) => toolCall.status === 'error');
    
    const loadingDots = useLoadingDots(isInProgress);
    
    // Atoms
    const ackProposedActions = useSetAtom(ackProposedActionsAtom);
    const rejectProposedAction = useSetAtom(rejectProposedActionStateAtom);
    const setProposedActionsToError = useSetAtom(setProposedActionsToErrorAtom);
    const undoProposedAction = useSetAtom(undoProposedActionAtom);

    // Extract actions
    const getProposedActionsByToolcall = useAtomValue(getProposedActionsByToolcallAtom);
    const actions = toolCalls.map((toolCall) => getProposedActionsByToolcall(toolCall.id, isAddItemAction)).flat() as AddItemProposedAction[];
    const totalActions = actions.length;

    // Derived states
    const somePending = actions.some((action) => action.status === 'pending');
    const someErrors = actions.some((action) => action.status === 'error');
    const appliedCount = actions.filter((action) => action.status === 'applied').length;
    const allErrors = actions.every((action) => action.status === 'error');

    const togglePanelVisibility = useSetAtom(toggleAnnotationPanelVisibilityAtom);
    const setPanelState = useSetAtom(setAnnotationPanelStateAtom);
    const setBusy = useSetAtom(setAnnotationBusyStateAtom);

    const toggleResults = useCallback(() => {
        if (isCompleted && totalActions > 0) {
            togglePanelVisibility(groupId);
        }
    }, [groupId, isCompleted, totalActions, togglePanelVisibility]);

    const handleApplyActions = useCallback(async (actionId?: string) => {
        if (actions.length === 0) return;
        setPanelState({ key: groupId, updates: { isApplying: true } });

        try {
            const actionsToApply = actions.filter(action => {
                if (action.status === 'applied') return false;
                if (actionId && action.id !== actionId) return false;
                return true;
            });

            if (actionsToApply.length === 0) {
                setPanelState({ key: groupId, updates: { isApplying: false } });
                return;
            }

            // Mark items as busy
            actionsToApply.forEach(action => {
                setBusy({ key: groupId, annotationId: action.id, isBusy: true });
            });

            const applyResults: (AckLink | null)[] = await Promise.all(
                actionsToApply.map(async (action) => {
                    try {
                        const result: AddItemResultData = await applyAddItem(action);
                        logger(`handleApplyActions: applied item ${action.id}: ${JSON.stringify(result)}`, 1);
                        return {
                            action_id: action.id,
                            result_data: result,
                        } as AckLink;
                    } catch (error: any) {
                        const errorMessage = error?.message || 'Failed to add item';
                        logger(`handleApplyActions: failed to add item ${action.id}: ${errorMessage}`, 1);
                        setProposedActionsToError([action.id], errorMessage);
                        return null;
                    } finally {
                        setBusy({ key: groupId, annotationId: action.id, isBusy: false });
                    }
                })
            );

            const actionsToAck = applyResults.filter(result => result !== null) as AckLink[];
            if (actionsToAck.length > 0) {
                await ackProposedActions(messageId, actionsToAck);
            }

            setPanelState({ key: groupId, updates: { resultsVisible: true, isApplying: false } });

            // Select applied items in Zotero
            if (actionsToAck.length > 0) {
                const itemIds: number[] = [];
                for (const ack of actionsToAck) {
                     const result = ack.result_data as AddItemResultData;
                     if (result.zotero_key) {
                         const item = await Zotero.Items.getByLibraryAndKeyAsync(result.library_id, result.zotero_key);
                         if (item) itemIds.push(item.id);
                     }
                }

                if (itemIds.length > 0) {
                    const ZoteroPane = Zotero.getMainWindow()?.ZoteroPane;
                    if (ZoteroPane) {
                        if (itemIds.length === 1) {
                             ZoteroPane.selectItem(itemIds[0]);
                        } else {
                             ZoteroPane.selectItems(itemIds);
                        }
                    }
                }
            }

        } catch (error) {
            logger(`handleApplyActions: unexpected error: ${error}`, 1);
            setPanelState({ key: groupId, updates: { isApplying: false } });
        }
    }, [actions, groupId, messageId, setPanelState, ackProposedActions, setProposedActionsToError]);

    const handleActionClick = useCallback(async (action: AddItemProposedAction) => {
        if (action.status === 'applied' && action.result_data?.zotero_key) {
             const item = await Zotero.Items.getByLibraryAndKeyAsync(
                 action.result_data.library_id, 
                 action.result_data.zotero_key
             );
             if (item) {
                 const ZoteroPane = Zotero.getMainWindow()?.ZoteroPane;
                 if (ZoteroPane) {
                     ZoteroPane.selectItem(item.id);
                 }
             }
        } else if (action.status === 'rejected' || action.status === 'pending' || action.status === 'undone') {
            await handleApplyActions(action.id);
        }
    }, [handleApplyActions]);

    const handleDelete = useCallback(async (action: AddItemProposedAction) => {
        setBusy({ key: groupId, annotationId: action.id, isBusy: true });
        try {
            if (action.status !== 'applied' || !action.result_data?.zotero_key) {
                rejectProposedAction(action.id);
            } else {
                await deleteAddedItem(action);
                undoProposedAction(action.id);
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to delete item';
            setProposedActionsToError([action.id], errorMessage);
        } finally {
            setBusy({ key: groupId, annotationId: action.id, isBusy: false });
        }
    }, [groupId, rejectProposedAction, setBusy, setProposedActionsToError, undoProposedAction]);

    const handleReAdd = useCallback(async (action: AddItemProposedAction) => {
        await handleActionClick(action);
    }, [handleActionClick]);


    const getIcon = () => {
        if (isInProgress || isApplying) return Spinner;
        if (isError || allErrors) return AlertIcon;
        if (totalActions === 0) return AlertIcon;

        if (isButtonHovered && !resultsVisible) return ArrowRightIcon;
        if (isButtonHovered && resultsVisible) return ArrowDownIcon;
        return GlobalSearchIcon;
    };

    const getButtonText = () => {
        if (isInProgress) {
            return `Paper Finder${''.padEnd(loadingDots, '.')}`;
        }
        if (isError) {
            return 'Paper Finder: Error';
        }
        return 'Paper Finder';
    };

    const hasActionsToShow = totalActions > 0;
    const canToggleResults = isCompleted && hasActionsToShow && !allErrors;
    const isButtonDisabled = isInProgress || isError || (isCompleted && !hasActionsToShow);
    const showApplyButton = isCompleted && (somePending || someErrors) && !isApplying;

    return (
        <div
            id={`tool-${toolCalls[0].id}`}
            className="border-popup rounded-md display-flex flex-col min-w-0"
        >
             <div
                className={`display-flex flex-row bg-senary py-15 px-2 ${hasActionsToShow && isCompleted ? 'border-bottom-quinary' : ''}`}
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
                        {getButtonText()}
                        {isCompleted && appliedCount > 0 && hasActionsToShow &&
                            <span className="ml-05 mt-015 font-color-green text-xs">+{appliedCount}</span>
                        }
                        {isCompleted && appliedCount === 0 && hasActionsToShow &&
                            <span className="ml-05 mt-015 font-color-tertiary text-xs">{totalActions}x</span>
                        }
                    </Button>
                    <div className="flex-1"/>
                </div>
                {showApplyButton ? (
                    <Button
                        rightIcon={DownloadIcon}
                        iconClassName="-mr-015"
                        variant="ghost-tertiary"
                        onClick={() => handleApplyActions()}
                    >
                        Import All
                    </Button>
                ) : (
                    <div className="text-sm truncate font-color-tertiary mt-015" style={{ maxWidth: '125px' }}>
                    </div>
                )}
            </div>
             {hasActionsToShow && isCompleted && (
                <div className="display-flex flex-col">
                    {(resultsVisible ? actions : actions.slice(0, 3)).map((action, index) => (
                        <AddItemListItem
                            key={action.id}
                            action={action}
                            isBusy={Boolean(busyState[action.id])}
                            onClick={handleActionClick}
                            onDelete={handleDelete}
                            onReAdd={handleReAdd}
                            isHovered={hoveredActionId === action.id}
                            onMouseEnter={() => setHoveredActionId(action.id)}
                            onMouseLeave={() => setHoveredActionId(null)}
                            className={index === 0 ? 'pt-2' : ''}
                        />
                    ))}
                    {actions.length > 3 && (
                        <div 
                            className={`display-flex flex-row justify-center items-center cursor-pointer -mt-1 ${isExpandHovered ? 'bg-senary' : ''}`}
                            onClick={toggleResults}
                            onMouseEnter={() => setIsExpandHovered(true)}
                            onMouseLeave={() => setIsExpandHovered(false)}
                        >
                            <Icon
                                icon={resultsVisible ? ArrowUpIcon : ArrowDownIcon}
                                className={`scale-75 ${isExpandHovered ? 'font-color-primary' : 'font-color-secondary'}`}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default AddItemToolDisplay;

