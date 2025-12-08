import React, { useState } from 'react';
import { useAtomValue } from 'jotai';
import { ToolCallPart } from '../../agents/types';
import { toolResultsMapAtom, getToolCallStatus, getToolCallLabel } from '../../agents/atoms';
import { ToolResultView } from './ToolResultView';
import Button from '../ui/Button';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    SearchIcon,
    ViewIcon,
    Icon,
    PuzzleIcon,
} from '../icons/icons';

interface ToolCallPartViewProps {
    part: ToolCallPart;
}

/**
 * Renders a tool call with its status and result.
 * Uses toolResultsMapAtom to look up the result for this tool call.
 */
export const ToolCallPartView: React.FC<ToolCallPartViewProps> = ({ part }) => {
    const resultsMap = useAtomValue(toolResultsMapAtom);
    const result = resultsMap.get(part.tool_call_id);
    const status = getToolCallStatus(part.tool_call_id, resultsMap);
    const label = getToolCallLabel(part);

    const [isExpanded, setIsExpanded] = useState(false);
    const [isHovered, setIsHovered] = useState(false);

    const isInProgress = status === 'in_progress';
    const hasError = status === 'error';
    const hasResult = result !== undefined;

    const toggleExpanded = () => {
        if (hasResult) {
            setIsExpanded(!isExpanded);
        }
    };

    const getIcon = () => {
        if (isInProgress) return Spinner;
        if (hasError) return AlertIcon;
        if (isExpanded) return ArrowDownIcon;
        if (isHovered && hasResult) return ArrowRightIcon;
        
        // Tool-specific icons
        const toolName = part.tool_name.toLowerCase();
        if (toolName.includes('search')) return SearchIcon;
        if (toolName.includes('read') || toolName.includes('view')) return ViewIcon;
        
        return PuzzleIcon;
    };

    const getButtonText = () => {
        if (hasError) {
            return `${label}: Error`;
        }
        if (isInProgress) {
            return label;
        }
        return label;
    };

    const isButtonDisabled = isInProgress || (hasError && !hasResult);

    return (
        <div
            id={`tool-${part.tool_call_id}`}
            className={`
                rounded-md flex flex-col min-w-0
                ${isExpanded ? 'border-popup' : 'border-transparent'}
            `}
        >
            <div
                className={`
                    display-flex flex-row py-15
                    ${isExpanded ? 'border-bottom-quinary bg-senary' : ''}
                `}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <Button
                    variant="ghost-secondary"
                    onClick={toggleExpanded}
                    className={`
                        text-base scale-105 w-full min-w-0 align-start text-left
                        ${isButtonDisabled && !hasResult ? 'disabled-but-styled' : ''}
                    `}
                    style={{ padding: '2px 6px', maxHeight: 'none' }}
                    disabled={isButtonDisabled && !hasResult}
                >
                    <div className="display-flex flex-row px-3 gap-2">
                        <div className={`flex-1 display-flex mt-010 ${isExpanded ? 'font-color-primary' : ''}`}>
                            <Icon icon={getIcon()} />
                        </div>
                        
                        <div className={`display-flex ${isExpanded ? 'font-color-primary' : ''} ${isInProgress ? 'shimmer-text' : ''}`}>
                            {getButtonText()}
                        </div>
                    </div>
                </Button>
            </div>

            {/* Error display */}
            {hasError && result && typeof result.content === 'string' && (
                <div className="px-4 py-1 text-sm text-red-600">
                    {result.content}
                </div>
            )}

            {/* Expanded result view */}
            {isExpanded && hasResult && (
                <ToolResultView result={result} />
            )}
        </div>
    );
};

export default ToolCallPartView;

