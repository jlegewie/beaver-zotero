import React from "react";
import Button from "./ui/Button";
import { useAtomValue, useSetAtom } from "jotai";
import { isStreamingAtom } from "../agents/atoms";
import { isWSChatPendingAtom } from "../atoms/agentRunAtoms";
import { Action, ActionTargetType } from "../types/actions";
import { actionsForContextAtom, actionContextAtom, markActionUsedAtom, sendResolvedActionAtom } from "../atoms/actions";
import { isSupportedItem } from "../../src/utils/sync";
import { getDisplayNameFromItem } from "../utils/sourceUtils";
import { truncateText } from "../utils/stringUtils";
import { ActionContext, GroupIconInfo, getIconInfoForItem } from "../utils/actionVisibility";
import { CSSIcon, CSSItemTypeIcon } from "./icons/zotero";
import Icon from "./icons/Icon";
import { SettingsIcon, ZapIcon } from './icons/icons';
import { openPreferencesWindow } from "../../src/ui/openPreferencesWindow";
import IconButton from "./ui/IconButton";

const MAX_CONTEXT_ITEM_LENGTH = 50;
const MAX_VISIBLE_ITEMS = 2;

interface ActiveTarget {
    targetType: ActionTargetType;
    label: string | null;
    iconInfo?: GroupIconInfo;
}

/**
 * Priority chain for determining the single winning action target type.
 *
 * 1. Reader (non-library tab + supported PDF) → 'attachment'
 * 2. Note (non-library tab + note) → 'note'
 * 3. Manual items (currentMessageItemsAtom has supported items):
 *    - All attachments → 'attachment'
 *    - Has regular items → 'items'
 * 4. Selected items (items_selected context with supported items):
 *    - All attachments → 'attachment'
 *    - Has regular items → 'items'
 * 5. Collection (treeRowType === 'collection') → 'collection'
 * 6. Fallback → null (global only)
 */
function getActiveTarget(ctx: ActionContext): ActiveTarget | null {
    const { zotero, manualItems } = ctx;

    // 1. Reader
    if (zotero.type === 'reader') {
        const att = zotero.readerAttachment;
        if (att && isSupportedItem(att)) {
            return { targetType: 'attachment', label: getItemLabel(att), iconInfo: getIconInfoForItem(att) };
        }
    }

    // 2. Note
    if (zotero.type === 'note') {
        const noteItem = zotero.noteItem;
        const label = noteItem
            ? truncateText(noteItem.getNoteTitle(), MAX_CONTEXT_ITEM_LENGTH)
            : null;
        return { targetType: 'note', label, iconInfo: { type: 'css-icon', name: 'note' } };
    }

    // 3. Manual items
    const manualSupported = manualItems.filter(i => isSupportedItem(i));
    if (manualSupported.length > 0) {
        const allAttachments = manualSupported.every(i => i.isAttachment());
        const targetType: ActionTargetType = allAttachments ? 'attachment' : 'items';
        return { targetType, label: getManualItemsLabel(manualSupported), iconInfo: getIconInfoForItem(manualSupported[0]) };
    }

    // 4. Selected items
    if (zotero.type === 'items_selected') {
        const supported = zotero.selectedItems.filter(i => isSupportedItem(i));
        if (supported.length > 0) {
            const allAttachments = supported.every(i => i.isAttachment());
            const targetType: ActionTargetType = allAttachments ? 'attachment' : 'items';
            return { targetType, label: getSelectedItemsLabel(supported), iconInfo: getIconInfoForItem(supported[0]) };
        }
    }

    // 5. Collection
    if (zotero.libraryView.treeRowType === 'collection') {
        return {
            targetType: 'collection',
            label: zotero.libraryView.collectionName ?? null,
            iconInfo: { type: 'css-icon', name: 'collection' },
        };
    }

    // 6. No specific context
    return null;
}

/** Display name for any item type — regular items use author/year, others use parent or display title */
function getItemLabel(item: Zotero.Item): string {
    if (item.isRegularItem()) {
        return truncateText(getDisplayNameFromItem(item), MAX_CONTEXT_ITEM_LENGTH);
    }
    const parent = item.parentItem;
    if (parent) {
        return truncateText(getDisplayNameFromItem(parent), MAX_CONTEXT_ITEM_LENGTH);
    }
    return truncateText(item.getDisplayTitle(), MAX_CONTEXT_ITEM_LENGTH);
}

