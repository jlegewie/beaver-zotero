import React from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { ToolCallPart } from '../../agents/types';
import { sendWSMessageAtom, isWSChatPendingAtom } from '../../atoms/agentRunAtoms';
import { CancelIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';

interface Suggestion {
    text: string;
    query: string;
    goal: 'understand' | 'expand' | 'organize' | 'capture';
}

interface SuggestionsViewProps {
    part: ToolCallPart;
    onDismiss?: () => void;
}

/**
 * Parses suggestions from a return_suggestions tool call.
 * The suggestions are in the tool call args (structured output).
 *
 * PydanticAI wraps non-object output types (like list[Suggestion]) in
 * {"response": [...]} so the tool args schema is always an object.
 */
function parseSuggestions(part: ToolCallPart): Suggestion[] {
    try {
        const args = typeof part.args === 'string' ? JSON.parse(part.args) : part.args;
        // PydanticAI wraps list types under a "response" key
        const items = Array.isArray(args)
            ? args
            : (args as Record<string, unknown>)?.response;
        if (!Array.isArray(items)) return [];
        return items.filter(
            (s): s is Suggestion =>
                s && typeof s.text === 'string' && typeof s.query === 'string'
        );
    } catch {
        return [];
    }
}

/**
 * Renders follow-up suggestions as clickable buttons.
 * Displayed instead of the normal tool call UI for return_suggestions.
 */
export const SuggestionsView: React.FC<SuggestionsViewProps> = ({ part, onDismiss }) => {
    const sendWSMessage = useSetAtom(sendWSMessageAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);

    const suggestions = parseSuggestions(part);

    if (suggestions.length === 0) {
        return null;
    }

    const handleClick = (suggestion: Suggestion) => {
        if (isPending) return;
        sendWSMessage(suggestion.query);
    };

    return (
        <div className="display-flex flex-col gap-2 pt-3">
            <div className="display-flex flex-row items-center justify-between gap-2">
                <div className="font-color-tertiary text-xs font-semibold uppercase" style={{ letterSpacing: '0.05em' }}>
                    Suggestions
                </div>
                {onDismiss && (
                    <IconButton
                        icon={CancelIcon}
                        onClick={onDismiss}
                        ariaLabel="Dismiss suggestions"
                        variant="ghost-secondary"
                        className="scale-08"
                    />
                )}
            </div>
            <div className="display-flex flex-col gap-1">
                {suggestions.map((suggestion, index) => (
                    <button
                        key={index}
                        type="button"
                        className="suggestion-button"
                        onClick={() => handleClick(suggestion)}
                        disabled={isPending}
                    >
                        {suggestion.text}
                    </button>
                ))}
            </div>
        </div>
    );
};

export default SuggestionsView;
