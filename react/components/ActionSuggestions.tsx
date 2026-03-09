import React from "react";
import Button from "./ui/Button";
import { useAtomValue, useSetAtom } from "jotai";
import { isStreamingAtom } from "../agents/atoms";
import { isWSChatPendingAtom } from "../atoms/agentRunAtoms";
import { Action } from "../types/actions";
import { actionsForContextAtom, markActionUsedAtom, sendResolvedActionAtom } from "../atoms/actions";
import { zoteroContextAtom, ZoteroContext } from "../atoms/zoteroContext";
import { getDisplayNameFromItem } from "../utils/sourceUtils";
import { truncateText } from "../utils/stringUtils";

const MAX_CONTEXT_ITEM_LENGTH = 50;
const MAX_VISIBLE_ITEMS = 2;

function getContextLabel(context: ZoteroContext): string | null {
    switch (context.type) {
        case 'items_selected': {
            const names = context.selectedItems
                .slice(0, MAX_VISIBLE_ITEMS)
                .map(i => truncateText(getDisplayNameFromItem(i), MAX_CONTEXT_ITEM_LENGTH));
            const remaining = context.selectedItemCount - MAX_VISIBLE_ITEMS;
            if (remaining > 0) names.push(`+${remaining} more`);
            return names.join(', ');
        }
        case 'reader': {
            const att = context.readerAttachment;
            if (!att) return null;
            const parent = att.parentItem;
            return parent
                ? truncateText(getDisplayNameFromItem(parent), MAX_CONTEXT_ITEM_LENGTH)
                : truncateText(att.getDisplayTitle(), MAX_CONTEXT_ITEM_LENGTH);
        }
        case 'collection':
            return `Collection "${context.libraryView.collectionName}"`;
        case 'note': {
            if (!context.noteItem) return null;
            return `Note "${truncateText(context.noteItem.getNoteTitle(), MAX_CONTEXT_ITEM_LENGTH)}"`;
        }
        default:
            return null;
    }
}

interface ActionSuggestionsProps {
    /** When true, global actions are always shown. When false, global actions only appear if no context-specific actions match. */
    showGlobal?: boolean;
    className?: string;
    style?: React.CSSProperties;
}

const ActionSuggestions: React.FC<ActionSuggestionsProps> = ({ showGlobal = true, className, style }) => {
    const isStreaming = useAtomValue(isStreamingAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const allActions = useAtomValue(actionsForContextAtom);
    const sendResolvedAction = useSetAtom(sendResolvedActionAtom);
    const markActionUsed = useSetAtom(markActionUsedAtom);
    const context = useAtomValue(zoteroContextAtom);

    const contextActions = allActions.filter(a => a.targetType !== "global");
    const actions = showGlobal
        ? allActions
        : contextActions.length > 0 ? contextActions : allActions;

    const handleAction = async (action: Action) => {
        if (isPending || isStreaming || action.text.length === 0) return;
        markActionUsed(action.id);
        await sendResolvedAction(action.text);
    };

    if (actions.length === 0) return null;

    // Only show context label when context-specific actions are displayed
    const contextLabel = contextActions.length > 0 ? getContextLabel(context) : null;

    return (
        <div className={className} style={style}>
            {actions.map((action) => (
                <Button
                    key={action.id}
                    variant="ghost"
                    onClick={() => handleAction(action)}
                    disabled={isPending || isStreaming}
                    className="w-full justify-between"
                    style={{ padding: '6px 8px' }}
                    // title={action.title}
                >
                    <span className="text-lg truncate">
                        {action.title}
                    </span>
                </Button>
            ))}
            {contextLabel && (
                <div className="text-sm font-color-tertiary" style={{ padding: '4px 8px 0' }}>
                    For {contextLabel}
                </div>
            )}
        </div>
    );
};

export default ActionSuggestions;