function formatItemNames(items: Zotero.Item[]): string {
    const names = items
        .slice(0, MAX_VISIBLE_ITEMS)
        .map(i => getItemLabel(i));
    const remaining = items.length - MAX_VISIBLE_ITEMS;
    if (remaining > 0) names.push(`+${remaining} more`);
    return names.join(', ');
}

function getManualItemsLabel(items: Zotero.Item[]): string {
    return formatItemNames(items);
}

function getSelectedItemsLabel(items: Zotero.Item[]): string {
    return formatItemNames(items);
}

interface ActionSuggestionsProps {
    /** When true, global actions are always shown. When false, global actions only appear if no context-specific actions match. */
    showGlobal?: boolean;
    style?: React.CSSProperties;
}


const ActionSuggestions: React.FC<ActionSuggestionsProps> = ({ showGlobal = true, style }) => {
    const isStreaming = useAtomValue(isStreamingAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const allActions = useAtomValue(actionsForContextAtom);
    const sendResolvedAction = useSetAtom(sendResolvedActionAtom);
    const markActionUsed = useSetAtom(markActionUsedAtom);
    const ctx = useAtomValue(actionContextAtom);

    // Determine the single winning target type — never mix types
    const active = getActiveTarget(ctx);
    const targetActions = active
        ? allActions.filter(a => a.targetType === active.targetType)
        : [];
    const globalActions = allActions.filter(a => a.targetType === 'global');

    let actions: Action[];
    if (targetActions.length > 0) {
        actions = showGlobal ? [...targetActions, ...globalActions] : targetActions;
    } else {
        actions = globalActions;
    }

    const handleAction = async (action: Action) => {
        if (isPending || isStreaming || action.text.length === 0) return;
        markActionUsed(action.id);
        await sendResolvedAction({ text: action.text, targetType: action.targetType });
    };

    if (actions.length === 0) return null;

    // Only show context label when context-specific actions are displayed
    const contextLabel = targetActions.length > 0 ? active?.label ?? null : null;


    const contextLabelElement = contextLabel ? (
        <div
            className="font-color-tertiary font-medium display-flex items-center gap-1 min-w-0"
            style={{ fontSize: '0.925rem' }}
        >
            {active?.iconInfo && (
                <span className="scale-80 flex-shrink-0 opacity-70" style={{ filter: 'grayscale(1)' }}>
                    {active.iconInfo.type === 'item-type'
                        ? <CSSItemTypeIcon itemType={active.iconInfo.name} className="icon-16" />
                        : <CSSIcon name={active.iconInfo.name} className="icon-16" />}
                </span>
            )}
            {/* <span className="font-semibold truncate">{truncateText(contextLabel, 40)}</span> */}
            <span className="font-semibold truncate">{contextLabel}</span>
        </div>
    ) : null;

    return (
        <div className="display-flex flex-col gap-05 mt-3 " style={style}>
            <div className="display-flex flex-row gap-1 items-center mb-1 font-color-tertiary" style={style}>
                <Icon icon={ZapIcon} />
                {/* <div className="text-base font-medium"> */}
                {/* <div className="font-color-tertiary text-sm font-semibold uppercase" style={{ letterSpacing: '0.05em' }}>
                    Suggestions
                </div> */}
                <div className="display-flex flex-row gap-1 items-center min-w-0">
                    <div className="font-color-tertiary font-semibold flex-shrink-0" style={{ whiteSpace: 'nowrap', fontSize: '0.925rem' }}>
                        Actions {contextLabel ? `for` : ''}
                    </div>
                    {contextLabelElement}
                </div>
                
                <div className="flex-1" />
                {/* <Button variant="ghost-tertiary" onClick={() => openPreferencesWindow('prompts')}>
                    <span className="text-sm font-medium">
                        Edit
                    </span>
                </Button> */}
                <IconButton
                    variant="ghost-tertiary"
                    onClick={() => openPreferencesWindow('prompts')}
                    icon={SettingsIcon}
                />
                
            </div>
            {actions.map((action) => (
                <Button
                    key={action.id}
                    variant="ghost"
                    onClick={() => handleAction(action)}
                    disabled={isPending || isStreaming}
                    className="w-full justify-between"
                    style={{ padding: '6px 6px' }}
                >
                    <span className="text-base truncate">
                        {action.title}
                    </span>
                </Button>
            ))}
        </div>
    );
};

export default ActionSuggestions;
