import React from "react";
import Button from "./ui/Button";
import { useAtomValue, useSetAtom } from "jotai";
import { isStreamingAtom } from "../agents/atoms";
import { isWSChatPendingAtom } from "../atoms/agentRunAtoms";
import { Action } from "../types/actions";
import { actionsForContextAtom, markActionUsedAtom, sendResolvedActionAtom } from "../atoms/actions";

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
        </div>
    );
};

export default ActionSuggestions;
